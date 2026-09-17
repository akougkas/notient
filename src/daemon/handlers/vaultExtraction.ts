/**
 * `vault.extraction` — Notient's own reading of one note.
 *
 * The Tier 3 extractor writes three relation tables out of a note: `mentions`
 * to `concept`, `asserts` to `claim`, `asks` to `question`. Each row carries
 * the provenance block (`confidence`, `evidence` as chunk records), so the
 * Explore view can show what was extracted *and* the sentence it came from
 * rather than an unattributed list.
 *
 * The `in` side of all three relations is `note|block`. Resolving the note
 * record id up front lets one query cover both: a row anchored on the note
 * itself matches `in = $note`, and a row anchored on one of its blocks
 * matches `in.note = $note`.
 */

import { RecordId, type Surreal } from "surrealdb";
import { type VaultAdapter, VaultPathError } from "../../adapters/vaultAdapter";
import { sha256Hex } from "../../core/utils/sha256";
import { isCanonicalOrdinaryNotePath } from "../../core/vault/publicPath";
import { type MethodHandler, RpcError } from "../rpc";
import type { ExtractionItemWire, ProposalEvidenceWire, VaultExtractionResult } from "../wire";

export interface VaultExtractionDeps {
  db: Surreal;
  vault: Pick<VaultAdapter, "exists" | "read">;
}

const EVIDENCE_PER_ITEM = 2;

export class VaultExtractionIntegrityError extends Error {
  constructor(message: string) {
    super(`vault extraction storage integrity: ${message}`);
    this.name = "VaultExtractionIntegrityError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireSingleSlice(raw: unknown, label: string): unknown[] {
  if (!Array.isArray(raw) || raw.length !== 1 || !Array.isArray(raw[0])) {
    throw new VaultExtractionIntegrityError(`${label} returned an invalid statement envelope`);
  }
  return raw[0];
}

interface ParsedExtractionRow {
  target: RecordId;
  text: string;
  kind: string | null;
  confidence: number;
  evidence: Array<RecordId<"chunk">>;
}

function parseExtractionRow(
  value: unknown,
  table: "mentions" | "asserts" | "asks",
  targetTable: "concept" | "claim" | "question",
): ParsedExtractionRow {
  if (!isRecord(value)) {
    throw new VaultExtractionIntegrityError(`${table} extraction row is not an object`);
  }
  const target = value.target;
  if (!(target instanceof RecordId) || target.table.name !== targetTable) {
    throw new VaultExtractionIntegrityError(`${table} extraction target is invalid`);
  }
  if (typeof value.text !== "string") {
    throw new VaultExtractionIntegrityError(`${table} extraction text is invalid`);
  }
  if (value.kind !== null && value.kind !== undefined && typeof value.kind !== "string") {
    throw new VaultExtractionIntegrityError(`${table} extraction kind is invalid`);
  }
  return {
    target,
    text: value.text,
    kind: typeof value.kind === "string" ? value.kind : null,
    confidence: parseConfidence(value.confidence, table),
    evidence: parseEvidence(value.evidence, table),
  };
}

function parseConfidence(value: unknown, table: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new VaultExtractionIntegrityError(`${table} extraction confidence is invalid`);
  }
  return value;
}

function parseEvidence(value: unknown, table: string): Array<RecordId<"chunk">> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new VaultExtractionIntegrityError(`${table} extraction evidence is invalid`);
  }
  for (const entry of value) {
    if (!(entry instanceof RecordId) || entry.table.name !== "chunk") {
      throw new VaultExtractionIntegrityError(`${table} extraction evidence is invalid`);
    }
  }
  return value as Array<RecordId<"chunk">>;
}

async function readNoteId(
  db: Surreal,
  notePath: string,
  expectedSha: string,
): Promise<RecordId<"note"> | null> {
  const slices: unknown = await db
    .query(
      "SELECT id, sha FROM note WHERE path = $path AND sha = $sha AND tombstoned_at IS NONE LIMIT 1;",
      { path: notePath, sha: expectedSha },
    )
    .collect();
  const rows = requireSingleSlice(slices, "note lookup");
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !isRecord(rows[0])) {
    throw new VaultExtractionIntegrityError("note lookup did not return exactly one row");
  }
  const id = rows[0].id;
  if (!(id instanceof RecordId) || id.table.name !== "note" || rows[0].sha !== expectedSha) {
    throw new VaultExtractionIntegrityError("note lookup returned an invalid current note row");
  }
  return id as RecordId<"note">;
}

