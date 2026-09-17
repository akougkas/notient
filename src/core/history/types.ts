/** Mutation kinds currently written to the history table. */
export const HISTORY_KINDS = [
  "chat.auto_approve",
  "note.append_section",
  "note.frontmatter",
  "notes.move",
  "notes.create",
  "notes.append",
  "notes.replace_section",
  "notes.update_frontmatter",
  "proposal.reject",
] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

export interface HistoryRow {
  /** Native SurrealDB UUID record-id string: `history:u"<uuid>"`. */
  id: string;
  kind: HistoryKind;
  target: string;
  before: unknown | null;
  after: unknown | null;
  createdAt: number;
  /** Client identity that produced the row. */
  clientIdentity: string;
  /** Accepted proposal edge bound to this receipt, or null for ordinary writes. */
  proposalEdge: string | null;
  /** Canonical SurrealDB datetime of that exact proposal revision, or null. */
  proposalCreatedAt: string | null;
  /** The original mutation remains in the audit trail after a guarded undo. */
  undo: { startedAt: number; completedAt: number | null; clientIdentity: string } | null;
}

export interface RecordHistoryInput {
  kind: HistoryKind;
  target: string;
  before: unknown | null;
  after: unknown | null;
  /** Defaults to `human` when the originating call has no identity. */
  clientIdentity?: string;
}

export interface InverterContext {
  /** Rechecked after any native editor guard, immediately before filesystem effects. */
  authorize: () => Promise<void>;
}
export type Inverter = (row: HistoryRow, context?: InverterContext) => Promise<void>;

export type InverterRegistry = Partial<Record<HistoryKind, Inverter>>;

export interface HistoryRetention {
  max: number;
  maxPerTarget: number;
}

export type UndoFailureCode =
  | "HISTORY_EMPTY"
  | "HISTORY_NOT_FOUND"
  | "HISTORY_NOT_REVERSIBLE"
  | "HISTORY_INVALID_PAYLOAD"
  | "HISTORY_CONFLICT";

export type UndoResult =
  | { ok: true; reversed: HistoryRow }
  | { ok: false; code: UndoFailureCode; message: string };
