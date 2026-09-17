import { EDGE_TABLES } from "./edgeTables";

const ENTITY_TABLES = ["note", "block", "chunk", "tag", "concept", "claim", "question"] as const;

const DURABLE_OPERATION_TABLES = [
  "approval_intent",
  "daemon_write",
  "history",
  "awaken_run",
  "agent_event",
  "agent_run",
] as const;

/**
 * Explicit allowlist for a graph backup. New schema tables do not silently
 * become portable data.
 *
 * Deliberate exclusions:
 * - `meta`: daemon-owned deployment and embedding identity.
 * - `conversation_memory`: derived from canonical Markdown transcripts.
 * - `agent_session`: live authorization grants must never revive.
 * - `note_write_intent`: in-flight filesystem byte transitions are vault-local
 *   recovery state and must never move across snapshot generations.
 * - unresolved wikilink/embed staging: derived and rebuilt by Tier 1.
 */
export const BACKUP_TABLES: readonly string[] = [
  ...ENTITY_TABLES,
  ...EDGE_TABLES,
  ...DURABLE_OPERATION_TABLES,
];

export const BACKUP_TABLE_SET: ReadonlySet<string> = new Set(BACKUP_TABLES);

/** Every non-bootstrap table that must be empty at restore commit. */
export const RESTORE_EMPTY_TABLES: readonly string[] = [
  ...BACKUP_TABLES,
  "agent_session",
  "note_write_intent",
  "wikilink_unresolved",
  "embed_unresolved",
];

/**
 * Dependency-safe deletion order for abandoning an imported generation.
 * This is intentionally explicit: a failed restore must remove only the
 * tables whose preflight proved empty, while preserving daemon-owned meta and
 * derived conversation memory.
 */
export const RESTORE_ROLLBACK_TABLES: readonly string[] = [
  "note_write_intent",
  "approval_intent",
  "wikilink_unresolved",
  "embed_unresolved",
  ...EDGE_TABLES,
  "chunk",
  "block",
  "note",
  "tag",
  "concept",
  "claim",
  "question",
  "daemon_write",
  "history",
  "awaken_run",
  "agent_event",
  "agent_run",
  "agent_session",
];
