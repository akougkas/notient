import { createHash } from "node:crypto";
import type { RecordId } from "surrealdb";
import type { VaultAdapter } from "../../adapters/vaultAdapter";
import {
  AwakenRunAlreadyActiveError,
  createRun,
  findCurrent,
  findLatestResumable,
  updateStatus,
} from "../../core/awaken/awakenRun";
import { runAwakenWorker } from "../../core/awaken/awakenWorker";
import type { BackgroundRegistry } from "../../core/awaken/backgroundRegistry";
import { type SurrealConnection, clearTierAtByPath } from "../../core/db/surreal";
import type { EventBus } from "../../core/events/eventBus";
import type { IndexerQueue } from "../../core/indexer/indexerQueue";
import { prepareNoteRow } from "../../core/indexer/tier1";
import { encodeEvent } from "../rpc";

const DEFAULT_TIER_FILTER: ReadonlyArray<number> = [1, 2, 3];

export interface AwakenHandlerDeps {
  bus: EventBus;
  indexer: IndexerQueue;
  vault: VaultAdapter;
  /**
   * SurrealDB connection. Required by `awaken.run` so the handler can
   * create the `awaken_run` row that the control-plane CLI helpers
   * (`--pause`, `--resume`, `--cancel`, `--status`) read and mutate.
   * Also used to:
   *
   * 1. Pre-create the `note` row for every queued path so Tier 1's
   *    cross-note edge resolution (`lookupNoteByPath`) succeeds on a
   *    single awaken pass. Without this pre-pass, a note linking to a
   *    sibling that sits later in the queue silently drops its
   *    frontmatter_ref.
   * 2. Clear `tier{N}_at` timestamps on matched notes before the
   *    `reindex.glob` flow enqueues.
   *
   * `reindex.glob` keeps the field optional so the unit tests can
   * still drive its enqueue path without booting Surreal; `awaken.run`
   * fails fast when the field is absent.
   */
  surreal?: SurrealConnection;
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
}

/**
 * Parse a tier filter param. Accepts a `number[]` (preferred wire form
 * from the CLI), a CSV string (forgiving), or `undefined` (default to
 * all tiers). Invalid entries silently drop; an empty resulting set
 * falls back to `[1, 2, 3]` so the daemon never enqueues with an
 * empty filter.
 */
function parseTierFilterParam(value: unknown): number[] {
  const candidates: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",").map((token) => token.trim())
      : [];
  const result = new Set<number>();
  for (const candidate of candidates) {
    const numeric =
      typeof candidate === "number"
        ? candidate
        : typeof candidate === "string" && /^\d+$/.test(candidate)
          ? Number(candidate)
          : Number.NaN;
    if (numeric === 1 || numeric === 2 || numeric === 3) {
      result.add(numeric);
    }
  }
  if (result.size === 0) return [...DEFAULT_TIER_FILTER];
  return Array.from(result).sort((a, b) => a - b);
}

