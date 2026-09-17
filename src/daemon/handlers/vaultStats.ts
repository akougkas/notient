/**
 * `vault.stats` — the vault's state of mind in one read.
 *
 * The Home view of the TUI renders exactly what this returns and nothing
 * else, so every number here has to come from a real row count rather than
 * from a client-side guess. Table list mirrors `notient graph stats`
 * (`src/cli/commands/graphStats.ts`); the awaken row shape mirrors
 * `src/core/awaken/awakenRun.ts`.
 *
 * Counting uses one semicolon-joined multi-statement query and one round trip.
 * Each linker table uses `GROUP BY approved, applied`; only rows in both
 * terminal states count as approved, while every proposal or in-flight
 * writeback counts as pending.
 *
 * SurrealDB returns an empty result slice for an empty table, which reads
 * as 0.
 */

import type { Surreal } from "surrealdb";
import { nativeDateTimeToEpochMillis } from "../../core/db/dateTime";
import { WRITEBACK_EDGE_TABLES } from "../../core/db/edgeTables";
import { isExactRecord } from "../../core/db/queryResult";
import { stringifyUuidRecordId } from "../../core/db/recordId";
import type { MethodHandler } from "../rpc";
import type { AwakenRunSummary, TypedEdgeCount, VaultStatsResult } from "../wire";

export interface VaultStatsDeps {
  db: Surreal;
  /** Tool calls parked at the approval gate; injected so the DB stays pure. */
  pendingApprovals: () => number;
}

/** Entity counts, in the order their result slices come back. */
const ENTITY_COUNTS = [
  { field: "notes", table: "note", where: "tombstoned_at = NONE" },
  { field: "blocks", table: "block" },
  { field: "chunks", table: "chunk" },
  { field: "concepts", table: "concept" },
  { field: "claims", table: "claim" },
  { field: "questions", table: "question" },
  { field: "wikilinks", table: "wikilink" },
] as const satisfies ReadonlyArray<{ field: string; table: string; where?: string }>;

const AWAKEN_FIELDS = "id, status, processed, total, failed, started_at, finished_at, error";
const ACTIVE_AWAKEN_SQL = `SELECT ${AWAKEN_FIELDS} FROM awaken_run WHERE status IN ['running', 'paused'] ORDER BY started_at DESC LIMIT 1;`;
const NEWEST_AWAKEN_SQL = `SELECT ${AWAKEN_FIELDS} FROM awaken_run ORDER BY started_at DESC LIMIT 1;`;

/**
 * The whole snapshot as one multi-statement query. Exported so the exact
 * statement list is assertable without a database.
 */
export function buildVaultStatsQuery(): string {
  const statements: string[] = ENTITY_COUNTS.map((entry) => {
    const where = "where" in entry ? ` WHERE ${entry.where}` : "";
    return `SELECT count() AS count FROM ${entry.table}${where} GROUP ALL;`;
  });
  for (const table of WRITEBACK_EDGE_TABLES) {
    statements.push(
      `SELECT approved, applied, count() AS count FROM ${table} GROUP BY approved, applied;`,
    );
  }
  // An active run can be older than an arbitrary recent-row window. Read it
  // directly, then read one terminal fallback, while keeping one DB round trip.
  statements.push(ACTIVE_AWAKEN_SQL, NEWEST_AWAKEN_SQL);
  return statements.join("\n");
}

export class VaultStatsIntegrityError extends Error {
  constructor(message: string) {
    super(`vault stats storage integrity: ${message}`);
    this.name = "VaultStatsIntegrityError";
  }
}

function readNonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new VaultStatsIntegrityError(`${label} is not a nonnegative integer`);
  }
  return value;
}

function readCount(slice: unknown, label: string): number {
  if (!Array.isArray(slice)) {
    throw new VaultStatsIntegrityError(`${label} count result is not an array`);
  }
  if (slice.length === 0) return 0;
  if (slice.length !== 1 || !isExactRecord(slice[0], ["count"])) {
    throw new VaultStatsIntegrityError(`${label} count result is not exactly one row`);
  }
  return readNonnegativeInteger(slice[0].count, `${label} count`);
}

/**
 * Fold one table's grouped rows into the wire shape. Approved-and-applied is
 * the only approved bucket; everything else, including an approved edge whose
 * writeback has not landed, is still pending from the operator's side.
 */
function tallyEdgeSlice(table: TypedEdgeCount["table"], slice: unknown): TypedEdgeCount {
  let approved = 0;
  let pending = 0;
  const groups = new Set<string>();
  if (!Array.isArray(slice)) {
    throw new VaultStatsIntegrityError(`${table} grouped count result is not an array`);
  }
  for (const value of slice) {
    if (
      !isExactRecord(value, ["approved", "applied", "count"]) ||
      typeof value.approved !== "boolean" ||
      typeof value.applied !== "boolean"
    ) {
      throw new VaultStatsIntegrityError(`${table} grouped count row is malformed`);
    }
    const group = `${value.approved}:${value.applied}`;
    if (groups.has(group)) {
      throw new VaultStatsIntegrityError(`${table} grouped count contains a duplicate bucket`);
    }
    groups.add(group);
    const count = readNonnegativeInteger(value.count, `${table} grouped count`);
    if (value.approved && value.applied) approved = safeSum(approved, count, table);
    else pending = safeSum(pending, count, table);
  }
  return { table, approved, pending };
}

