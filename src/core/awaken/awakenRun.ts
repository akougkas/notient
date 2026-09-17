/**
 * Awaken run DAL.
 *
 * The `awaken_run` table is an append-only run-history log gated by a status
 * machine. A failed run remains resumable, while cancelled and completed rows
 * are historical endpoints. Every write and read is decoded against the one
 * native shape emitted by SurrealDB 3.0.5; corrupt operational state never
 * reaches the worker as a plausible run.
 *
 * Invariants enforced here:
 *   - Rows are append-only history. Helpers in this module only INSERT and
 *     UPDATE; nothing deletes from `awaken_run`.
 *   - Terminal `updateStatus` calls stamp `finished_at` once via
 *     `time::now()` so the server clock is the source of truth. Resuming a
 *     failed run clears that timestamp and its terminal diagnostic.
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

import { DateTime, type RecordId, type Surreal, Table } from "surrealdb";
import { createUuidRecordId, parseStoredUuidRecordId } from "../db/recordId";

export type AwakenStatus = "running" | "paused" | "cancelled" | "completed" | "failed";

const TERMINAL_STATUSES: ReadonlySet<AwakenStatus> = new Set(["cancelled", "completed", "failed"]);
const ACTIVE_STATUSES: ReadonlySet<AwakenStatus> = new Set(["running", "paused"]);
const STATUS_TRANSITIONS: Readonly<Record<AwakenStatus, ReadonlySet<AwakenStatus>>> = {
  running: new Set(["running", "paused", "cancelled", "completed", "failed"]),
  paused: new Set(["paused", "running", "cancelled", "failed"]),
  failed: new Set(["failed", "running"]),
  cancelled: new Set(["cancelled"]),
  completed: new Set(["completed"]),
};
const CANONICAL_TIERS = [1, 2, 3] as const;
const MAX_FAILURE_PATHS = 200;
const ROW_FIELDS =
  "id, status, started_at, finished_at, total, processed, failed, attempted, tier_filter, priority_globs, paths, cursor, error, failure_reason, failures";

/**
 * SurrealDB's `time::now()` samples the host wall clock, which can move
 * backwards during a clock correction. Clamp terminal timestamps to the
 * immutable run start so every persisted lifecycle remains monotonic. Keep
 * this as one expression so `time::now()` is sampled exactly once.
 */
export const AWAKEN_MONOTONIC_FINISHED_AT_SQL = "array::max([started_at, time::now()])";

/**
 * Thrown by `createRun` when the `awaken_run_active_unique` index rejects
 * a fresh insert because another row in `status INSIDE ['running','paused']`
 * already exists. Two near-simultaneous `awaken.run` RPCs are the canonical
 * trigger: both observe `findCurrent === null` and both attempt to create
 * the row, so the index serializes them. Callers should map this onto the
 * daemon's typed `INVALID_PARAMS` RPC error while non-RPC callers retain a
 * domain-specific exception.
 */
