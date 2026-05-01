/**
 * Awaken run DAL.
 *
 * Spec: docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md
 * §3.5 (operational tables) and the Phase 4 plan task 7. The `awaken_run`
 * table is an append-only run-history log gated by a tiny status state
 * machine: `running -> paused | cancelled | completed | failed`,
 * `paused -> running | cancelled | failed`. Terminal statuses
 * (`cancelled`, `completed`, `failed`) freeze the row by stamping
 * `finished_at`.
 *
 * Invariants enforced here:
 *   - Rows are append-only history. Helpers in this module only INSERT and
 *     UPDATE; nothing deletes from `awaken_run`.
 *   - Terminal `updateStatus` calls always stamp `finished_at` via
 *     `time::now()` so the server clock is the source of truth.
 *   - `subscribeToStatus` filters live-query notifications down to the
 *     specific `runId`; updates to other rows are ignored.
 *
 * Single-active-row invariant: at-most-one row sits in `status INSIDE
 * ['running','paused']` per vault. SurrealDB enforces it server-side via
 * the `awaken_run_active_unique` index defined over the computed
 * `active_marker` field; see `src/core/db/schema.surql`. The marker is
 * `'active'` while the status is in the active set and `NONE` otherwise,
 * which converts SurrealDB's standard unique constraint into a partial
 * unique index. `createRun` translates the resulting unique-violation
 * error into `AwakenRunAlreadyActiveError` so callers (the daemon's
 * `awaken.run` handler and the `runAwakenWorker` start guard) can map it
 * onto the wire-level `INVALID_PARAMS` reply that the CLI's `findCurrent`
 * guard already emits. The pre-existing `findCurrent` checks in callers
 * stay; the index is the backstop for racing RPCs that both observe
 * `findCurrent === null` before either inserts.
 *
 * Live-query implementation choice: `db.live(new Table("awaken_run"))`
 * resolves to a `LiveSubscription` whose `subscribe(handler)` callback
 * fires on every CREATE/UPDATE/DELETE for the table. We filter the
 * incoming `LiveMessage.recordId` against the caller's `runId` via
 * `RecordId.equals` and dispatch only matching status changes. The
 * subscription is killed via the returned `close()`.
 */

import { type RecordId, type Surreal, Table } from "surrealdb";

export type AwakenStatus = "running" | "paused" | "cancelled" | "completed" | "failed";

const TERMINAL_STATUSES: ReadonlySet<AwakenStatus> = new Set(["cancelled", "completed", "failed"]);

/**
 * Thrown by `createRun` when the `awaken_run_active_unique` index rejects
 * a fresh insert because another row in `status INSIDE ['running','paused']`
 * already exists. Two near-simultaneous `awaken.run` RPCs are the canonical
 * trigger: both observe `findCurrent === null` and both attempt to create
 * the row, so the index serializes them. Callers should map this onto the
 * existing `INVALID_PARAMS: a different run is already active` wire string
 * to keep the CLI's race-time error consistent with the foreground guard.
 */
export class AwakenRunAlreadyActiveError extends Error {
  constructor(message = "AwakenRunAlreadyActiveError: a different run is already active") {
    super(message);
    this.name = "AwakenRunAlreadyActiveError";
  }
}

/**
 * Index name configured in `src/core/db/schema.surql`. SurrealDB 3.x
 * surfaces unique-violation errors with the literal index name embedded
 * in the message, so the lookup is a stable hook for translating the
 * raw error into the typed exception.
 */
const ACTIVE_UNIQUE_INDEX_NAME = "awaken_run_active_unique";

function isActiveUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes(ACTIVE_UNIQUE_INDEX_NAME);
}

export interface AwakenRunRow {
  id: RecordId<"awaken_run">;
  status: AwakenStatus;
  started_at: Date;
  finished_at: Date | null;
  total: number;
  processed: number;
  failed: number;
  tier_filter: number[];
  priority_globs: string[];
  cursor: string | null;
  error: string | null;
  /**
   * Reason a terminal `failed` status was set. Populated by the daemon
   * shutdown path with `'daemon_shutdown'` when the awaken worker did
   * not settle within the grace window. Other failure paths (worker
   * exception, embedding model unreachable) leave this null and write
   * the human-readable error to `error`. Schema: option<string>.
   */
  failure_reason: string | null;
  /**
   * Vault-relative paths whose indexing did not complete during this run.
   * Schema-defaulted to an empty array, capped by the worker so the row
   * stays small.
   */
  failures: string[];
}

