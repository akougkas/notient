import { createHash } from "node:crypto";
import type { RecordId } from "surrealdb";
import type { VaultAdapter } from "../../adapters/vaultAdapter";
import type { ApprovalService } from "../../core/approvals/approvalService";
import {
  AwakenRunAlreadyActiveError,
  createRun,
  findById,
  findCurrent,
  findLatestResumable,
  findLatestRun,
  updateStatus,
} from "../../core/awaken/awakenRun";
import { runAwakenWorker } from "../../core/awaken/awakenWorker";
import type { BackgroundRegistry } from "../../core/awaken/backgroundRegistry";
import { sortByPriorityGlobs } from "../../core/awaken/priorityGlob";
import { parseUuidRecordId } from "../../core/db/recordId";
import { type SurrealConnection, clearTierAtByPath } from "../../core/db/surreal";
import type { EventBus } from "../../core/events/eventBus";
import { globToRegExp } from "../../core/indexer/excludePaths";
import type { IndexerQueue } from "../../core/indexer/indexerQueue";
import { purgeExcludedNotes } from "../../core/indexer/purgeNote";
import { prepareNoteRow } from "../../core/indexer/tier1";
import { isFullTierFilter, readTierFilter } from "../../core/indexer/tierFilter";
import { type MethodHandler, RpcError, encodeEvent } from "../rpc";
import type {
  AwakenBackgroundRunResult,
  AwakenCancelResult,
  AwakenForegroundRunResult,
  AwakenPauseResult,
  AwakenResumeResult,
  AwakenStatusResult,
} from "../wire";

export interface AwakenHandlerDeps {
  bus: EventBus;
  indexer: IndexerQueue;
  vault: VaultAdapter;
  /**
   * Canonical SurrealDB substrate used by every awaken and reindex action.
   * It owns the `awaken_run` control plane and is also used to:
   *
   * 1. Pre-create the `note` row for every queued path so Tier 1's
   *    cross-note edge resolution (`lookupNoteByPath`) succeeds on a
   *    single awaken pass. Without this pre-pass, a note linking to a
   *    sibling that sits later in the queue silently drops its
   *    frontmatter_ref.
   * 2. Clear `tier{N}_at` timestamps on matched notes before the
   *    `reindex.glob` flow enqueues.
   */
  surreal: SurrealConnection;
  /**
   * Process-wide registry of in-flight background workers. The handler
   * registers every fire-and-forget worker promise here so the daemon's
   * shutdown path can await pending workers within a bounded grace
   * window. Workers that exceed the window are flipped to
   * `status='failed'` with `failure_reason='daemon_shutdown'` by the
   * shutdown step. Every consumer of `kickOffBackgroundWorker` must
   * supply a registry; the handler does not fall back to a process-wide
   * Set because the daemon's shutdown path needs a single shared hook.
   */
  awakenBackgroundRegistry: BackgroundRegistry;
  /**
   * Vault-relative-path exclusion predicate compiled from
   * `settings.indexer.excludePaths` / `excludeGlobs` (kernel slot
   * `indexExclusion`). `awaken.run` and `reindex.glob` purge already
   * indexed notes that match it before they enqueue, so turning a folder
   * into an excluded folder retroactively removes its notes from the graph
   * instead of leaving orphan rows that keep surfacing in search.
   */
  isExcluded: (vaultPath: string) => boolean;
  /** Cancels durable approval write intents before an excluded note is purged. */
  approvalIntents: Pick<ApprovalService, "cancelForNoteDeletion">;
}

export interface AwakenStatusHandlerDeps {
  surreal: SurrealConnection;
}

function assertCanonicalAwakenDeps(deps: AwakenHandlerDeps): void {
  if (deps.surreal === undefined) {
    throw new Error("Awaken handlers require the SurrealDB substrate");
  }
  if (typeof deps.isExcluded !== "function") {
    throw new Error("Awaken handlers require the canonical exclusion predicate");
  }
  if (deps.approvalIntents === undefined) {
    throw new Error("Awaken handlers require the approval-intent cancellation authority");
  }
}