function isFullTierFilter(filter: ReadonlyArray<number>): boolean {
  return filter.length === DEFAULT_TIER_FILTER.length;
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
): Promise<void> {
  for (const path of paths) {
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

export function makeAwakenHandler(deps: AwakenHandlerDeps) {
  return async (
    params: Record<string, unknown>,
    emit: (line: string) => void,
    envelopeId: string,
  ): Promise<Record<string, unknown>> => {
    if (deps.surreal === undefined) {
      throw new Error("awaken.run: SurrealDB connection is required");
    }
    const surreal = deps.surreal;
    const since = typeof params.since === "number" ? params.since : null;
    const tierFilter = parseTierFilterParam(params.tier);
    const background = params.background === true;
    const all = await deps.vault.listMarkdown();
    const filtered = since === null ? all : all.filter((entry) => entry.mtime >= since);
    const queuedPaths = filtered.map((entry) => entry.path);

    // Phase 5 cross-note edge fix. Pre-create every queued note row so
    // Tier 1's `lookupNoteByPath` calls during edge resolution find a
    // target. Without this pass, the first awaken over a fresh vault
    // silently drops frontmatter_refs whose target sits later in the
    // queue. Pre-create runs synchronously before the worker spins up
    // so every path has a row by the time Tier 1 starts.
    await preCreateNoteRows(surreal, deps.vault, queuedPaths);

    const vaultFacade = {
      listMarkdownPaths: async (): Promise<string[]> => queuedPaths,
    };
    const indexerQueue = {
      enqueue: (path: string, priority?: number, filter?: ReadonlyArray<number>): void => {
        deps.indexer.enqueue(path, priority, filter);
      },
    };
    if (background) {
      // Mirror the worker's concurrency guard before we create the row
      // ourselves; the worker only runs `findCurrent` on the default
      // path, so the handler enforces it for the `existingRunId` path.
      // The `findCurrent` check is the fast path; the
      // `awaken_run_active_unique` index in the schema is the backstop
      // for two RPCs that both observe `null` before either inserts.
      const active = await findCurrent(surreal.db);
      if (active !== null) {
        throw new Error("awaken.run: a run is already active");
      }
      let runId: RecordId<"awaken_run">;
      try {
        runId = await createRun(surreal.db, {
          tierFilter,
          priorityGlobs: [],
          total: queuedPaths.length,
        });
      } catch (error) {
        if (error instanceof AwakenRunAlreadyActiveError) {
          throw new Error("INVALID_PARAMS: a different run is already active");
        }
        throw error;
      }
      kickOffBackgroundWorker({
        deps,
        surreal,
        vaultFacade,
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
      };
    }

    const forwardEvents = subscribeIndexerEvents(deps.bus, emit, envelopeId);
    try {
      const result = await runAwakenWorker({
        db: surreal.db,
        vaultFacade,
        indexerQueue,
        tierFilter,
        priorityGlobs: [],
        resume: false,
        bus: deps.bus,
      });
      return {
        ok: true,
        queued: queuedPaths.length,
        tier: tierFilter,
        runId: result.runId.toString(),
        status: result.status,
        processed: result.processed,
        failed: result.failed,
      };
    } finally {
      forwardEvents();
    }
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
  // crashes from a background run. The registry tracks the wrapped
  // promise so the daemon's shutdown path can race it against a bounded
  // grace window before flipping orphans to `failed`.
  const promise = runAwakenWorker({
    db: dispatch.surreal.db,
    vaultFacade: dispatch.vaultFacade,
    indexerQueue: dispatch.indexerQueue,
    tierFilter: dispatch.tierFilter,
    priorityGlobs: [],
    resume: dispatch.resume,
    bus: dispatch.deps.bus,
    existingRunId: dispatch.runId,
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    dispatch.deps.bus.emit({
      type: "indexer:error",
      message,
      phase: "awaken-background",
    });
  });
  dispatch.deps.awakenBackgroundRegistry.track(promise);
}

/**
 * `awaken.resume` RPC handler. The CLI's `awaken --resume` calls this
 * instead of touching SurrealDB directly. The previous design flipped
 * the row's status to `running` from the CLI, but the daemon's worker
 * had already exited at pause time (its live-query subscription closed
 * in `finally`), so no worker observed the change. The row stayed
 * `running` indefinitely.
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
export function makeAwakenResumeHandler(deps: AwakenHandlerDeps) {
  return async (): Promise<Record<string, unknown>> => {
    if (deps.surreal === undefined) {
      throw new Error("awaken.resume: SurrealDB connection is required");
    }
    const surreal = deps.surreal;
    const active = await findCurrent(surreal.db);
    if (active !== null && active.status === "running") {
      throw new Error("INVALID_PARAMS: a different run is already active");
    }
    const resumable = await findLatestResumable(surreal.db);
    if (resumable === null) {
      throw new Error("INVALID_PARAMS: no resumable awaken run found");
    }
    await updateStatus(surreal.db, resumable.id, "running");

    const queuedPaths = (await deps.vault.listMarkdown()).map((entry) => entry.path);
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
    };
  };
}

export function makeReindexHandler(deps: AwakenHandlerDeps) {
  return async (
    params: Record<string, unknown>,
    emit: (line: string) => void,
    envelopeId: string,
  ): Promise<Record<string, unknown>> => {
    const pattern = typeof params.pattern === "string" ? params.pattern : "**/*.md";
    const tierFilter = parseTierFilterParam(params.tier);
    const matcher = compileGlob(pattern);
    const all = await deps.vault.listMarkdown();
    const matches = all.filter((entry) => matcher(entry.path));

    // Phase 5 Task 11: `reindex --tier <csv>` re-runs the named tiers by
    // clearing the matching `tier{N}_at` timestamps for each matched
    // note before enqueueing. The indexer's per-tier orchestrator
    // (`indexNote`) consults the queue-supplied tier filter when
    // deciding which tiers to execute. Tiers outside the filter are
    // left as-is so already-completed work stays untouched.
    if (deps.surreal !== undefined) {
      // Pre-create note rows for the same reason awaken does: Tier 1's
      // cross-note edge resolution needs every target row visible before
      // the per-note loop starts. Run before clearTierAtByPath so every
      // matched path has a row to clear, including any path added since
      // the last awaken.
      await preCreateNoteRows(
        deps.surreal,
        deps.vault,
        matches.map((entry) => entry.path),
      );
      for (const entry of matches) {
        await clearTierAtByPath(deps.surreal.db, entry.path, tierFilter);
      }
    }

    const forwardEvents = subscribeIndexerEvents(deps.bus, emit, envelopeId);
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

/**
 * Minimal glob matcher. Supports `*` (any non-slash chars), `**` (any chars
 * including slashes), and literal segments. Sufficient for the
 * `notient reindex "notes/*.md"` use case in Phase B; richer glob semantics
 * land in Phase E.
 */
function compileGlob(pattern: string): (path: string) => boolean {
  const regex = patternToRegExp(pattern);
  return (path: string) => regex.test(path);
}

function patternToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index++;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else if (".+()|^$[]{}\\".includes(character)) {
      source += `\\${character}`;
    } else {
      source += character;
    }
  }
  source += "$";
  return new RegExp(source);
}