export interface CreateRunInput {
  tierFilter: number[];
  priorityGlobs: string[];
  total: number;
}

export interface UpdateStatusExtra {
  processed?: number;
  failed?: number;
  cursor?: string | null;
  error?: string | null;
  /**
   * Optional `failure_reason` payload. Mirrors `error`'s contract:
   * `undefined` leaves the field untouched, an explicit `null` clears
   * it via NONE, a string sets it. The daemon shutdown path bypasses
   * this DAL because it filters by status across all rows, but tests
   * and any future per-row caller can route through `updateStatus`.
   */
  failureReason?: string | null;
  /**
   * Replace the run's `failures` array. The worker collects per-note
   * failure paths in memory and flushes the (capped) snapshot at
   * checkpoints and at terminal status updates. Pass `undefined` to
   * leave the field untouched.
   */
  failurePaths?: string[];
}

export interface StatusSubscription {
  close(): Promise<void>;
}

interface AwakenRunRecordRow {
  id: RecordId<"awaken_run">;
  status: string;
  started_at: string | Date;
  finished_at: string | Date | null | undefined;
  total: number;
  processed: number;
  failed: number;
  tier_filter: number[];
  priority_globs: string[];
  cursor: string | null | undefined;
  error: string | null | undefined;
  failure_reason: string | null | undefined;
  failures: string[] | null | undefined;
}

export async function createRun(
  db: Surreal,
  input: CreateRunInput,
): Promise<RecordId<"awaken_run">> {
  if (!Number.isInteger(input.total) || input.total < 0) {
    throw new Error("createRun: total must be a non-negative integer");
  }
  // `started_at` has a DEFAULT of `time::now()` in the schema; we omit it
  // so SurrealDB stamps the server-side wallclock. `cursor` and `error`
  // are option<> fields that must be omitted (not nulled) when absent.
  let result: Awaited<ReturnType<ReturnType<Surreal["create"]>["content"]>>;
  try {
    result = await db.create<{ id: RecordId<"awaken_run"> }>(new Table("awaken_run")).content({
      status: "running",
      total: input.total,
      processed: 0,
      failed: 0,
      tier_filter: input.tierFilter,
      priority_globs: input.priorityGlobs,
    });
  } catch (error) {
    // The `awaken_run_active_unique` index rejects a second active row.
    // Map only that specific violation onto the typed error; every other
    // failure is rethrown unchanged so we never swallow a real SurrealDB
    // problem under the concurrency hood.
    if (isActiveUniqueViolation(error)) {
      throw new AwakenRunAlreadyActiveError();
    }
    throw error;
  }
  const record = Array.isArray(result) ? result[0] : result;
  if (record === undefined) {
    throw new Error("createRun: SurrealDB returned no record");
  }
  return record.id;
}

export async function findCurrent(db: Surreal): Promise<AwakenRunRow | null> {
  const sql =
    "SELECT id, status, started_at, finished_at, total, processed, failed, tier_filter, priority_globs, cursor, error, failure_reason, failures FROM awaken_run WHERE status INSIDE ['running','paused'] ORDER BY started_at DESC LIMIT 1;";
  const [rows] = await db.query<[AwakenRunRecordRow[]]>(sql).collect<[AwakenRunRecordRow[]]>();
  const row = rows[0];
  return row === undefined ? null : mapRow(row);
}

export async function findLatestResumable(db: Surreal): Promise<AwakenRunRow | null> {
  const sql =
    "SELECT id, status, started_at, finished_at, total, processed, failed, tier_filter, priority_globs, cursor, error, failure_reason, failures FROM awaken_run WHERE status INSIDE ['paused','failed'] ORDER BY started_at DESC LIMIT 1;";
  const [rows] = await db.query<[AwakenRunRecordRow[]]>(sql).collect<[AwakenRunRecordRow[]]>();
  const row = rows[0];
  return row === undefined ? null : mapRow(row);
}

export async function findById(
  db: Surreal,
  runId: RecordId<"awaken_run">,
): Promise<AwakenRunRow | null> {
  // Phase 4 task 9 (`notient awaken --status`) locks onto a runId after the
  // first DAL search and polls that specific row even after it transitions
  // to a terminal status. `findCurrent` and `findLatestResumable` filter by
  // status, so they would hide the row in exactly the state the caller
  // wants to surface (`completed` / `cancelled` / `failed`).
  const sql =
    "SELECT id, status, started_at, finished_at, total, processed, failed, tier_filter, priority_globs, cursor, error, failure_reason, failures FROM awaken_run WHERE id = $id;";
  const [rows] = await db
    .query<[AwakenRunRecordRow[]]>(sql, { id: runId })
    .collect<[AwakenRunRecordRow[]]>();
  const row = rows[0];
  return row === undefined ? null : mapRow(row);
}