function parseStatusRunId(value: unknown): RecordId<"awaken_run"> | null {
  if (value === undefined) return null;
  if (typeof value !== "string") {
    throw new RpcError("INVALID_PARAMS", "runId must be a canonical awaken_run UUID string");
  }
  try {
    return parseUuidRecordId(value, "awaken_run", "runId");
  } catch (error) {
    throw new RpcError("INVALID_PARAMS", error instanceof Error ? error.message : String(error));
  }
}

function assertOnlyParams(params: Record<string, unknown>, allowed: readonly string[]): void {
  const unsupported = Object.keys(params).find((key) => !allowed.includes(key));
  if (unsupported !== undefined) {
    throw new RpcError("INVALID_PARAMS", `unknown awaken parameter '${unsupported}'`);
  }
}

function assertNoParams(params: Record<string, unknown>, method: string): void {
  const unexpected = Object.keys(params)[0];
  if (unexpected !== undefined) {
    throw new RpcError("INVALID_PARAMS", `${method} does not accept parameter '${unexpected}'`);
  }
}

/** Read the active, latest, or explicitly locked awaken run through its DAL. */
export function makeAwakenStatusHandler(deps: AwakenStatusHandlerDeps): MethodHandler {
  return async ({ params }) => {
    assertOnlyParams(params, ["runId"]);
    const runId = parseStatusRunId(params.runId);
    const row =
      runId === null
        ? ((await findCurrent(deps.surreal.db)) ?? (await findLatestRun(deps.surreal.db)))
        : await findById(deps.surreal.db, runId);
    return {
      ok: true,
      run:
        row === null
          ? null
          : {
              runId: row.id.toString(),
              status: row.status,
              processed: row.processed,
              failed: row.failed,
              total: row.total,
              startedAt: row.started_at.getTime(),
            },
    } satisfies AwakenStatusResult as unknown as Record<string, unknown>;
  };
}

/**
 * Parse the canonical RPC representation. Omission selects all tiers; a
 * supplied value must be a non-empty numeric tier array. The CLI owns CSV
 * parsing, so strings and malformed arrays are protocol errors here.
 */
function parseTierFilterParam(value: unknown): number[] {
  try {
    const parsed = readTierFilter(value);
    if (
      value !== undefined &&
      (!Array.isArray(value) ||
        value.length !== parsed.length ||
        value.some((tier, index) => tier !== parsed[index]))
    ) {
      throw new Error("tier must be a sorted, unique subset of 1, 2, and 3");
    }
    return parsed;
  } catch (error) {
    throw new RpcError("INVALID_PARAMS", error instanceof Error ? error.message : String(error));
  }
}

function parseSinceParam(value: unknown): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RpcError("INVALID_PARAMS", "since must be a non-negative integer timestamp");
  }
  return value as number;
}

function parseBackgroundParam(value: unknown): boolean {
  if (value === undefined) return false;
  if (value !== true) {
    throw new RpcError("INVALID_PARAMS", "background must be true when supplied");
  }
  return true;
}