export class AwakenRunAlreadyActiveError extends Error {
  constructor(message = "a different run is already active") {
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
  attempted: number;
  tier_filter: number[];
  priority_globs: string[];
  paths: string[];
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
  /** Immutable ordered paths that this run owns. */
  paths: string[];
}

export interface UpdateStatusExtra {
  processed?: number;
  failed?: number;
  attempted?: number;
  cursor?: string | null;
  error?: string | null;
  /**
   * Optional `failure_reason` payload for a failed status. `undefined`
   * retains an existing failed-run diagnostic, an explicit `null` clears it
   * via NONE, and a nonblank string sets it. Moving to any non-failed status
   * clears both terminal diagnostic fields.
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
  id: unknown;
  status: unknown;
  started_at: unknown;
  finished_at?: unknown;
  total: unknown;
  processed: unknown;
  failed: unknown;
  attempted: unknown;
  tier_filter: unknown;
  priority_globs: unknown;
  paths: unknown;
  cursor?: unknown;
  error?: unknown;
  failure_reason?: unknown;
  failures: unknown;
}

export async function createRun(
  db: Surreal,
  input: CreateRunInput,
): Promise<RecordId<"awaken_run">> {
  const validated = parseCreateRunInput(input);
  const runId = createUuidRecordId("awaken_run");
  // `started_at` has a DEFAULT of `time::now()` in the schema; we omit it
  // so SurrealDB stamps the server-side wallclock. `cursor` and `error`
  // are option<> fields that must be omitted (not nulled) when absent.
  let result: unknown;
  try {
    result = await db.create<Record<string, unknown>>(runId).content({
      status: "running",
      total: validated.paths.length,
      processed: 0,
      failed: 0,
      attempted: 0,
      tier_filter: validated.tierFilter,
      priority_globs: validated.priorityGlobs,
      paths: validated.paths,
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
  // Creating a concrete RecordId returns exactly one record object in the
  // installed surrealdb.js/SurrealDB 3.0.5 pair. A table-targeted create
  // returns an array, but this DAL never issues that different operation.
  if (!isRecord(result)) {
    throw new Error("awaken_run storage integrity: create returned a non-record result");
  }
  const created = mapRow(result);
  if (!created.id.equals(runId)) {
    throw new Error("awaken_run storage integrity: create returned a different record id");
  }
  return created.id;
}

export async function findCurrent(db: Surreal): Promise<AwakenRunRow | null> {
  return queryAtMostOneRun(
    db,
    `SELECT ${ROW_FIELDS} FROM awaken_run WHERE status INSIDE ['running','paused'] ORDER BY started_at DESC LIMIT 1;`,
    undefined,
    "findCurrent",
  );
}

export async function findLatestResumable(db: Surreal): Promise<AwakenRunRow | null> {
  return queryAtMostOneRun(
    db,
    `SELECT ${ROW_FIELDS} FROM awaken_run WHERE status INSIDE ['paused','failed'] AND array::len(paths) > 0 ORDER BY started_at DESC LIMIT 1;`,
    undefined,
    "findLatestResumable",
  );
}

export async function findLatestRun(db: Surreal): Promise<AwakenRunRow | null> {
  return queryAtMostOneRun(
    db,
    `SELECT ${ROW_FIELDS} FROM awaken_run ORDER BY started_at DESC LIMIT 1;`,
    undefined,
    "findLatestRun",
  );
}

export async function findById(
  db: Surreal,
  runId: RecordId<"awaken_run">,
): Promise<AwakenRunRow | null> {
  // `awaken.status` locks follow-up polls to one run id even after it reaches
  // a terminal state. Current/resumable queries would hide the row in exactly
  // the state the caller needs to surface (`completed` / `cancelled` / `failed`).
  const id = parseStoredUuidRecordId(runId, "awaken_run", "awaken run lookup id");
  return queryAtMostOneRun(
    db,
    `SELECT ${ROW_FIELDS} FROM awaken_run WHERE id = $id LIMIT 1;`,
    { id },
    "findById",
  );
}

export async function updateStatus(
  db: Surreal,
  runId: RecordId<"awaken_run">,
  status: AwakenStatus,
  extra?: UpdateStatusExtra,
): Promise<void> {
  const id = parseStoredUuidRecordId(runId, "awaken_run", "awaken run update id");
  const nextStatus = parseAwakenStatus(status, "updateStatus status");
  const validatedExtra = parseUpdateStatusExtra(extra);
  const current = await findById(db, id);
  if (current === null) {
    throw new Error("updateStatus: awaken run does not exist");
  }
  assertStatusTransition(current.status, nextStatus);

  const next = mergeUpdate(current, nextStatus, validatedExtra);
  assertRunState(next, "updateStatus");

  const setClauses: string[] = ["status = $status"];
  const bindings: Record<string, unknown> = {
    id,
    status: nextStatus,
    expected_status: current.status,
    expected_total: current.total,
    expected_processed: current.processed,
    expected_failed: current.failed,
    expected_attempted: current.attempted,
  };
  if (TERMINAL_STATUSES.has(nextStatus)) {
    setClauses.push(
      `finished_at = IF finished_at = NONE THEN ${AWAKEN_MONOTONIC_FINISHED_AT_SQL} ELSE finished_at END`,
    );
  } else {
    setClauses.push("finished_at = NONE");
  }
  if (nextStatus === "failed") {
    appendOptionString(setClauses, bindings, "error", validatedExtra?.error);
    appendOptionString(setClauses, bindings, "failure_reason", validatedExtra?.failureReason);
  } else {
    setClauses.push("error = NONE", "failure_reason = NONE");
  }
  if (validatedExtra !== undefined) {
    appendCounter(setClauses, bindings, "processed", validatedExtra.processed);
    appendCounter(setClauses, bindings, "failed", validatedExtra.failed);
    appendCounter(setClauses, bindings, "attempted", validatedExtra.attempted);
    appendOptionString(setClauses, bindings, "cursor", validatedExtra.cursor);
    if (validatedExtra.failurePaths !== undefined) {
      setClauses.push("failures = $failures");
      bindings.failures = validatedExtra.failurePaths;
    }
  }
  const sql = `UPDATE $id SET ${setClauses.join(", ")} WHERE status = $expected_status AND total = $expected_total AND processed = $expected_processed AND failed = $expected_failed AND attempted = $expected_attempted RETURN AFTER;`;
  const envelope: unknown = await db.query(sql, bindings).collect();
  const raw = readExactlyOneRow(envelope, "updateStatus");
  const stored = mapRow(raw);
  if (!stored.id.equals(id)) {
    throw new Error("awaken_run storage integrity: updateStatus returned a different record id");
  }
}

function appendCounter(
  setClauses: string[],
  bindings: Record<string, unknown>,
  field: "processed" | "failed" | "attempted",
  value: number | undefined,
): void {
  if (value === undefined) return;
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
  const id = parseStoredUuidRecordId(runId, "awaken_run", "awaken status subscription id");
  const subscription = await db.live<AwakenRunRecordRow>(new Table("awaken_run"));
  // The unsubscribe callback returned by `subscription.subscribe` is the
  // local in-process handler detach; `subscription.kill()` ends the live
  // query on the server. The SDK does not expose an error callback for a
  // subscribed handler, so a malformed matching notification is retained
  // and surfaced by `close()` instead of disappearing into its async loop.
  let integrityFailure: Error | null = null;
  const unsubscribe = subscription.subscribe((message) => {
    if (message.action === "KILLED") return;
    if (integrityFailure !== null) return;
    try {
      const messageId = parseStoredUuidRecordId(
        message.recordId,
        "awaken_run",
        "awaken live notification id",
      );
      if (!messageId.equals(id)) return;
      if (message.action === "DELETE") {
        throw new Error("awaken_run storage integrity: append-only run was deleted");
      }
      if (!isRecord(message.value)) {
        throw new Error("awaken_run storage integrity: live notification value is not a row");
      }
      onChange(parseAwakenStatus(message.value.status, "awaken live notification status"));
    } catch (error) {
      integrityFailure = asIntegrityError(error, "awaken live notification is malformed");
    }
  });
  let closePromise: Promise<void> | null = null;
  return {
    close: (): Promise<void> => {
      if (closePromise === null) {
        closePromise = (async (): Promise<void> => {
          unsubscribe();
          let killFailure: unknown;
          try {
            await subscription.kill();
          } catch (error) {
            killFailure = error;
          }
          if (integrityFailure !== null) throw integrityFailure;
          if (killFailure !== undefined) throw killFailure;
        })();
      }
      return closePromise;
    },
  };
}

function parseAwakenStatus(value: unknown, label: string): AwakenStatus {
  if (
    value !== "running" &&
    value !== "paused" &&
    value !== "cancelled" &&
    value !== "completed" &&
    value !== "failed"
  ) {
    throw new Error(`awaken_run storage integrity: ${label} is not a supported status`);
  }
  return value;
}

function mapRow(value: unknown): AwakenRunRow {
  if (!isRecord(value)) {
    throw new Error("awaken_run storage integrity: row is not an object");
  }
  const id = parseStoredUuidRecordId(value.id, "awaken_run", "awaken run storage id");
  const status = parseAwakenStatus(value.status, `run ${id.toString()} status`);
  const startedAt = parseStoredDateTime(value.started_at, `run ${id.toString()} started_at`);
  const finishedAt = parseStoredOptionalDateTime(
    value.finished_at,
    `run ${id.toString()} finished_at`,
  );
  const total = parseCounter(value.total, `run ${id.toString()} total`);
  const processed = parseCounter(value.processed, `run ${id.toString()} processed`);
  const failed = parseCounter(value.failed, `run ${id.toString()} failed`);
  const attempted = parseCounter(value.attempted, `run ${id.toString()} attempted`);
  const tierFilter = parseTierFilter(value.tier_filter, `run ${id.toString()} tier_filter`);
  const priorityGlobs = parseUniqueNonBlankStrings(
    value.priority_globs,
    `run ${id.toString()} priority_globs`,
  );
  const paths = parseUniqueNonBlankStrings(value.paths, `run ${id.toString()} paths`);
  const cursor = parseStoredOptionalString(value.cursor, `run ${id.toString()} cursor`);
  const error = parseStoredOptionalString(value.error, `run ${id.toString()} error`);
  const failureReason = parseStoredOptionalString(
    value.failure_reason,
    `run ${id.toString()} failure_reason`,
  );
  const failures = parseUniqueNonBlankStrings(value.failures, `run ${id.toString()} failures`);
  const row: AwakenRunRow = {
    id,
    status,
    started_at: startedAt,
    finished_at: finishedAt,
    total,
    processed,
    failed,
    attempted,
    tier_filter: tierFilter,
    priority_globs: priorityGlobs,
    paths,
    cursor,
    error,
    failure_reason: failureReason,
    failures,
  };
  assertRunState(row, `run ${id.toString()}`);
  return row;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCreateRunInput(input: CreateRunInput): CreateRunInput {
  if (!isRecord(input)) {
    throw new Error("createRun: input must be an object");
  }
  assertOnlyKeys(input, ["tierFilter", "priorityGlobs", "paths"], "createRun");
  return {
    tierFilter: parseTierFilter(input.tierFilter, "createRun tierFilter"),
    priorityGlobs: parseUniqueNonBlankStrings(input.priorityGlobs, "createRun priorityGlobs"),
    paths: parseUniqueNonBlankStrings(input.paths, "createRun paths"),
  };
}

function parseUpdateStatusExtra(
  extra: UpdateStatusExtra | undefined,
): UpdateStatusExtra | undefined {
  if (extra === undefined) return undefined;
  if (!isRecord(extra)) {
    throw new Error("updateStatus: extra must be an object when supplied");
  }
  assertOnlyKeys(
    extra,
    ["processed", "failed", "attempted", "cursor", "error", "failureReason", "failurePaths"],
    "updateStatus",
  );
  const parsed: UpdateStatusExtra = {};
  if (extra.processed !== undefined) {
    parsed.processed = parseCounter(extra.processed, "updateStatus processed");
  }
  if (extra.failed !== undefined) {
    parsed.failed = parseCounter(extra.failed, "updateStatus failed");
  }
  if (extra.attempted !== undefined) {
    parsed.attempted = parseCounter(extra.attempted, "updateStatus attempted");
  }
  if (extra.cursor !== undefined) {
    parsed.cursor = parseInputOptionalString(extra.cursor, "updateStatus cursor");
  }
  if (extra.error !== undefined) {
    parsed.error = parseInputOptionalString(extra.error, "updateStatus error");
  }
  if (extra.failureReason !== undefined) {
    parsed.failureReason = parseInputOptionalString(
      extra.failureReason,
      "updateStatus failureReason",
    );
  }
  if (extra.failurePaths !== undefined) {
    parsed.failurePaths = parseUniqueNonBlankStrings(
      extra.failurePaths,
      "updateStatus failurePaths",
    );
    assertFailurePathCap(parsed.failurePaths, "updateStatus failurePaths");
  }
  return parsed;
}

function mergeUpdate(
  current: AwakenRunRow,
  status: AwakenStatus,
  extra: UpdateStatusExtra | undefined,
): AwakenRunRow {
  const diagnostic = resolveUpdateDiagnostic(current, status, extra);
  return {
    ...current,
    status,
    finished_at: TERMINAL_STATUSES.has(status) ? (current.finished_at ?? current.started_at) : null,
    processed: extra?.processed ?? current.processed,
    failed: extra?.failed ?? current.failed,
    attempted: extra?.attempted ?? current.attempted,
    cursor: extra?.cursor === undefined ? current.cursor : extra.cursor,
    error: diagnostic.error,
    failure_reason: diagnostic.failureReason,
    failures: extra?.failurePaths ?? current.failures,
  };
}

function resolveUpdateDiagnostic(
  current: AwakenRunRow,
  status: AwakenStatus,
  extra: UpdateStatusExtra | undefined,
): { error: string | null; failureReason: string | null } {
  if (status !== "failed") {
    if (
      (extra?.error !== null && extra?.error !== undefined) ||
      (extra?.failureReason !== null && extra?.failureReason !== undefined)
    ) {
      throw new Error("updateStatus: terminal diagnostics may only be set on failed runs");
    }
    return { error: null, failureReason: null };
  }
  return {
    error: extra?.error === undefined ? current.error : extra.error,
    failureReason:
      extra?.failureReason === undefined ? current.failure_reason : extra.failureReason,
  };
}

function assertStatusTransition(current: AwakenStatus, next: AwakenStatus): void {
  if (!STATUS_TRANSITIONS[current].has(next)) {
    throw new Error(`updateStatus: invalid transition from ${current} to ${next}`);
  }
}

function assertRunState(row: AwakenRunRow, label: string): void {
  assertCounterState(row.total, row.processed, row.failed, row.attempted, label);
  assertPlanState(row, label);
  assertLifecycleState(row, label);
  assertDiagnosticState(row, label);
}

function assertPlanState(row: AwakenRunRow, label: string): void {
  if (row.paths.length !== row.total) {
    throw new Error(`${label}: total must equal the persisted path-plan length`);
  }
  if (row.cursor !== null && !row.paths.includes(row.cursor)) {
    throw new Error(`${label}: cursor must belong to the persisted path plan`);
  }
  const pathSet = new Set(row.paths);
  if (row.failures.some((path) => !pathSet.has(path))) {
    throw new Error(`${label}: every failure path must belong to the persisted path plan`);
  }
  if (row.failures.length > row.failed) {
    throw new Error(`${label}: failure paths cannot outnumber failed notes`);
  }
  assertFailurePathCap(row.failures, `${label} failures`);
}

function assertLifecycleState(row: AwakenRunRow, label: string): void {
  if (row.status === "completed") {
    if (row.attempted !== row.total) {
      throw new Error(`${label}: completed runs must have attempted every path`);
    }
    if (row.cursor !== null) {
      throw new Error(`${label}: completed runs must not retain a cursor`);
    }
  }
  if (ACTIVE_STATUSES.has(row.status)) {
    if (row.finished_at !== null) {
      throw new Error(`${label}: active runs must not have finished_at`);
    }
  } else {
    if (row.finished_at === null) {
      throw new Error(`${label}: terminal runs must have finished_at`);
    }
    if (row.finished_at.getTime() < row.started_at.getTime()) {
      throw new Error(`${label}: finished_at cannot precede started_at`);
    }
  }
}

function assertDiagnosticState(row: AwakenRunRow, label: string): void {
  if (row.status === "failed") {
    if ((row.error === null) === (row.failure_reason === null)) {
      throw new Error(`${label}: failed runs require exactly one terminal diagnostic`);
    }
  } else if (row.error !== null || row.failure_reason !== null) {
    throw new Error(`${label}: only failed runs may retain a terminal diagnostic`);
  }
}

function assertCounterState(
  total: number,
  processed: number,
  failed: number,
  attempted: number,
  label: string,
): void {
  if (processed > attempted) {
    throw new Error(`${label}: processed cannot exceed attempted`);
  }
  if (failed > attempted) {
    throw new Error(`${label}: failed cannot exceed attempted`);
  }
  if (attempted > total) {
    throw new Error(`${label}: attempted cannot exceed total`);
  }
  const accounted = processed + failed;
  if (!Number.isSafeInteger(accounted) || accounted !== attempted) {
    throw new Error(`${label}: processed plus failed must equal attempted`);
  }
}

function parseCounter(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function parseTierFilter(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > CANONICAL_TIERS.length) {
    throw new Error(`${label} must be a non-empty canonical tier subset`);
  }
  const tiers: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const tier = value[index];
    if (tier !== 1 && tier !== 2 && tier !== 3) {
      throw new Error(`${label} may contain only tiers 1, 2, and 3`);
    }
    if (index > 0 && tier <= (tiers[index - 1] as number)) {
      throw new Error(`${label} must be unique and ordered canonically`);
    }
    tiers.push(tier);
  }
  return tiers;
}

function parseUniqueNonBlankStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  const strings = value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`${label}[${index}] must be a nonblank string`);
    }
    return entry;
  });
  if (new Set(strings).size !== strings.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return strings;
}

function assertFailurePathCap(paths: ReadonlyArray<string>, label: string): void {
  if (paths.length > MAX_FAILURE_PATHS) {
    throw new Error(`${label} cannot contain more than ${MAX_FAILURE_PATHS} paths`);
  }
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlyArray<string>,
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label}: unsupported field '${key}'`);
    }
  }
}

function parseInputOptionalString(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be null or a nonblank string`);
  }
  return value;
}

function parseStoredOptionalString(value: unknown, label: string): string | null {
  if (value === undefined) return null;
  if (value === null) {
    throw new Error(`${label} uses null instead of SurrealDB NONE`);
  }
  return parseInputOptionalString(value, label);
}

function parseStoredDateTime(value: unknown, label: string): Date {
  if (!(value instanceof DateTime)) {
    throw new Error(`${label} must be a native SurrealDB datetime`);
  }
  const date = value.toDate();
  if (!Number.isSafeInteger(date.getTime()) || date.getTime() < 0) {
    throw new Error(`${label} must be a valid non-negative datetime`);
  }
  return date;
}

function parseStoredOptionalDateTime(value: unknown, label: string): Date | null {
  if (value === undefined) return null;
  if (value === null) {
    throw new Error(`${label} uses null instead of SurrealDB NONE`);
  }
  return parseStoredDateTime(value, label);
}

async function queryAtMostOneRun(
  db: Surreal,
  sql: string,
  bindings: Record<string, unknown> | undefined,
  operation: string,
): Promise<AwakenRunRow | null> {
  const envelope: unknown = await db.query(sql, bindings).collect();
  const rows = readSingleStatementRows(envelope, operation);
  if (rows.length > 1) {
    throw new Error(`awaken_run storage integrity: ${operation} returned more than one LIMIT row`);
  }
  return rows.length === 0 ? null : mapRow(rows[0]);
}

function readSingleStatementRows(value: unknown, operation: string): unknown[] {
  if (!Array.isArray(value) || value.length !== 1 || !Array.isArray(value[0])) {
    throw new Error(
      `awaken_run storage integrity: ${operation} returned an invalid statement envelope`,
    );
  }
  return value[0];
}

function readExactlyOneRow(value: unknown, operation: string): unknown {
  const rows = readSingleStatementRows(value, operation);
  if (rows.length !== 1) {
    throw new Error(`awaken_run storage integrity: ${operation} did not return exactly one row`);
  }
  return rows[0];
}

function asIntegrityError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(`awaken_run storage integrity: ${fallback}`);
}
