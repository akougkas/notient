/**
 * History kind union. Each kind names a class of mutation that Notient
 * records into the `history` table and that can be undone via the
 * registered inverter.
 *
 * Two naming families coexist deliberately:
 *   - `notes.*` — recorded by the chat write tools in
 *     `src/core/chat/tools/notes.ts`. These existed before Task 15 and
 *     keep their original strings to avoid producer churn.
 *   - `edge.*`, `node.*`, `note.*` — recorded by graph and agent
 *     producers. The dotted singular form distinguishes the graph-side
 *     mutations from the chat tool ones above.
 */
export type HistoryKind =
  | "chat.auto_approve"
  | "edge.approve"
  | "edge.reject"
  | "node.approve"
  | "node.reject"
  | "note.append_section"
  | "note.frontmatter"
  | "note.maturity"
  | "notes.create"
  | "notes.append"
  | "notes.replace_section"
  | "notes.update_frontmatter";

export interface HistoryRow {
  /**
   * SurrealDB record-id string (e.g. `history:abc123`). Phase 4 Task 4
   * migrated the storage backend from SQLite (numeric AUTOINCREMENT) to
   * SurrealDB (`RecordId<"history">`); the public id type is the
   * `RecordId.toString()` form so consumers stay backend-agnostic.
   */
  id: string;
  kind: HistoryKind;
  target: string;
  before: unknown | null;
  after: unknown | null;
  createdAt: number;
  /**
   * Per-invocation client identity that produced the row (Phase D1 LD-5).
   * Defaults to `human` when the originating RPC frame omits the field.
   */
  clientIdentity: string;
}

export interface RecordHistoryInput {
  kind: HistoryKind;
  target: string;
  before: unknown | null;
  after: unknown | null;
  /**
   * Per-invocation client identity recorded with the row (Phase D1 LD-5).
   * Optional at the call site; HistoryService falls back to `human`.
   */
  clientIdentity?: string;
}

export type Inverter = (target: string, before: unknown, after: unknown) => Promise<void>;

export type InverterRegistry = Partial<Record<HistoryKind, Inverter>>;

export interface HistoryRetention {
  max: number;
  maxPerTarget: number;
}

export interface UndoResult {
  ok: boolean;
  error?: string;
}
