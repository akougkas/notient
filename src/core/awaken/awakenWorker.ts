/**
 * Awaken worker: drives a vault-wide enrichment run.
 *
 * Uses the `awaken_run` store to create a run or resume the latest resumable
 * one, walks the vault by priority, enqueues each path, awaits per-path
 * completion, and checkpoints progress every 10 notes. Pause and cancel are
 * signalled through the live subscription returned by `subscribeToStatus`.
 *
 * Key invariants enforced here:
 *   - Status checks happen between notes, never mid-note. Tier 2 and Tier 3
 *     must always complete (or fail) atomically per note; pausing midway
 *     would leave chunk vectors / linker edges inconsistent with the note's
 *     parsed blocks.
 *   - The live-query subscription is closed in a `finally` block so a
 *     thrown error inside the loop never leaks a SurrealDB live channel.
 *   - The terminal status reflects user intent: when the worker observes
 *     `paused` or `cancelled` mid-flight, it persists the final counters
 *     under that status. It does NOT overwrite the user's terminal status
 *     with `completed`. Only natural completion writes `completed`.
 */

import { DateTime, type RecordId, type Surreal } from "surrealdb";
import type { EventBus } from "../events/eventBus";
import { invalidateVaultPathUniverse } from "../indexer/indexNote";
import { isFullTierFilter, maxRequestedTier } from "../indexer/tierFilter";
import {
  type AwakenRunRow,
  type AwakenStatus,
  createRun,
  findById,
  findCurrent,
  findLatestResumable,
  subscribeToStatus,
  updateStatus,
} from "./awakenRun";
import { compareVaultPaths, createPriorityComparator, sortByPriorityGlobs } from "./priorityGlob";

const CHECKPOINT_EVERY = 10;
const AWAKEN_PRIORITY = 2;

export interface AwakenWorkerVaultFacade {
  listMarkdownPaths(): Promise<string[]>;
}

export interface AwakenWorkerIndexerQueue {
  enqueue(path: string, priority?: number, tierFilter?: ReadonlyArray<number>): void;
}

export interface AwakenWorkerOptions {
  db: Surreal;
  vaultFacade: AwakenWorkerVaultFacade;
  indexerQueue: AwakenWorkerIndexerQueue;
  /**
   * Canonical index lifecycle. Every queued note must terminate with either
   * `indexer:note-indexed` or a path-scoped `indexer:error` before the worker
   * advances its counters.
   */
  bus: EventBus;
  tierFilter: number[];
  priorityGlobs: string[];
  resume: boolean;
  /** Lifecycle cancellation. The background registry owns this in production. */
  signal: AbortSignal;
  /**
   * Optional pre-created `awaken_run` id. The background `awaken --run`
   * path creates the row in the daemon handler before kicking off the
   * worker so the synchronous RPC reply already carries a valid runId.
   * When supplied the worker skips its own `findCurrent` / `createRun`
   * logic and adopts this row as the run cursor. The handler is
   * responsible for the concurrency check (mirroring the worker's
   * `findCurrent` guard) before creating the row.
   */
  existingRunId?: RecordId<"awaken_run">;
}

export interface AwakenWorkerResult {
  runId: RecordId<"awaken_run">;
  status: AwakenStatus;
  processed: number;
  failed: number;
}

interface ResolvedStart {
  runId: RecordId<"awaken_run">;
  processed: number;
  failed: number;
  attempted: number;
  resumeCursor: string | null;
  failurePaths: string[];
  paths: string[];
  tierFilter: number[];
  priorityGlobs: string[];
}

