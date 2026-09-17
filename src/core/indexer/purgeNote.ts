import { DateTime, RecordId } from "surrealdb";
import {
  type ApprovalService,
  DeletionGenerationMismatchError,
} from "../approvals/approvalService";
import type { SurrealConnection } from "../db/surreal";

export type ApprovalIntentCanceller = Pick<ApprovalService, "cancelForNoteDeletion">;

export interface NoteTombstone {
  noteId: RecordId<"note">;
  tombstonedAt: DateTime;
}

interface PurgeTransactionResult {
  blocked: boolean;
  stale: boolean;
}

/** Persist one deletion generation and return the exact token that won. */
export async function tombstoneNoteByPath(
  db: SurrealConnection,
  path: string,
): Promise<NoteTombstone | null> {
  const raw: unknown = await db.db
    .query(
      "UPDATE note SET tombstoned_at = time::now() WHERE path = $path AND tombstoned_at IS NONE RETURN AFTER;",
      { path },
    )
    .collect();
  const rows = singleStatementRows(raw, "tombstone by path");
  if (rows.length > 1) {
    throw new Error("purge storage integrity: tombstone path matched multiple notes");
  }
  if (rows.length === 0) return null;
  return parseNoteTombstone(rows[0], "tombstone by path");
}

/**
 * Full graph deletion for one tombstoned or newly excluded note.
 *
 * Approval cancellation runs first because it may need the source note's
 * exact before/after bytes. It accepts only the caller's exact tombstone
 * generation and prevents a new approval claim without creating or refreshing
 * a tombstone. The graph deletion repeats that generation guard and every
 * note-owned delete in one transaction, eliminating the old check-then-delete
 * race.
 */
export async function purgeNoteGraph(
  db: SurrealConnection,
  noteId: RecordId<"note">,
  tombstonedAt: DateTime,
  approvalIntents: ApprovalIntentCanceller,
): Promise<boolean> {
  if (!(noteId instanceof RecordId) || noteId.table.name !== "note") {
    throw new TypeError("purge requires a native note record id");
  }
  if (!(tombstonedAt instanceof DateTime)) {
    throw new TypeError("purge requires a native tombstone generation");
  }
  let cancellation: Awaited<ReturnType<ApprovalIntentCanceller["cancelForNoteDeletion"]>>;
  try {
    cancellation = await approvalIntents.cancelForNoteDeletion(noteId, tombstonedAt);
  } catch (error) {
    if (error instanceof DeletionGenerationMismatchError) return false;
    throw error;
  }
  if (cancellation.failed > 0) {
    throw new Error(
      `purge deferred: ${cancellation.failed} approval cancellation(s) for ${noteId.toString()} require recovery`,
    );
  }

  const transaction = `BEGIN;
LET $generationMatches = (SELECT VALUE id FROM ONLY $note WHERE tombstoned_at = $tombstonedAt) = $note;
LET $activeIntents = (SELECT VALUE id FROM approval_intent WHERE source_note = $note OR target_note = $note);
LET $blocked = array::len($activeIntents) > 0 OR !$generationMatches;
LET $blocks = (SELECT VALUE id FROM block WHERE note = $note);
LET $concepts = (SELECT VALUE out FROM mentions WHERE in = $note OR in IN $blocks);
LET $claims = (SELECT VALUE out FROM asserts WHERE in = $note OR in IN $blocks);
LET $questions = (SELECT VALUE out FROM asks WHERE in = $note OR in IN $blocks);
DELETE wikilink, embed, frontmatter_ref, tagged, contained_in, under_heading WHERE !$blocked AND (in = $note OR out = $note OR in IN $blocks OR out IN $blocks);
DELETE wikilink_unresolved, embed_unresolved WHERE !$blocked AND (in = $note OR in IN $blocks);
DELETE mentions, asserts, asks WHERE !$blocked AND (in = $note OR in IN $blocks);
DELETE supports, contradicts, extends, exemplifies, synthesizes, related_to WHERE !$blocked AND (in = $note OR out = $note);
DELETE daemon_write WHERE !$blocked AND (note = $note OR $note IN targets);
DELETE chunk WHERE !$blocked AND note = $note;
DELETE block WHERE !$blocked AND note = $note;
DELETE concept WHERE !$blocked AND id IN $concepts AND array::len(<-mentions) = 0 RETURN NONE;
DELETE claim WHERE !$blocked AND id IN $claims AND array::len(<-asserts) = 0 RETURN NONE;
DELETE question WHERE !$blocked AND id IN $questions AND array::len(<-asks) = 0 RETURN NONE;
DELETE $note WHERE !$blocked RETURN NONE;
COMMIT;
RETURN { blocked: $blocked, stale: !$generationMatches };`;
  const raw: unknown = await db.db.query(transaction, { note: noteId, tombstonedAt }).collect();
  const result = parsePurgeTransactionResult(raw);
  if (result.blocked) {
    if (result.stale) return false;
    throw new Error(
      `purge deferred: note ${noteId.toString()} still has an active approval cancellation`,
    );
  }
  return true;
}

