/**
 * SurrealDB-backed approval-and-write service.
 *
 * Failure-semantics contract: PENDING-STATE. The contract is named in the
 * top-level comment of `src/core/markdown/writeback.ts`; this service is
 * its sole producer.
 *
 * `approveEdge` flips an unapproved edge row through three stable states:
 *   1. `approved = false, applied = true`   (initial linker proposal)
 *   2. `approved = true,  applied = false`  (writeback in flight)
 *   3. `approved = true,  applied = true`   (writeback committed)
 *
 * Crashes between states are recovered by `reconcilePendingApplications`,
 * which selects rows in state 2 and replays the writeback from step 2 of
 * the flow described in `writeback.ts`. The writeback is idempotent
 * (Locked Decision 2); duplicate `daemon_write` inserts are guarded by
 * `findRecentDaemonWrite`; the closing `applied = true` flip is the
 * end-of-flow commit signal that consumers (Phase 4 Task 11) filter on.
 *
 * `rejectEdge` is total: deleting an already-deleted edge is not an error.
 * Rejected edges leave no `history` row; Phase 4 simplifies the staging
 * story by treating "rejected" as "never happened".
 *
 * Phase 4 Task 4 will migrate `historyService` and the rest of the undo
 * surface; this service writes `history` rows directly via
 * `CREATE history` so the row format is consistent with that migration.
 */

import type { RecordId, Surreal } from "surrealdb";
import { findRecentDaemonWrite, recordDaemonWrite } from "../db/surreal";
import type { EventBus } from "../events/eventBus";
import { applyApprovedLink, applyApprovedRelation } from "../markdown/writeback";
import { type AtomicFs, atomicWrite } from "../utils/atomicWrite";

/**
 * The six edge tables whose rows are emitted by the linker as proposals
 * (`approved = false`). Approving any of these triggers a body writeback.
 * `related_to` writes the `## Related` section; the other five write a
 * frontmatter `notient.<key>` array entry.
 */
export type WritebackEdgeTable =
  | "supports"
  | "contradicts"
  | "extends"
  | "exemplifies"
  | "synthesizes"
  | "related_to";

export const WRITEBACK_EDGE_TABLES: ReadonlyArray<WritebackEdgeTable> = [
  "supports",
  "contradicts",
  "extends",
  "exemplifies",
  "synthesizes",
  "related_to",
];

/**
 * Hooks fired at named milestones inside `approveEdge`. Production code
 * never wires these; tests inject a hook that throws to simulate a crash
 * between two side-effects so the recovery path can be exercised.
 *
 * `afterApprovedFlip`     state 1 -> state 2 transition committed.
 * `afterDaemonWriteInsert` `daemon_write` row committed.
 * `afterFileWrite`        atomic file write returned.
 * `afterHistoryCommit`    closing transaction committed (state 2 -> state 3).
 */
export interface ApprovalServiceHooks {
  afterApprovedFlip?: () => void | Promise<void>;
  afterDaemonWriteInsert?: () => void | Promise<void>;
  afterFileWrite?: () => void | Promise<void>;
  afterHistoryCommit?: () => void | Promise<void>;
}

export interface ApprovalServiceOptions {
  db: Surreal;
  bus: EventBus;
  vaultRoot: string;
  /**
   * Filesystem implementation used for the atomic write. Tests inject a
   * fake; production wires a real fs adapter.
   */
  fs: AtomicFs;
  /**
   * Reads a note's current body from disk. Tests inject a fake; production
   * wires `Bun.file(path).text()` or the equivalent.
   */
  readFile: (path: string) => Promise<string>;
  /**
   * Computes a SHA hash of the post-write body. Optional. When omitted
   * the service uses an internal default that hashes the UTF-8 bytes of
   * the post-write body via `crypto.subtle.digest("SHA-256", ...)`. The
   * default agrees with `daemon/watcher.ts#sha256Body` and Tier 1's
   * `extractor.ts` body-SHA contract; production wiring relies on that
   * agreement so `findRecentDaemonWrite` matches on re-index.
   */
  hash?: (content: string) => Promise<string>;
  internalHooks?: ApprovalServiceHooks;
}