export async function runAwakenWorker(options: AwakenWorkerOptions): Promise<AwakenWorkerResult> {
  throwIfAborted(options.signal);
  invalidateVaultPathUniverse();
  const start = await resolveStart(options);
  throwIfAborted(options.signal);
  const comparator = createPriorityComparator(start.priorityGlobs);
  const orderedPaths = [...start.paths].sort(comparator);
  let processed = start.processed;
  let failed = start.failed;
  let attempted = start.attempted;
  let lastProcessedPath: string | null = start.resumeCursor;
  const failurePaths = [...start.failurePaths];

  const remainingPaths = sliceAfterCursor(orderedPaths, start.resumeCursor, comparator);
  const outcomesThisRun: AwakenTerminalOutcome[] = [];
  let checkpointOutcomes: AwakenTerminalOutcome[] = [];

  // The live-query callback mutates `current` from another microtask; we
  // wrap it in an object so TypeScript does not narrow the field to its
  // initial literal value at the call sites below.
  const statusRef: { current: AwakenStatus } = { current: "running" };
  const subscription = await subscribeToStatus(options.db, start.runId, (next) => {
    statusRef.current = next;
  });

  try {
    throwIfAborted(options.signal);
    for (const notePath of remainingPaths) {
      // Status check between notes only. Mid-note pause would leave Tier 2
      // / Tier 3 inconsistent for `notePath`, so we never interrupt while
      // an enqueue is in-flight.
      if (isInterruptedStatus(statusRef.current)) {
        break;
      }
      throwIfAborted(options.signal);

      // Subscribe before enqueueing. Test queues and lightweight adapters can
      // emit synchronously, so registering afterward would lose the terminal
      // event and leave the run stuck forever.
      const waitForDone = waitForNoteIndexed(options.bus, notePath, options.signal);
      attempted += 1;
      try {
        // Forward the run's tier filter so per-note Tier 1/2/3 execution
        // honours the operator's `--tier` scope. A full filter (`[1, 2, 3]`)
        // is forwarded as `undefined` so the indexer's default
        // (run every tier) code path is preserved for default runs.
        const enqueueFilter = isFullTierFilter(start.tierFilter) ? undefined : start.tierFilter;
        options.indexerQueue.enqueue(notePath, AWAKEN_PRIORITY, enqueueFilter);
        await waitForDone;
        throwIfAborted(options.signal);
        const outcome: AwakenTerminalOutcome = { path: notePath, terminal: "indexed" };
        outcomesThisRun.push(outcome);
        checkpointOutcomes.push(outcome);
      } catch (error) {
        throwIfCancellation(error, options.signal);
        appendFailurePath(failurePaths, notePath);
        const outcome: AwakenTerminalOutcome = { path: notePath, terminal: "failed" };
        outcomesThisRun.push(outcome);
        checkpointOutcomes.push(outcome);
      }
      lastProcessedPath = notePath;

      if (attempted % CHECKPOINT_EVERY === 0) {
        const checkpoint = await reconcileWorkerCounters(
          options,
          checkpointOutcomes,
          maxRequestedTier(start.tierFilter),
        );
        throwIfAborted(options.signal);
        processed += checkpoint.processed;
        failed += checkpoint.failed;
        checkpointOutcomes = [];
        // Re-read the live status just before persisting so we don't
        // accidentally overwrite a `paused` / `cancelled` status the user
        // flipped during the just-finished note.
        if (statusRef.current === "running") {
          await updateStatus(options.db, start.runId, "running", {
            processed,
            failed,
            attempted,
            cursor: lastProcessedPath,
            failurePaths: [...failurePaths],
          });
        }
      }
    }
  } finally {
    await subscription.close();
  }

  throwIfAborted(options.signal);
  const finalStatus = statusRef.current;
  const finalCounters = await reconcileWorkerCounters(
    options,
    outcomesThisRun,
    maxRequestedTier(start.tierFilter),
  );
  throwIfAborted(options.signal);
  processed = start.processed + finalCounters.processed;
  failed = start.failed + finalCounters.failed;
  if (isInterruptedStatus(finalStatus)) {
    // Preserve the user's terminal status. Persist final counters and the
    // last processed path so a future `resume` picks up exactly where we
    // stopped.
    await updateStatus(options.db, start.runId, finalStatus, {
      processed,
      failed,
      attempted,
      cursor: lastProcessedPath,
      failurePaths: [...failurePaths],
    });
    return { runId: start.runId, status: finalStatus, processed, failed };
  }

  // Natural completion. Cursor is intentionally cleared: a completed run
  // has no resume point.
  await updateStatus(options.db, start.runId, "completed", {
    processed,
    failed,
    attempted,
    cursor: null,
    failurePaths: [...failurePaths],
  });
  return { runId: start.runId, status: "completed", processed, failed };
}

function isInterruptedStatus(status: AwakenStatus): status is "paused" | "cancelled" {
  return status === "paused" || status === "cancelled";
}

function createAbortError(): Error {
  const error = new Error("runAwakenWorker: aborted during daemon shutdown");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw createAbortError();
}

function throwIfCancellation(error: unknown, signal: AbortSignal): void {
  if (signal.aborted || isAbortError(error)) throw error;
}

