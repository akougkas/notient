import { RecordId, type Surreal } from "surrealdb";
import { NoteApiError } from "../../api/schema";
import { NOTE_CONNECTION_TABLES, isWritebackEdgeTable } from "../db/edgeTables";
import { isCanonicalOrdinaryNotePath } from "../vault/publicPath";

export type NoteNeighborTable = (typeof NOTE_CONNECTION_TABLES)[number];

export interface NoteNeighbor {
  readonly notePath: string;
  readonly table: NoteNeighborTable;
  readonly direction: "outgoing" | "incoming";
  readonly agent: string;
  readonly confidence: number;
  readonly proposed: boolean;
}

export interface ReadNoteNeighborsOptions {
  readonly includePending?: boolean;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

interface StoredNeighborRow {
  fromPath: unknown;
  toPath: unknown;
  source: unknown;
  agent: unknown;
  confidence: unknown;
}

/** Read the canonical note-to-note graph visible to reasoning and operator views. */
export async function readNoteNeighbors(
  db: Surreal,
  notePath: string,
  options: ReadNoteNeighborsOptions = {},
): Promise<NoteNeighbor[]> {
  const page = await readNoteNeighborPage(db, notePath, options);
  if (page.truncated)
    throw new NoteApiError(
      "LIMIT_EXCEEDED",
      "Too many connections; use graph.neighbors for a bounded result.",
    );
  return page.neighbors.map(({ id: _id, provenance: _provenance, ...neighbor }) => neighbor);
}

export interface StoredNoteNeighbor extends NoteNeighbor {
  readonly id: string;
  readonly provenance: string | null;
}

/** One bounded storage reader for clients and traversal. Pending effects never enter paths. */
export async function readNoteNeighborPage(
  db: Surreal,
  notePath: string,
  options: ReadNoteNeighborsOptions = {},
): Promise<{ neighbors: StoredNoteNeighbor[]; truncated: boolean }> {
  if (!isCanonicalOrdinaryNotePath(notePath)) {
    throw new NoteApiError(
      "INVALID_PARAMS",
      "neighbor note path must be an exact ordinary public vault-relative Markdown path",
    );
  }
  const limit = options.limit ?? 200;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new NoteApiError("INVALID_PARAMS", "connection limit must be between 1 and 200");
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
    : AbortSignal.timeout(15000);
  checkSignal(signal);
  await requireLiveSourceNote(db, notePath);
  const neighbors: StoredNoteNeighbor[] = [];
  for (const table of NOTE_CONNECTION_TABLES) {
    checkSignal(signal);
    neighbors.push(...(await readTable(db, table, notePath, false, limit + 1)));
    if (options.includePending === true && isWritebackEdgeTable(table)) {
      checkSignal(signal);
      neighbors.push(...(await readTable(db, table, notePath, true, limit + 1)));
    }
    if (neighbors.length > limit) break;
  }
  checkSignal(signal);
  return { neighbors: neighbors.slice(0, limit), truncated: neighbors.length > limit };
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new NoteApiError("CANCELLED", "graph read cancelled or timed out");
}

async function requireLiveSourceNote(db: Surreal, notePath: string): Promise<void> {
  const raw: unknown = await db
    .query(
      "SELECT id, path FROM note WHERE path = $path AND tombstoned_at IS NONE LIMIT 2 TIMEOUT 2s;",
      {
        path: notePath,
      },
    )
    .collect();
  if (!Array.isArray(raw) || raw.length !== 1 || !Array.isArray(raw[0])) {
    throw new Error("neighbor storage integrity: source note lookup returned an invalid envelope");
  }
  const row = raw[0][0];
  if (
    raw[0].length !== 1 ||
    !isRecord(row) ||
    Object.keys(row).length !== 2 ||
    row.path !== notePath ||
    !isCanonicalOrdinaryNotePath(row.path) ||
    !(row.id instanceof RecordId) ||
    row.id.table.name !== "note"
  ) {
    throw new Error("neighbor storage integrity: source note is missing or malformed");
  }
}

async function readTable(
  db: Surreal,
  table: NoteNeighborTable,
  notePath: string,
  proposed: boolean,
  limit: number,
): Promise<StoredNoteNeighbor[]> {
  const state = proposed ? "approved = false" : "approved = true AND applied = true";
  const result: unknown = await db
    .query(
      `SELECT id, provenance, (in.path ?? in.note.path) AS fromPath, (out.path ?? out.note.path) AS toPath, source, agent, confidence FROM ${table} WHERE ${state} AND (in.tombstoned_at ?? in.note.tombstoned_at) IS NONE AND (out.tombstoned_at ?? out.note.tombstoned_at) IS NONE AND (in.path ?? in.note.path) != (out.path ?? out.note.path) AND ((in.path ?? in.note.path) = $path OR (out.path ?? out.note.path) = $path) ORDER BY id LIMIT $limit TIMEOUT 2s;`,
      { path: notePath, limit },
    )
    .collect();
  const rows = readSingleStatementRows(result, table);
  return rows.map((row) => decodeNeighbor(row, table, notePath, proposed));
}

function decodeNeighbor(
  raw: unknown,
  table: NoteNeighborTable,
  notePath: string,
  proposed: boolean,
): StoredNoteNeighbor {
  if (!isRecord(raw)) {
    throw new Error(`neighbor storage integrity: ${table} row is not an object`);
  }
  if (
    !(raw.id instanceof RecordId) ||
    raw.id.table.name !== table ||
    (raw.provenance !== undefined &&
      (typeof raw.provenance !== "string" || raw.provenance.length > 65536))
  )
    throw new Error(`neighbor storage integrity: ${table} identity or provenance is invalid`);
  const row = raw as unknown as StoredNeighborRow;
  if (!isCanonicalOrdinaryNotePath(row.fromPath) || !isCanonicalOrdinaryNotePath(row.toPath)) {
    throw new Error(`neighbor storage integrity: ${table} endpoint path is private or invalid`);
  }
  const fromPath = row.fromPath;
  const toPath = row.toPath;
  const source = parseNonBlankString(row.source, `${table} provenance source`);
  const agent = parseOptionalAgent(row.agent, source, table);
  const confidence = parseConfidence(row.confidence, table);
  const outgoing = fromPath === notePath;
  const incoming = toPath === notePath;
  if (outgoing === incoming) {
    throw new Error(`neighbor storage integrity: ${table} row is not incident to one other note`);
  }
  return {
    id: raw.id.toString(),
    provenance: typeof raw.provenance === "string" ? raw.provenance : null,
    notePath: outgoing ? toPath : fromPath,
    table,
    direction: outgoing ? "outgoing" : "incoming",
    agent,
    confidence,
    proposed,
  };
}

function readSingleStatementRows(raw: unknown, table: NoteNeighborTable): unknown[] {
  if (!Array.isArray(raw) || raw.length !== 1 || !Array.isArray(raw[0])) {
    throw new Error(`neighbor storage integrity: ${table} returned an invalid statement envelope`);
  }
  return raw[0];
}

function parseOptionalAgent(raw: unknown, source: string, table: NoteNeighborTable): string {
  if (raw === undefined) return source;
  if (raw === null) {
    throw new Error(`neighbor storage integrity: ${table} agent uses null instead of NONE`);
  }
  return parseNonBlankString(raw, `${table} agent`);
}

function parseConfidence(raw: unknown, table: NoteNeighborTable): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    throw new Error(`neighbor storage integrity: ${table} confidence is invalid`);
  }
  return raw;
}

function parseNonBlankString(raw: unknown, label: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`${label} must be a non-blank string`);
  }
  return raw;
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}