export async function updateStatus(
  db: Surreal,
  runId: RecordId<"awaken_run">,
  status: AwakenStatus,
  extra?: UpdateStatusExtra,
): Promise<void> {
  const setClauses: string[] = ["status = $status"];
  const bindings: Record<string, unknown> = { id: runId, status };
  if (TERMINAL_STATUSES.has(status)) {
    setClauses.push("finished_at = time::now()");
  }
  if (extra !== undefined) {
    appendCounter(setClauses, bindings, "processed", extra.processed);
    appendCounter(setClauses, bindings, "failed", extra.failed);
    appendOptionString(setClauses, bindings, "cursor", extra.cursor);
    appendOptionString(setClauses, bindings, "error", extra.error);
    appendOptionString(setClauses, bindings, "failure_reason", extra.failureReason);
    if (extra.failurePaths !== undefined) {
      setClauses.push("failures = $failures");
      bindings.failures = extra.failurePaths;
    }
  }
  const sql = `UPDATE $id SET ${setClauses.join(", ")};`;
  await db.query(sql, bindings).collect();
}

function appendCounter(
  setClauses: string[],
  bindings: Record<string, unknown>,
  field: "processed" | "failed",
  value: number | undefined,
): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`updateStatus: ${field} must be a non-negative integer`);
  }
  setClauses.push(`${field} = $${field}`);
  bindings[field] = value;
}

function appendOptionString(
  setClauses: string[],
  bindings: Record<string, unknown>,
  field: "cursor" | "error" | "failure_reason",
  value: string | null | undefined,
): void {
  // option<string>: explicit null clears the field via NONE; a string value
  // sets it. SurrealDB rejects a `null` binding for option<> fields, so we
  // branch the SET clause instead of binding null.
  if (value === undefined) return;
  if (value === null) {
    setClauses.push(`${field} = NONE`);
    return;
  }
  setClauses.push(`${field} = $${field}`);
  bindings[field] = value;
}

export async function subscribeToStatus(
  db: Surreal,
  runId: RecordId<"awaken_run">,
  onChange: (status: AwakenStatus) => void,
): Promise<StatusSubscription> {
  const subscription = await db.live<AwakenRunRecordRow>(new Table("awaken_run"));
  // The unsubscribe callback returned by `subscription.subscribe` is the
  // local in-process handler detach; `subscription.kill()` ends the live
  // query on the server. Both run inside `close()`.
  const unsubscribe = subscription.subscribe((message) => {
    if (message.action === "KILLED") return;
    const recordId = message.recordId;
    if (recordId === undefined || !recordId.equals(runId)) return;
    const value = message.value as Partial<AwakenRunRecordRow> | undefined;
    if (value === undefined) return;
    const status = value.status;
    if (typeof status !== "string") return;
    if (!isAwakenStatus(status)) return;
    onChange(status);
  });
  return {
    close: async (): Promise<void> => {
      unsubscribe();
      await subscription.kill();
    },
  };
}

function isAwakenStatus(value: string): value is AwakenStatus {
  return (
    value === "running" ||
    value === "paused" ||
    value === "cancelled" ||
    value === "completed" ||
    value === "failed"
  );
}

function mapRow(row: AwakenRunRecordRow): AwakenRunRow {
  if (!isAwakenStatus(row.status)) {
    throw new Error(`mapRow: unexpected status '${row.status}'`);
  }
  return {
    id: row.id,
    status: row.status,
    started_at: toDate(row.started_at),
    finished_at:
      row.finished_at === null || row.finished_at === undefined ? null : toDate(row.finished_at),
    total: row.total,
    processed: row.processed,
    failed: row.failed,
    tier_filter: row.tier_filter,
    priority_globs: row.priority_globs,
    cursor: row.cursor ?? null,
    error: row.error ?? null,
    failure_reason: row.failure_reason ?? null,
    failures: row.failures ?? [],
  };
}

function toDate(value: string | Date): Date {
  if (value instanceof Date) return value;
  return new Date(value);
}