function appendFailurePath(failurePaths: string[], notePath: string): void {
  const failurePathsCap = 200;
  if (failurePaths.length >= failurePathsCap || failurePaths.includes(notePath)) return;
  failurePaths.push(notePath);
}

async function resolveStart(options: AwakenWorkerOptions): Promise<ResolvedStart> {
  if (options.resume) {
    // When the daemon's `awaken.resume` RPC handler picked the row, it
    // forwards the id via `existingRunId`. Prefer that exact row over
    // re-querying for the latest resumable so the worker targets the
    // same row the handler already validated. The handler flips the row
    // to `running` before dispatch; a foreground resume without an id does
    // that transition here after selecting its row.
    if (options.existingRunId !== undefined) {
      const row = await findById(options.db, options.existingRunId);
      if (row === null) {
        throw new Error("runAwakenWorker: existingRunId not found");
      }
      return startFromRow(row);
    }
    const resumable = await findLatestResumable(options.db);
    if (resumable === null) {
      throw new Error("runAwakenWorker: no resumable run found");
    }
    await updateStatus(options.db, resumable.id, "running");
    return startFromRow(resumable);
  }

  if (options.existingRunId !== undefined) {
    // Background dispatch path. The handler already created the row and
    // performed the `findCurrent` concurrency check; the worker adopts
    // the row's existing counters and cursor so a future `--resume`
    // observes the same state machine the foreground path uses.
    const row = await findById(options.db, options.existingRunId);
    if (row === null) {
      throw new Error("runAwakenWorker: existingRunId not found");
    }
    return startFromRow(row);
  }

  const active = await findCurrent(options.db);
  if (active !== null) {
    throw new Error("runAwakenWorker: a run is already active");
  }
  // A fresh run captures one immutable, canonically ordered plan. Resume
  // never re-lists the vault, so filtering and priority decisions cannot
  // drift while a run is paused.
  const allPaths = await options.vaultFacade.listMarkdownPaths();
  const orderedPaths = sortByPriorityGlobs(
    validatePlannedPaths(allPaths, "runAwakenWorker vault listing"),
    options.priorityGlobs,
  );
  // The `findCurrent` check above is an early guard, but two concurrent
  // worker invocations can both observe `null` before either calls
  // `createRun`. The `awaken_run_active_unique` index serializes the
  // race. Keep the DAL's typed domain error intact; the daemon handler owns
  // the translation to its typed RPC boundary.
  const runId: RecordId<"awaken_run"> = await createRun(options.db, {
    tierFilter: options.tierFilter,
    priorityGlobs: options.priorityGlobs,
    paths: orderedPaths,
  });
  return {
    runId,
    processed: 0,
    failed: 0,
    attempted: 0,
    resumeCursor: null,
    failurePaths: [],
    paths: orderedPaths,
    tierFilter: [...options.tierFilter],
    priorityGlobs: [...options.priorityGlobs],
  };
}

function startFromRow(row: AwakenRunRow): ResolvedStart {
  if (row.paths.length !== row.total) {
    throw new Error("runAwakenWorker: persisted path plan does not match total");
  }
  if (row.processed + row.failed !== row.attempted) {
    throw new Error("runAwakenWorker: persisted counters do not match attempted");
  }
  const paths = validatePlannedPaths(row.paths, "runAwakenWorker persisted path plan");
  if (row.cursor !== null) {
    assertCanonicalMarkdownPath(row.cursor, "runAwakenWorker persisted cursor");
  }
  const failurePaths = validatePlannedPaths(
    row.failures,
    "runAwakenWorker persisted failure paths",
  );
  return {
    runId: row.id,
    processed: row.processed,
    failed: row.failed,
    attempted: row.attempted,
    resumeCursor: row.cursor,
    failurePaths: failurePaths.slice(0, 200),
    paths,
    tierFilter: [...row.tier_filter],
    priorityGlobs: [...row.priority_globs],
  };
}

export function sliceAfterCursor(
  paths: string[],
  cursor: string | null,
  comparator: (left: string, right: string) => number = compareVaultPaths,
): string[] {
  if (cursor === null) return paths;
  const index = paths.indexOf(cursor);
  if (index !== -1) return paths.slice(index + 1);
  const upperBound = paths.findIndex((path) => comparator(path, cursor) > 0);
  return upperBound === -1 ? [] : paths.slice(upperBound);
}