function safeSum(left: number, right: number, label: string): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) {
    throw new VaultStatsIntegrityError(`${label} count exceeds the safe integer domain`);
  }
  return total;
}

/**
 * The awaken run the operator cares about: the active one (running or
 * paused) if there is one, else the most recently started row so a
 * completed run still reports its totals after the fact.
 */
export function summarizeAwakenRun(
  activeSlice: unknown,
  newestSlice: unknown,
): AwakenRunSummary | null {
  const active = readOptionalAwakenRow(activeSlice, "active awaken");
  const newest = readOptionalAwakenRow(newestSlice, "newest awaken");
  if (active !== undefined && active.status !== "running" && active.status !== "paused") {
    throw new VaultStatsIntegrityError("active awaken query returned a terminal run");
  }
  const row = active ?? newest;
  if (row === undefined) return null;
  const runId = stringifyUuidRecordId(row.id, "awaken_run", "awaken run id");
  const status = readAwakenStatus(row.status);
  const processed = readNonnegativeInteger(row.processed, "awaken processed");
  const total = readNonnegativeInteger(row.total, "awaken total");
  const failed = readNonnegativeInteger(row.failed, "awaken failed");
  if (processed + failed > total) {
    throw new VaultStatsIntegrityError("awaken counters exceed the run total");
  }
  const startedAt = nativeDateTimeToEpochMillis(row.started_at);
  if (startedAt === null) {
    throw new VaultStatsIntegrityError("awaken started_at is invalid");
  }
  const finishedAt = readOptionalDateTime(row.finished_at, "awaken finished_at");
  const isActive = status === "running" || status === "paused";
  if ((isActive && finishedAt !== null) || (!isActive && finishedAt === null)) {
    throw new VaultStatsIntegrityError("awaken status and finished_at disagree");
  }
  const error = readOptionalError(row.error);
  return {
    runId,
    status,
    processed,
    total,
    failed,
    startedAt,
    finishedAt,
    error,
  };
}

function readOptionalDateTime(value: unknown, label: string): number | null {
  if (value === undefined) return null;
  const epoch = nativeDateTimeToEpochMillis(value);
  if (epoch === null) {
    throw new VaultStatsIntegrityError(`${label} is not a native SurrealDB datetime or NONE`);
  }
  return epoch;
}

function readOptionalError(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new VaultStatsIntegrityError("awaken error is not a canonical nonblank string or NONE");
  }
  return value;
}

function readOptionalAwakenRow(slice: unknown, label: string): Record<string, unknown> | undefined {
  if (!Array.isArray(slice)) {
    throw new VaultStatsIntegrityError(`${label} result is not an array`);
  }
  if (slice.length === 0) return undefined;
  if (slice.length !== 1 || !isCanonicalAwakenRow(slice[0])) {
    throw new VaultStatsIntegrityError(`${label} result is not exactly one row`);
  }
  return slice[0];
}

function isCanonicalAwakenRow(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  const allowed = new Set(AWAKEN_FIELDS.split(", "));
  if (Object.keys(fields).some((key) => !allowed.has(key))) return false;
  return ["id", "status", "processed", "total", "failed", "started_at"].every((key) =>
    Object.hasOwn(fields, key),
  );
}

function readAwakenStatus(value: unknown): AwakenRunSummary["status"] {
  if (
    value === "running" ||
    value === "paused" ||
    value === "cancelled" ||
    value === "completed" ||
    value === "failed"
  ) {
    return value;
  }
  throw new VaultStatsIntegrityError("awaken status is invalid");
}

export async function collectVaultStats(deps: VaultStatsDeps): Promise<VaultStatsResult> {
  const slices: unknown = await deps.db.query(buildVaultStatsQuery()).collect();
  const edgeOffset = ENTITY_COUNTS.length;
  const awakenOffset = edgeOffset + WRITEBACK_EDGE_TABLES.length;
  const expectedSlices = awakenOffset + 2;
  if (!Array.isArray(slices) || slices.length !== expectedSlices) {
    throw new VaultStatsIntegrityError(`expected ${expectedSlices} query result slices`);
  }
  const typedEdges = WRITEBACK_EDGE_TABLES.map((table, index) =>
    tallyEdgeSlice(table, slices[edgeOffset + index]),
  );
  const pendingApprovals = readNonnegativeInteger(deps.pendingApprovals(), "pending approvals");
  return {
    ok: true,
    notes: readCount(slices[0], "note"),
    blocks: readCount(slices[1], "block"),
    chunks: readCount(slices[2], "chunk"),
    concepts: readCount(slices[3], "concept"),
    claims: readCount(slices[4], "claim"),
    questions: readCount(slices[5], "question"),
    wikilinks: readCount(slices[6], "wikilink"),
    typedEdges,
    typedEdgesApproved: typedEdges.reduce(
      (sum, entry) => safeSum(sum, entry.approved, "approved typed edge"),
      0,
    ),
    typedEdgesPending: typedEdges.reduce(
      (sum, entry) => safeSum(sum, entry.pending, "pending typed edge"),
      0,
    ),
    pendingApprovals,
    awaken: summarizeAwakenRun(slices[awakenOffset], slices[awakenOffset + 1]),
  };
}

export function makeVaultStatsHandler(deps: VaultStatsDeps): MethodHandler {
  return async (_request) => {
    return (await collectVaultStats(deps)) as unknown as Record<string, unknown>;
  };
}