function quickWordCount(body: string): number {
  const trimmed = body.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Walk every queued path and pre-create its `note` row before the indexer
 * drains. Tier 1 resolves cross-note edges (wikilinks and frontmatter_refs)
 * via `lookupNoteByPath`; without this pre-pass, a note that links to a
 * not-yet-indexed sibling resolves the target to null and Tier 1 silently
 * drops the frontmatter_ref. Pre-creating with the body sha and a quick
 * whitespace-split word_count guarantees every cross-note lookup finds
 * its target on the first awaken pass. Tier 1 overwrites both scalars
 * with the freshly extracted values when it runs against the same path.
 *
 * Read failures are tolerated: the path is skipped, the indexer queue
 * still receives it (Tier 1 will surface the read error through the
 * normal error path), and other notes still benefit from pre-creation.
 */
async function preCreateNoteRows(
  surreal: SurrealConnection,
  vault: VaultAdapter,
  paths: ReadonlyArray<string>,
  isExcluded: (vaultPath: string) => boolean,
): Promise<void> {
  for (const path of paths) {
    // Defensive: `vault.listMarkdown()` already drops excluded paths, but
    // pre-creating a `note` row here would resurrect exactly the rows the
    // purge just deleted, so the predicate is re-applied at the write.
    if (isExcluded(path)) continue;
    let body: string;
    try {
      body = await vault.read(path);
    } catch {
      continue;
    }
    const sha = createHash("sha256").update(body).digest("hex");
    const wordCount = quickWordCount(body);
    await prepareNoteRow(surreal.db, { path, sha, wordCount });
  }
}

/**
 * Drop every already indexed note whose path is now excluded, and log
 * the purge on stderr in the daemon's usual one-JSON-object-per-line
 * style. Silent when nothing matched.
 */
async function reportPurgedExcluded(
  surreal: SurrealConnection,
  isExcluded: (vaultPath: string) => boolean,
  approvalIntents: Pick<ApprovalService, "cancelForNoteDeletion">,
): Promise<void> {
  const paths = await purgeExcludedNotes(surreal, isExcluded, approvalIntents);
  if (paths.length === 0) return;
  process.stderr.write(`${JSON.stringify({ type: "awaken:purged_excluded", paths })}\n`);
}

/**
 * Drop paths whose `note` row is already stamped at the run's highest tier
 * and whose content still matches the stored sha. This avoids queueing
 * already-finished notes for a no-op indexer pass.
 *
 * The sha check is what keeps this honest. The watcher starts with
 * `ignoreInitial`, so a note edited while the daemon was down is only
 * caught by awaken's re-hash; a stamp alone would let it slip. Reading and
 * hashing here is the cheap part; the queue round trip was the expensive
 * one. A path with no `note` row yet is never stamped, so it survives.
 *
 * Only applied when the caller gave no `since` window. `--since` is the
 * explicit "redo this range regardless" escape hatch, and `reindex` clears
 * the `tier{N}_at` stamps outright, so both keep working unchanged.
 */
async function dropAlreadyStamped(
  surreal: SurrealConnection,
  vault: Pick<VaultAdapter, "read">,
  paths: ReadonlyArray<string>,
  tierFilter: ReadonlyArray<number>,
): Promise<string[]> {
  const maxTier = Math.max(...tierFilter);
  if (!(maxTier === 1 || maxTier === 2 || maxTier === 3)) return [...paths];
  const [rows] = await surreal.db
    .query<[Array<{ path: unknown; sha: unknown }>]>(
      `SELECT path, sha FROM note WHERE tier${maxTier}_at != NONE AND tombstoned_at = NONE;`,
    )
    .collect<[Array<{ path: unknown; sha: unknown }>]>();
  const stamped = new Map<string, string>();
  for (const row of rows ?? []) {
    if (typeof row.path === "string" && typeof row.sha === "string") stamped.set(row.path, row.sha);
  }
  if (stamped.size === 0) return [...paths];
  const kept: string[] = [];
  for (const path of paths) {
    const storedSha = stamped.get(path);
    if (storedSha === undefined) {
      kept.push(path);
      continue;
    }
    let body: string;
    try {
      body = await vault.read(path);
    } catch {
      kept.push(path);
      continue;
    }
    if (createHash("sha256").update(body).digest("hex") !== storedSha) kept.push(path);
  }
  return kept;
}

interface AwakenIndexerQueueFacade {
  enqueue(path: string, priority?: number, filter?: ReadonlyArray<number>): void;
}

function makeIndexerQueueFacade(deps: AwakenHandlerDeps): AwakenIndexerQueueFacade {
  return {
    enqueue: (path: string, priority?: number, filter?: ReadonlyArray<number>): void => {
      deps.indexer.enqueue(path, priority, filter);
    },
  };
}

async function selectAwakenPaths(
  deps: AwakenHandlerDeps,
  surreal: SurrealConnection,
  since: number | null,
  tierFilter: ReadonlyArray<number>,
  isExcluded: (vaultPath: string) => boolean,
): Promise<string[]> {
  const all = await deps.vault.listMarkdown();
  const inTimeWindow = since === null ? all : all.filter((entry) => entry.mtime >= since);
  const paths = inTimeWindow.filter((entry) => !isExcluded(entry.path)).map((entry) => entry.path);
  if (since !== null) return paths;
  return dropAlreadyStamped(surreal, deps.vault, paths, tierFilter);
}

async function createBackgroundRun(
  surreal: SurrealConnection,
  tierFilter: number[],
  paths: string[],
): Promise<RecordId<"awaken_run">> {
  try {
    return await createRun(surreal.db, {
      tierFilter,
      priorityGlobs: [],
      paths,
    });
  } catch (error) {
    if (error instanceof AwakenRunAlreadyActiveError) {
      throw new RpcError("INVALID_PARAMS", "a different run is already active");
    }
    throw error;
  }
}

async function startBackgroundAwaken(
  deps: AwakenHandlerDeps,
  surreal: SurrealConnection,
  queuedPaths: string[],
  tierFilter: number[],
  indexerQueue: AwakenIndexerQueueFacade,
): Promise<AwakenBackgroundRunResult> {
  const orderedPaths = sortByPriorityGlobs(queuedPaths, []);
  const runId = await createBackgroundRun(surreal, tierFilter, orderedPaths);
  kickOffBackgroundWorker({
    deps,
    surreal,
    vaultFacade: {
      listMarkdownPaths: async (): Promise<string[]> => orderedPaths,
    },
    indexerQueue,
    tierFilter,
    runId,
    resume: false,
  });
  return {
    ok: true,
    queued: queuedPaths.length,
    tier: tierFilter,
    runId: runId.toString(),
    status: "running",
    background: true,
  } satisfies AwakenBackgroundRunResult;
}

async function runForegroundAwaken(
  deps: AwakenHandlerDeps,
  surreal: SurrealConnection,
  queuedPaths: string[],
  tierFilter: number[],
  indexerQueue: AwakenIndexerQueueFacade,
  emit: (line: string) => void,
  envelopeId: string,
): Promise<AwakenForegroundRunResult> {
  const forwardEvents = subscribeIndexerEvents(deps.bus, emit, envelopeId);
  try {
    const result = await runAwakenWorker({
      db: surreal.db,
      vaultFacade: {
        listMarkdownPaths: async (): Promise<string[]> => queuedPaths,
      },
      indexerQueue,
      tierFilter,
      priorityGlobs: [],
      resume: false,
      bus: deps.bus,
      signal: new AbortController().signal,
    });
    if (
      result.status !== "paused" &&
      result.status !== "cancelled" &&
      result.status !== "completed"
    ) {
      throw new Error(`foreground awaken returned impossible status '${result.status}'`);
    }
    return {
      ok: true,
      queued: queuedPaths.length,
      tier: tierFilter,
      runId: result.runId.toString(),
      status: result.status,
      processed: result.processed,
      failed: result.failed,
    } satisfies AwakenForegroundRunResult;
  } catch (error) {
    if (error instanceof AwakenRunAlreadyActiveError) {
      throw new RpcError("INVALID_PARAMS", error.message);
    }
    throw error;
  } finally {
    forwardEvents();
  }
}

export function makeAwakenHandler(deps: AwakenHandlerDeps): MethodHandler {
  assertCanonicalAwakenDeps(deps);
  return async ({ params, emit, requestId }) => {
    assertOnlyParams(params, ["since", "tier", "background"]);
    const surreal = deps.surreal;
    const since = parseSinceParam(params.since);
    const tierFilter = parseTierFilterParam(params.tier);
    const background = parseBackgroundParam(params.background);
    await assertNoActiveAwakenWork(deps, surreal, "awaken.run");
    const isExcluded = deps.isExcluded;
    await reportPurgedExcluded(surreal, isExcluded, deps.approvalIntents);
    const queuedPaths = await selectAwakenPaths(deps, surreal, since, tierFilter, isExcluded);

    // Pre-create every queued note row so Tier 1 edge resolution can find
    // targets that sit later in the queue. The pass completes before the
    // worker starts, so every target is visible when indexing begins.
    await preCreateNoteRows(surreal, deps.vault, queuedPaths, isExcluded);

    const indexerQueue = makeIndexerQueueFacade(deps);
    if (background) {
      return startBackgroundAwaken(deps, surreal, queuedPaths, tierFilter, indexerQueue);
    }
    return runForegroundAwaken(
      deps,
      surreal,
      queuedPaths,
      tierFilter,
      indexerQueue,
      emit,
      requestId,
    );
  };
}

async function assertNoActiveAwakenWork(
  deps: AwakenHandlerDeps,
  surreal: SurrealConnection,
  verb: string,
): Promise<void> {
  const active = await findCurrent(surreal.db);
  if (active !== null) {
    throw new RpcError("INVALID_PARAMS", `${verb}: a run is already active`);
  }
  if (deps.awakenBackgroundRegistry.size() > 0) {
    throw new RpcError("INVALID_PARAMS", `${verb}: a background awaken worker is still draining`);
  }
}

function buildControlResult(
  current: NonNullable<Awaited<ReturnType<typeof findCurrent>>>,
  status: "paused" | "cancelled",
  deps: AwakenHandlerDeps,
): AwakenPauseResult | AwakenCancelResult {
  return {
    ok: true,
    runId: current.id.toString(),
    processed: current.processed,
    failed: current.failed,
    total: current.total,
    status,
    draining: deps.awakenBackgroundRegistry.size() > 0,
  };
}

export function makeAwakenPauseHandler(deps: AwakenHandlerDeps): MethodHandler {
  assertCanonicalAwakenDeps(deps);
  return async ({ params }) => {
    assertNoParams(params, "awaken.pause");
    const current = await findCurrent(deps.surreal.db);
    if (current === null) {
      throw new RpcError("INVALID_PARAMS", "no current awaken run; nothing to pause");
    }
    await updateStatus(deps.surreal.db, current.id, "paused");
    return buildControlResult(current, "paused", deps);
  };
}

export function makeAwakenCancelHandler(deps: AwakenHandlerDeps): MethodHandler {
  assertCanonicalAwakenDeps(deps);
  return async ({ params }) => {
    assertNoParams(params, "awaken.cancel");
    const current = await findCurrent(deps.surreal.db);
    if (current === null) {
      throw new RpcError("INVALID_PARAMS", "no current awaken run; nothing to cancel");
    }
    await updateStatus(deps.surreal.db, current.id, "cancelled");
    return buildControlResult(current, "cancelled", deps);
  };
}

interface BackgroundWorkerDispatch {
  deps: AwakenHandlerDeps;
  surreal: SurrealConnection;
  vaultFacade: { listMarkdownPaths(): Promise<string[]> };
  indexerQueue: {
    enqueue(path: string, priority?: number, filter?: ReadonlyArray<number>): void;
  };
  tierFilter: number[];
  runId: RecordId<"awaken_run">;
  /**
   * Forwarded to `runAwakenWorker.resume`. `awaken.run --background`
   * passes `false` (fresh row); `awaken.resume` passes `true` so the
   * worker reloads counters from the existing row instead of starting
   * fresh.
   */
  resume: boolean;
}

function kickOffBackgroundWorker(dispatch: BackgroundWorkerDispatch): void {
  // The worker drives the loop asynchronously. We do NOT await the
  // promise; the RPC reply already returned the runId. A throw inside
  // the worker is funneled to `indexer:error` so the daemon never
  // crashes from a background run. The registry owns the cancellation
  // signal and canonical completion so shutdown can cancel and fully drain
  // a worker that exceeds its grace window before service teardown begins.
  const completion = dispatch.deps.awakenBackgroundRegistry.start((signal) =>
    runAwakenWorker({
      db: dispatch.surreal.db,
      vaultFacade: dispatch.vaultFacade,
      indexerQueue: dispatch.indexerQueue,
      tierFilter: dispatch.tierFilter,
      priorityGlobs: [],
      resume: dispatch.resume,
      bus: dispatch.deps.bus,
      existingRunId: dispatch.runId,
      signal,
    }).catch((error: unknown) => {
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      dispatch.deps.bus.emit({
        type: "indexer:error",
        path: "",
        message,
        phase: "awaken-background",
      });
    }),
  );
  if (completion === null) {
    throw new RpcError("DAEMON_SHUTTING_DOWN", "background worker admission is closed");
  }
}

/**
 * `awaken.resume` RPC handler. The CLI delegates resume to the daemon because
 * a paused worker has exited and closed its live-query subscription; changing
 * row state alone cannot resume execution.
 *
 * This handler:
 *   - Refuses if a different run is already `running` for this vault
 *     (`findCurrent` returns it). The pause/resume cycle leaves the
 *     paused row outside `findCurrent`'s active set, so a coexisting
 *     `running` row is the concurrent-run case the spec rejects.
 *   - Picks the latest resumable row via `findLatestResumable`.
 *   - Flips status to `running` so the row visibly reflects the
 *     command before the worker spins up.
 *   - Spawns a fresh worker via the same fire-and-forget path
 *     `awaken.run --background` uses, with `resume: true` and
 *     `existingRunId: resumable.id` so the worker reloads counters
 *     and the cursor.
 *   - Returns synchronously with the run's current counters.
 */
export function makeAwakenResumeHandler(deps: AwakenHandlerDeps): MethodHandler {
  assertCanonicalAwakenDeps(deps);
  return async ({ params }) => {
    assertNoParams(params, "awaken.resume");
    const surreal = deps.surreal;
    const active = await findCurrent(surreal.db);
    if (active !== null && active.status === "running") {
      throw new RpcError("INVALID_PARAMS", "a different run is already active");
    }
    if (deps.awakenBackgroundRegistry.size() > 0) {
      throw new RpcError("INVALID_PARAMS", "a background awaken worker is still draining");
    }
    const resumable = await findLatestResumable(surreal.db);
    if (resumable === null) {
      throw new RpcError("INVALID_PARAMS", "no resumable awaken run found");
    }
    await updateStatus(surreal.db, resumable.id, "running");

    const queuedPaths = [...resumable.paths];
    const vaultFacade = {
      listMarkdownPaths: async (): Promise<string[]> => queuedPaths,
    };
    const indexerQueue = {
      enqueue: (path: string, priority?: number, filter?: ReadonlyArray<number>): void => {
        deps.indexer.enqueue(path, priority, filter);
      },
    };
    kickOffBackgroundWorker({
      deps,
      surreal,
      vaultFacade,
      indexerQueue,
      tierFilter: resumable.tier_filter,
      runId: resumable.id,
      resume: true,
    });

    return {
      ok: true,
      runId: resumable.id.toString(),
      processed: resumable.processed,
      failed: resumable.failed,
      total: resumable.total,
      status: "running",
    } satisfies AwakenResumeResult;
  };
}

export function makeReindexHandler(deps: AwakenHandlerDeps): MethodHandler {
  assertCanonicalAwakenDeps(deps);
  return async ({ params, emit, requestId }) => {
    const pattern = typeof params.pattern === "string" ? params.pattern : "**/*.md";
    const tierFilter = parseTierFilterParam(params.tier);
    const matcher = globToRegExp(pattern);
    const isExcluded = deps.isExcluded;
    await reportPurgedExcluded(deps.surreal, isExcluded, deps.approvalIntents);
    const all = await deps.vault.listMarkdown();
    const matches = all.filter((entry) => matcher.test(entry.path) && !isExcluded(entry.path));

    // `reindex --tier <csv>` re-runs the named tiers by clearing the matching
    // `tier{N}_at` timestamps for each matched note before enqueueing. The
    // indexer's per-tier orchestrator
    // (`indexNote`) consults the queue-supplied tier filter when
    // deciding which tiers to execute. Tiers outside the filter are
    // left as-is so already-completed work stays untouched.
    // Pre-create note rows for the same reason awaken does: Tier 1's
    // cross-note edge resolution needs every target row visible before
    // the per-note loop starts. Run before clearTierAtByPath so every
    // matched path has a row to clear, including any path added since
    // the last awaken.
    await preCreateNoteRows(
      deps.surreal,
      deps.vault,
      matches.map((entry) => entry.path),
      isExcluded,
    );
    for (const entry of matches) {
      await clearTierAtByPath(deps.surreal.db, entry.path, tierFilter);
    }

    const forwardEvents = subscribeIndexerEvents(deps.bus, emit, requestId);
    try {
      const enqueueFilter = isFullTierFilter(tierFilter) ? undefined : tierFilter;
      for (const entry of matches) {
        deps.indexer.enqueue(entry.path, undefined, enqueueFilter);
      }
      await deps.indexer.drain();
      return { ok: true, queued: matches.length, tier: tierFilter };
    } finally {
      forwardEvents();
    }
  };
}

function subscribeIndexerEvents(
  bus: EventBus,
  emit: (line: string) => void,
  envelopeId: string,
): () => void {
  const unsubs: Array<() => void> = [];
  for (const eventName of [
    "indexer:progress",
    "indexer:note-indexed",
    "indexer:complete",
    "indexer:error",
  ] as const) {
    unsubs.push(
      bus.on(eventName, (event) => {
        emit(encodeEvent(envelopeId, eventName, event as unknown as Record<string, unknown>));
      }),
    );
  }
  return () => {
    for (const off of unsubs) off();
  };
}