async function reconcileWorkerCounters(
  options: AwakenWorkerOptions,
  outcomes: ReadonlyArray<AwakenTerminalOutcome>,
  requiredTier: 1 | 2 | 3,
): Promise<AwakenCounters> {
  return reconcileCountersFromTierState(options.db, outcomes, requiredTier);
}

interface AwakenCounters {
  processed: number;
  failed: number;
}

export interface AwakenTerminalOutcome {
  path: string;
  terminal: "indexed" | "failed";
}

interface AwakenTierState {
  tier1At: number | null;
  tier2At: number | null;
  tier3At: number | null;
}

export async function reconcileCountersFromTierState(
  db: Surreal,
  outcomes: ReadonlyArray<AwakenTerminalOutcome>,
  requiredTier: 1 | 2 | 3,
): Promise<AwakenCounters> {
  if (requiredTier !== 1 && requiredTier !== 2 && requiredTier !== 3) {
    throw new Error("awaken reconciliation: required tier must be 1, 2, or 3");
  }
  const validatedOutcomes = validateTerminalOutcomes(outcomes);
  if (validatedOutcomes.length === 0) return { processed: 0, failed: 0 };

  const states = await fetchAwakenTierStates(
    db,
    validatedOutcomes.map((outcome) => outcome.path),
  );
  let processed = 0;
  let failed = 0;
  for (const outcome of validatedOutcomes) {
    if (outcome.terminal === "failed") {
      failed += 1;
      continue;
    }
    const tierState = states.get(outcome.path);
    if (tierState === undefined || !isRequiredTierDone(tierState, requiredTier)) {
      throw new Error(
        `awaken reconciliation: indexer reported success for '${outcome.path}' without persisted Tier ${requiredTier} completion`,
      );
    }
    processed += 1;
  }
  return { processed, failed };
}

async function fetchAwakenTierStates(
  db: Surreal,
  paths: ReadonlyArray<string>,
): Promise<Map<string, AwakenTierState>> {
  const envelope: unknown = await db
    .query("SELECT path, tier1_at, tier2_at, tier3_at FROM note WHERE path IN $paths;", {
      paths: [...paths],
    })
    .collect();
  if (!Array.isArray(envelope) || envelope.length !== 1 || !Array.isArray(envelope[0])) {
    throw new Error(
      "awaken reconciliation: tier-state query returned an invalid statement envelope",
    );
  }

  const requested = new Set(paths);
  const states = new Map<string, AwakenTierState>();
  for (const rawRow of envelope[0]) {
    const row = readTierStateRow(rawRow);
    if (!requested.has(row.path)) {
      throw new Error(
        `awaken reconciliation: tier-state query returned unrequested path '${row.path}'`,
      );
    }
    if (states.has(row.path)) {
      throw new Error(
        `awaken reconciliation: tier-state query returned duplicate path '${row.path}'`,
      );
    }
    states.set(row.path, row.state);
  }
  return states;
}

function validateTerminalOutcomes(
  outcomes: ReadonlyArray<AwakenTerminalOutcome>,
): AwakenTerminalOutcome[] {
  if (!Array.isArray(outcomes)) {
    throw new Error("awaken reconciliation: terminal outcomes must be an array");
  }
  const paths = new Set<string>();
  return outcomes.map((outcome, index) => {
    if (typeof outcome !== "object" || outcome === null || Array.isArray(outcome)) {
      throw new Error(`awaken reconciliation: outcome ${index} must be an object`);
    }
    const keys = Object.keys(outcome);
    if (keys.length !== 2 || !keys.includes("path") || !keys.includes("terminal")) {
      throw new Error(
        `awaken reconciliation: outcome ${index} must contain only path and terminal`,
      );
    }
    assertCanonicalMarkdownPath(outcome.path, `awaken reconciliation outcome ${index} path`);
    if (outcome.terminal !== "indexed" && outcome.terminal !== "failed") {
      throw new Error(`awaken reconciliation: outcome ${index} has an invalid terminal state`);
    }
    if (paths.has(outcome.path)) {
      throw new Error(`awaken reconciliation: duplicate outcome path '${outcome.path}'`);
    }
    paths.add(outcome.path);
    return { path: outcome.path, terminal: outcome.terminal };
  });
}