async function defaultHash(content: string): Promise<string> {
  const buffer = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export interface ListedEdge {
  id: RecordId;
  table: WritebackEdgeTable;
  source: RecordId<"note">;
  target: RecordId<"note">;
  agent: string | null;
  confidence: number;
}

export interface ApproveEdgeInput {
  id: RecordId;
  table: WritebackEdgeTable;
}

export interface ReconcileResult {
  replayed: number;
  failed: number;
}

interface EdgeRow {
  id: RecordId;
  in: RecordId<"note">;
  out: RecordId<"note">;
  source: string;
  agent: string | null;
  confidence: number;
}

interface NoteRow {
  id: RecordId<"note">;
  path: string;
}

const FRONTMATTER_RELATIONS: ReadonlyArray<WritebackEdgeTable> = [
  "supports",
  "contradicts",
  "extends",
  "exemplifies",
  "synthesizes",
];

function isFrontmatterRelation(table: WritebackEdgeTable): boolean {
  return FRONTMATTER_RELATIONS.includes(table);
}

function basenameWithoutExtension(path: string): string {
  const last = path.split("/").pop() ?? path;
  return last.replace(/\.md$/i, "");
}

function joinPath(root: string, relative: string): string {
  if (root.length === 0) return relative;
  if (root.endsWith("/")) return `${root}${relative}`;
  return `${root}/${relative}`;
}

export class ApprovalService {
  constructor(private readonly options: ApprovalServiceOptions) {}

  /**
   * Lists every edge in a writeback-capable table whose `approved` flag is
   * still `false`. Result is sorted newest first by `created_at` so the
   * /links inbox UI shows the latest proposals first.
   */
  async listPendingEdges(): Promise<ListedEdge[]> {
    const edges: ListedEdge[] = [];
    for (const table of WRITEBACK_EDGE_TABLES) {
      // SurrealDB 3.0.5 requires every ORDER BY field to appear in the
      // projection. `created_at` is selected and discarded.
      const sql = `SELECT id, in, out, source, agent, confidence, created_at FROM ${table} WHERE approved = false ORDER BY created_at DESC;`;
      const [rows] = await this.options.db.query<[Array<EdgeRow>]>(sql).collect<[Array<EdgeRow>]>();
      for (const row of rows) {
        edges.push({
          id: row.id,
          table,
          source: row.in,
          target: row.out,
          agent: row.agent,
          confidence: row.confidence,
        });
      }
    }
    return edges;
  }

  /**
   * Promotes a linker proposal through the pending-state contract. Steps:
   *
   *   A. Stamp `approved = true, applied = false` (state 1 -> state 2).
   *   B. Resolve source/target paths.
   *   C. Read body, run writeback in memory.
   *   D. Idempotent no-op fast path: if writeback returned the input
   *      unchanged, flip `applied = true` and return.
   *   E. Insert `daemon_write` (skipped when an identical row landed within
   *      the lookup window).
   *   F. Atomic file write.
   *   G. Closing transaction: `CREATE history` and flip `applied = true`.
   */
  async approveEdge(input: ApproveEdgeInput): Promise<void> {
    const edge = await this.selectEdge(input);
    if (edge === null) return;
    if (!isWritebackTable(input.table)) {
      throw new Error(`approveEdge: table '${input.table}' is not writeback-capable`);
    }

    // Step A.
    await this.options.db
      .query("UPDATE $id SET approved = true, applied = false;", { id: input.id })
      .collect();
    await this.runHook(this.options.internalHooks?.afterApprovedFlip);

    await this.runWriteback(input, edge);

    this.options.bus.emit({
      type: "approval:decided",
      kind: "edge",
      id: input.id.toString(),
      decision: "accepted",
    });
  }

  /**
   * Total reject: deletes the row regardless of its current state. No
   * `history` row is recorded; the linker can re-propose the same edge on
   * the next pass if the underlying signal still holds.
   */
  async rejectEdge(input: ApproveEdgeInput): Promise<void> {
    if (!isWritebackTable(input.table)) {
      throw new Error(`rejectEdge: table '${input.table}' is not writeback-capable`);
    }
    await this.options.db.query("DELETE $id;", { id: input.id }).collect();
    this.options.bus.emit({
      type: "approval:decided",
      kind: "edge",
      id: input.id.toString(),
      decision: "rejected",
    });
  }

  /**
   * Daemon-bootstrap entry point. Selects every row in state 2
   * (`approved = true AND applied = false`) across the six writeback
   * tables and replays the writeback from step C. Returns counters; the
   * daemon supervisor logs the summary.
   */
  async reconcilePendingApplications(): Promise<ReconcileResult> {
    let replayed = 0;
    let failed = 0;
    for (const table of WRITEBACK_EDGE_TABLES) {
      const sql = `SELECT id, in, out, source, agent, confidence FROM ${table} WHERE approved = true AND applied = false;`;
      const [rows] = await this.options.db.query<[Array<EdgeRow>]>(sql).collect<[Array<EdgeRow>]>();
      for (const row of rows) {
        try {
          await this.runWriteback({ id: row.id, table }, row);
          replayed += 1;
        } catch {
          // Reconciliation is best-effort; a row that fails this pass will
          // be picked up on the next daemon start. The supervisor's audit
          // log is the authoritative record of failures.
          failed += 1;
        }
      }
    }
    return { replayed, failed };
  }

  private async runWriteback(input: ApproveEdgeInput, edge: EdgeRow): Promise<void> {
    // Step B.
    const sourceNote = await this.selectNote(edge.in);
    const targetNote = await this.selectNote(edge.out);
    if (sourceNote === null || targetNote === null) {
      throw new Error(
        `approveEdge: source or target note record missing for edge ${input.id.toString()}`,
      );
    }
    const sourcePath = joinPath(this.options.vaultRoot, sourceNote.path);
    const wikilinkTarget = basenameWithoutExtension(targetNote.path);

    // Step C.
    const beforeBody = await this.options.readFile(sourcePath);
    const afterBody = isFrontmatterRelation(input.table)
      ? applyApprovedRelation(beforeBody, { key: input.table, target: wikilinkTarget })
      : applyApprovedLink(beforeBody, { target: wikilinkTarget });

    // Step D.
    if (afterBody === beforeBody) {
      await this.options.db.query("UPDATE $id SET applied = true;", { id: input.id }).collect();
      await this.runHook(this.options.internalHooks?.afterHistoryCommit);
      return;
    }

    // Step E.
    const hash = this.options.hash ?? defaultHash;
    const newSha = await hash(afterBody);
    const agentName = edge.agent ?? edge.source;
    const existing = await findRecentDaemonWrite(this.options.db, {
      noteId: sourceNote.id,
      sha: newSha,
    });
    if (existing === null) {
      await recordDaemonWrite(this.options.db, {
        noteId: sourceNote.id,
        sha: newSha,
        agent: agentName,
        targets: [targetNote.id],
      });
    }
    await this.runHook(this.options.internalHooks?.afterDaemonWriteInsert);

    // Step F.
    await atomicWrite(this.options.fs, sourcePath, afterBody);
    await this.runHook(this.options.internalHooks?.afterFileWrite);

    // Step G.
    const kind = isFrontmatterRelation(input.table) ? "note.frontmatter" : "note.append_section";
    await this.options.db
      .query(
        `BEGIN;
         CREATE history CONTENT { kind: $kind, target: $target, before: $before, after: $after, client_identity: $clientIdentity };
         UPDATE $id SET applied = true;
         COMMIT;`,
        {
          kind,
          target: sourcePath,
          before: JSON.stringify(beforeBody),
          after: JSON.stringify(afterBody),
          clientIdentity: agentName,
          id: input.id,
        },
      )
      .collect();
    await this.runHook(this.options.internalHooks?.afterHistoryCommit);
  }

  private async selectEdge(input: ApproveEdgeInput): Promise<EdgeRow | null> {
    const sql = `SELECT id, in, out, source, agent, confidence FROM ${input.table} WHERE id = $id LIMIT 1;`;
    const [rows] = await this.options.db
      .query<[Array<EdgeRow>]>(sql, { id: input.id })
      .collect<[Array<EdgeRow>]>();
    return rows[0] ?? null;
  }

  private async selectNote(noteId: RecordId<"note">): Promise<NoteRow | null> {
    const [rows] = await this.options.db
      .query<[Array<NoteRow>]>("SELECT id, path FROM note WHERE id = $id LIMIT 1;", { id: noteId })
      .collect<[Array<NoteRow>]>();
    return rows[0] ?? null;
  }

  private async runHook(hook: (() => void | Promise<void>) | undefined): Promise<void> {
    if (hook === undefined) return;
    await hook();
  }
}

function isWritebackTable(value: string): value is WritebackEdgeTable {
  return (WRITEBACK_EDGE_TABLES as ReadonlyArray<string>).includes(value);
}