/**
 * Retroactive cleanup for notes that should never have been indexed.
 *
 * Every awaken and reindex run invokes this before queueing so a newly
 * excluded path is removed from existing graph state as well as future scans.
 */
export async function purgeExcludedNotes(
  db: SurrealConnection,
  isExcluded: (vaultPath: string) => boolean,
  approvalIntents: ApprovalIntentCanceller,
): Promise<string[]> {
  const [rows] = await db.db
    .query<[Array<{ id: RecordId<"note">; path: string }>]>("SELECT id, path FROM note;")
    .collect<[Array<{ id: RecordId<"note">; path: string }>]>();
  const purged: string[] = [];
  for (const row of rows) {
    if (typeof row.path !== "string" || !isExcluded(row.path)) continue;
    const tombstonedAt = await tombstoneNoteById(db, row.id);
    if (tombstonedAt === null) continue;
    if (await purgeNoteGraph(db, row.id, tombstonedAt, approvalIntents)) {
      purged.push(row.path);
    }
  }
  return purged;
}

export async function tombstoneNoteById(
  db: SurrealConnection,
  noteId: RecordId<"note">,
): Promise<DateTime | null> {
  const transaction = `BEGIN;
UPDATE $note SET tombstoned_at = time::now() WHERE tombstoned_at IS NONE RETURN NONE;
LET $generation = (SELECT VALUE tombstoned_at FROM ONLY $note);
COMMIT;
RETURN $generation;`;
  const raw: unknown = await db.db.query(transaction, { note: noteId }).collect();
  if (
    !Array.isArray(raw) ||
    raw.length !== 5 ||
    raw[0] !== undefined ||
    !Array.isArray(raw[1]) ||
    raw[1].length !== 0 ||
    raw[2] !== undefined ||
    raw[3] !== undefined
  ) {
    throw new Error("purge storage integrity: tombstone transaction returned an invalid envelope");
  }
  if (raw[4] === undefined) return null;
  if (!(raw[4] instanceof DateTime)) {
    throw new Error("purge storage integrity: tombstone transaction returned an invalid token");
  }
  return raw[4];
}

function parsePurgeTransactionResult(raw: unknown): PurgeTransactionResult {
  if (!Array.isArray(raw) || raw.length !== 21) {
    throw new Error("purge storage integrity: transaction returned an invalid envelope");
  }
  const value = raw[20];
  if (
    !isObject(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.blocked !== "boolean" ||
    typeof value.stale !== "boolean"
  ) {
    throw new Error("purge storage integrity: transaction returned a malformed result");
  }
  return { blocked: value.blocked, stale: value.stale };
}

function singleStatementRows(raw: unknown, operation: string): unknown[] {
  if (!Array.isArray(raw) || raw.length !== 1 || !Array.isArray(raw[0])) {
    throw new Error(`purge storage integrity: ${operation} returned an invalid envelope`);
  }
  return raw[0];
}

function parseNoteTombstone(value: unknown, operation: string): NoteTombstone {
  if (!isObject(value)) {
    throw new Error(`purge storage integrity: ${operation} returned a malformed row`);
  }
  const noteId = value.id;
  const tombstonedAt = value.tombstoned_at;
  if (
    !(noteId instanceof RecordId) ||
    noteId.table.name !== "note" ||
    !(tombstonedAt instanceof DateTime)
  ) {
    throw new Error(`purge storage integrity: ${operation} returned a malformed row`);
  }
  return { noteId: noteId as RecordId<"note">, tombstonedAt };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