function readTierStateRow(raw: unknown): { path: string; state: AwakenTierState } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("awaken reconciliation: tier-state row must be an object");
  }
  const row = raw as Record<string, unknown>;
  const allowed = new Set(["path", "tier1_at", "tier2_at", "tier3_at"]);
  for (const key of Object.keys(row)) {
    if (!allowed.has(key)) {
      throw new Error(`awaken reconciliation: tier-state row has unsupported field '${key}'`);
    }
  }
  assertCanonicalMarkdownPath(row.path, "awaken reconciliation tier-state path");
  const tier1At = readOptionalTierTimestamp(row.tier1_at, "tier1_at");
  const tier2At = readOptionalTierTimestamp(row.tier2_at, "tier2_at");
  const tier3At = readOptionalTierTimestamp(row.tier3_at, "tier3_at");
  if (tier2At !== null && tier1At === null) {
    throw new Error("awaken reconciliation: tier2_at exists without tier1_at");
  }
  if (tier3At !== null && tier2At === null) {
    throw new Error("awaken reconciliation: tier3_at exists without tier2_at");
  }
  if (tier1At !== null && tier2At !== null && tier2At < tier1At) {
    throw new Error("awaken reconciliation: tier2_at precedes tier1_at");
  }
  if (tier2At !== null && tier3At !== null && tier3At < tier2At) {
    throw new Error("awaken reconciliation: tier3_at precedes tier2_at");
  }
  return { path: row.path, state: { tier1At, tier2At, tier3At } };
}

function readOptionalTierTimestamp(raw: unknown, label: string): number | null {
  if (raw === undefined) return null;
  if (raw === null) {
    throw new Error(`awaken reconciliation: ${label} uses null instead of SurrealDB NONE`);
  }
  if (!(raw instanceof DateTime)) {
    throw new Error(`awaken reconciliation: ${label} must be a native SurrealDB datetime`);
  }
  const epoch = raw.toDate().getTime();
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error(`awaken reconciliation: ${label} must be a valid non-negative datetime`);
  }
  return epoch;
}

function isRequiredTierDone(state: AwakenTierState, requiredTier: 1 | 2 | 3): boolean {
  if (requiredTier === 1) return state.tier1At !== null;
  if (requiredTier === 2) return state.tier1At !== null && state.tier2At !== null;
  return state.tier1At !== null && state.tier2At !== null && state.tier3At !== null;
}

function assertCanonicalMarkdownPath(raw: unknown, label: string): asserts raw is string {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.trim() !== raw ||
    raw.startsWith("/") ||
    raw.endsWith("/") ||
    raw.includes("\\") ||
    !raw.endsWith(".md") ||
    hasControlCharacter(raw)
  ) {
    throw new Error(`${label} must be a canonical vault-relative Markdown path`);
  }
  const segments = raw.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`${label} must be a canonical vault-relative Markdown path`);
  }
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function validatePlannedPaths(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${label} must be an array`);
  }
  const seen = new Set<string>();
  return raw.map((path, index) => {
    assertCanonicalMarkdownPath(path, `${label}[${index}]`);
    if (seen.has(path)) {
      throw new Error(`${label} must not contain duplicate paths`);
    }
    seen.add(path);
    return path;
  });
}

export async function waitForNoteIndexed(
  bus: EventBus,
  notePath: string,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    // The first path-scoped terminal outcome wins:
    //   - `indexer:note-indexed` after a successful or filtered pipeline.
    //   - `indexer:error` after any tier failure. Tier 3 emits a trailing
    //     partial `note-indexed` event as telemetry, but this listener is
    //     already detached and the awaken run correctly counts the failure.
    let settled = false;
    const cleanup = (): void => {
      offNoteIndexed();
      offError();
      signal.removeEventListener("abort", onAbort);
    };
    const resolveOnce = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      rejectOnce(createAbortError());
    };
    const offNoteIndexed = bus.on("indexer:note-indexed", (event) => {
      if (event.path !== notePath) return;
      resolveOnce();
    });
    const offError = bus.on("indexer:error", (event) => {
      // Scope the rejection to the currently-waited note. Errors for other
      // paths (watcher-driven reindexes that race with the awaken cycle,
      // or the awaken-background worker-level emit with an empty path) are
      // intentionally ignored so the awaken counter reflects only the
      // outcome of `notePath`.
      if (event.path !== notePath) return;
      rejectOnce(new Error(event.message));
    });
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