async function fetchEvidence(
  db: Surreal,
  evidence: Array<RecordId<"chunk">>,
  noteId: RecordId<"note">,
): Promise<ProposalEvidenceWire[]> {
  const snippets: ProposalEvidenceWire[] = [];
  for (const id of evidence.slice(0, EVIDENCE_PER_ITEM)) {
    const slices: unknown = await db
      .query(
        "SELECT text, note.path AS notePath FROM chunk WHERE id = $id AND note = $note AND note.tombstoned_at IS NONE LIMIT 1;",
        { id, note: noteId },
      )
      .collect();
    const rows = requireSingleSlice(slices, `evidence lookup ${id.toString()}`);
    if (
      rows.length !== 1 ||
      !isRecord(rows[0]) ||
      typeof rows[0].text !== "string" ||
      !isCanonicalOrdinaryNotePath(rows[0].notePath)
    ) {
      throw new VaultExtractionIntegrityError(
        `evidence lookup ${id.toString()} did not return one text row`,
      );
    }
    snippets.push({ chunkId: id.toString(), text: rows[0].text });
  }
  return snippets;
}

/**
 * One relation table's rows for a note. `textField` names the projection on
 * the `out` record that carries the human-readable value: `label` for a
 * concept, `text` for a claim or a question.
 */
export async function readExtraction(
  db: Surreal,
  noteId: RecordId<"note">,
  table: "mentions" | "asserts" | "asks",
  textField: "label" | "text",
): Promise<ExtractionItemWire[]> {
  const sql = `SELECT out AS target, out.${textField} AS text, out.kind AS kind, confidence, evidence FROM ${table} WHERE (in = $note OR in.note = $note) AND (in.tombstoned_at ?? in.note.tombstoned_at) IS NONE;`;
  const slices: unknown = await db.query(sql, { note: noteId }).collect();
  const rows = requireSingleSlice(slices, `${table} extraction`);
  const targetTable = table === "mentions" ? "concept" : table === "asserts" ? "claim" : "question";
  const items: ExtractionItemWire[] = [];
  const seen = new Set<string>();
  for (const value of rows) {
    const row = parseExtractionRow(value, table, targetTable);
    const id = row.target.toString();
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      text: row.text,
      kind: row.kind,
      confidence: row.confidence,
      evidence: await fetchEvidence(db, row.evidence, noteId),
    });
  }
  return items.sort((left, right) => right.confidence - left.confidence);
}

export async function collectExtraction(
  deps: VaultExtractionDeps,
  notePath: string,
): Promise<VaultExtractionResult> {
  if (!isCanonicalOrdinaryNotePath(notePath)) {
    throw new Error("notePath must be an exact ordinary public vault-relative Markdown note path");
  }
  if (!(await deps.vault.exists(notePath))) {
    return { ok: true, notePath, concepts: [], claims: [], questions: [] };
  }
  const body = await deps.vault.read(notePath);
  const noteId = await readNoteId(deps.db, notePath, await sha256Hex(body));
  if (noteId === null) {
    return { ok: true, notePath, concepts: [], claims: [], questions: [] };
  }
  return {
    ok: true,
    notePath,
    concepts: await readExtraction(deps.db, noteId, "mentions", "label"),
    claims: await readExtraction(deps.db, noteId, "asserts", "text"),
    questions: await readExtraction(deps.db, noteId, "asks", "text"),
  };
}

export function makeVaultExtractionHandler(deps: VaultExtractionDeps): MethodHandler {
  return async ({ params }) => {
    const notePath = params.notePath;
    if (!isCanonicalOrdinaryNotePath(notePath)) {
      throw new RpcError(
        "INVALID_PARAMS",
        "notePath must be an exact ordinary public vault-relative Markdown note path",
      );
    }
    try {
      return (await collectExtraction(deps, notePath)) as unknown as Record<string, unknown>;
    } catch (error) {
      if (error instanceof VaultPathError) {
        throw new RpcError("INVALID_PARAMS", "notePath is not accessible");
      }
      throw error;
    }
  };
}
