/**
 * Awaken worker: drives a vault-wide enrichment run.
 *
 * Spec: docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md
 * §3.5 (operational tables) and the Phase 4 plan task 8. Sits on top of the
 * Task 7 awaken_run DAL: either creates a new run or resumes the latest
 * resumable one, walks the vault sorted by priority globs, enqueues each
 * path into the indexer queue, awaits per-path completion, and checkpoints
 * progress every 10 notes. Pause / cancel are signalled through SurrealDB
 * via the live-query subscription returned by `subscribeToStatus`.
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

import type { RecordId, Surreal } from "surrealdb";
import type { EventBus } from "../events/eventBus";
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

const CHECKPOINT_EVERY = 10;
const AWAKEN_PRIORITY = 2;
const FULL_TIER_FILTER_LENGTH = 3;

function isFullTierFilter(filter: ReadonlyArray<number>): boolean {
  return filter.length === FULL_TIER_FILTER_LENGTH;
}

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
  tierFilter: number[];
  priorityGlobs: string[];
  resume: boolean;
  /**
   * Optional event bus used to await per-note completion via
   * `indexer:tier3-done`. Ignored when `onNoteIndexed` is provided. When
   * neither is supplied, the worker falls back to a synchronous enqueue
   * (the indexer queue itself will eventually drive the work).
   */
  bus?: EventBus;
  /**
   * Optional override for waiting on per-note completion. Tests inject a
   * faster mechanism here; production wires up the bus path.
   */
  onNoteIndexed?: (path: string) => Promise<void>;
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
  resumeCursor: string | null;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: status-aware run loop with checkpointing reads cleaner inline than split into helpers; complexity comes from interleaving live-query status checks with the per-note enqueue/wait cycle.
export async function runAwakenWorker(options: AwakenWorkerOptions): Promise<AwakenWorkerResult> {
  const allPaths = await options.vaultFacade.listMarkdownPaths();
  const orderedPaths = sortByPriorityGlobs(allPaths, options.priorityGlobs);

  const start = await resolveStart(options, orderedPaths.length);
  let processed = start.processed;
  let failed = start.failed;
  let lastProcessedPath: string | null = start.resumeCursor;

  // Drop already-processed paths when resuming. The cursor records the
  // last successfully checkpointed path; we resume from the entry strictly
  // after it.
  const remainingPaths = sliceAfterCursor(orderedPaths, start.resumeCursor);

  // The live-query callback mutates `current` from another microtask; we
  // wrap it in an object so TypeScript does not narrow the field to its
  // initial literal value at the call sites below.
  const statusRef: { current: AwakenStatus } = { current: "running" };
  const subscription = await subscribeToStatus(options.db, start.runId, (next) => {
    statusRef.current = next;
  });

  try {
    for (const notePath of remainingPaths) {
      // Status check between notes only. Mid-note pause would leave Tier 2
      // / Tier 3 inconsistent for `notePath`, so we never interrupt while
      // an enqueue is in-flight.
      if (statusRef.current === "paused" || statusRef.current === "cancelled") {
        break;
      }

      const waitForDone = waitForNoteIndexed(options, notePath);
      try {
        // Forward the run's tier filter so per-note Tier 1/2/3 execution
        // honours the operator's `--tier` scope. A full filter (`[1, 2, 3]`)
        // is forwarded as `undefined` so the indexer's default
        // (run every tier) code path is preserved for default runs.
        const enqueueFilter = isFullTierFilter(options.tierFilter) ? undefined : options.tierFilter;
        options.indexerQueue.enqueue(notePath, AWAKEN_PRIORITY, enqueueFilter);
        await waitForDone;
        processed += 1;
      } catch {
        failed += 1;
      }
      lastProcessedPath = notePath;

      if ((processed + failed) % CHECKPOINT_EVERY === 0) {
        // Re-read the live status just before persisting so we don't
        // accidentally overwrite a `paused` / `cancelled` status the user
        // flipped during the just-finished note.
        if (statusRef.current === "running") {
          await updateStatus(options.db, start.runId, "running", {
            processed,
            failed,
            cursor: lastProcessedPath,
          });
        }
      }
    }
  } finally {
    await subscription.close();
  }

  const finalStatus = statusRef.current;
  if (finalStatus === "paused" || finalStatus === "cancelled") {
    // Preserve the user's terminal status. Persist final counters and the
    // last processed path so a future `resume` picks up exactly where we
    // stopped.
    await updateStatus(options.db, start.runId, finalStatus, {
      processed,
      failed,
      cursor: lastProcessedPath,
    });
    return { runId: start.runId, status: finalStatus, processed, failed };
  }

  // Natural completion. Cursor is intentionally cleared: a completed run
  // has no resume point.
  await updateStatus(options.db, start.runId, "completed", {
    processed,
    failed,
    cursor: null,
  });
  return { runId: start.runId, status: "completed", processed, failed };
}

async function resolveStart(
  options: AwakenWorkerOptions,
  totalPaths: number,
): Promise<ResolvedStart> {
  if (options.resume) {
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
  const runId = await createRun(options.db, {
    tierFilter: options.tierFilter,
    priorityGlobs: options.priorityGlobs,
    total: totalPaths,
  });
  return { runId, processed: 0, failed: 0, resumeCursor: null };
}

function startFromRow(row: AwakenRunRow): ResolvedStart {
  return {
    runId: row.id,
    processed: row.processed,
    failed: row.failed,
    resumeCursor: row.cursor,
  };
}

function sliceAfterCursor(paths: string[], cursor: string | null): string[] {
  if (cursor === null) return paths;
  const index = paths.indexOf(cursor);
  if (index === -1) return paths;
  return paths.slice(index + 1);
}

async function waitForNoteIndexed(options: AwakenWorkerOptions, notePath: string): Promise<void> {
  if (options.onNoteIndexed) {
    await options.onNoteIndexed(notePath);
    return;
  }
  const bus = options.bus;
  if (bus === undefined) return;
  await new Promise<void>((resolve, reject) => {
    // The indexer emits one of three terminal events per note:
    //   - `indexer:note-indexed` after the orchestrator finishes
    //     (Tier 3 success, Tier 3 failure with partial result, or a
    //     filtered run that stops short of Tier 3 but still reaches
    //     the end of `indexNote`).
    //   - `indexer:tier3-done` immediately before `indexer:note-indexed`
    //     when Tier 3 succeeds; included as a defensive resolve path
    //     so a future indexer rewrite that drops the trailing
    //     `note-indexed` still satisfies the per-note wait.
    //   - `indexer:error` for Tier 1 / Tier 2 failures, where the
    //     orchestrator returns before emitting `note-indexed`. Treat
    //     it as a per-note completion (the run continues with the
    //     `failed` counter incremented) instead of leaking a hung
    //     listener.
    let settled = false;
    const offNoteIndexed = bus.on("indexer:note-indexed", (event) => {
      if (event.path !== notePath || settled) return;
      settled = true;
      offNoteIndexed();
      offTier3();
      offError();
      resolve();
    });
    const offTier3 = bus.on("indexer:tier3-done", (event) => {
      if (event.path !== notePath || settled) return;
      settled = true;
      offNoteIndexed();
      offTier3();
      offError();
      resolve();
    });
    const offError = bus.on("indexer:error", (event) => {
      if (settled) return;
      // The error event does not carry a path; we cannot scope it. The
      // worker treats any unscoped error as terminating the wait so a
      // single broken note never wedges the entire run. The caller's
      // try/catch lifts this rejection into the `failed` counter.
      settled = true;
      offNoteIndexed();
      offTier3();
      offError();
      reject(new Error(event.message));
    });
  });
}

/**
 * Sort `paths` so entries matching the first glob come first, the second
 * glob next, and so on; remaining paths come last. Ties inside a bucket
 * break alphabetically. A path matching multiple globs lands in the
 * earliest bucket.
 */
export function sortByPriorityGlobs(paths: string[], globs: string[]): string[] {
  if (globs.length === 0) return [...paths].sort(compareStrings);
  const matchers = globs.map((pattern) => compileGlob(pattern));
  const buckets: string[][] = matchers.map(() => []);
  const tail: string[] = [];
  for (const path of paths) {
    let placed = false;
    for (let index = 0; index < matchers.length; index += 1) {
      const matcher = matchers[index];
      if (matcher?.(path)) {
        buckets[index]?.push(path);
        placed = true;
        break;
      }
    }
    if (!placed) tail.push(path);
  }
  const out: string[] = [];
  for (const bucket of buckets) {
    bucket.sort(compareStrings);
    out.push(...bucket);
  }
  tail.sort(compareStrings);
  out.push(...tail);
  return out;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// Minimal glob matcher. Supports `*` (any non-slash chars), `**` (any
// chars including slashes), and literal segments. Mirrors the matcher in
// `daemon/handlers/awaken.ts` and is sufficient for the priority-glob use
// case (daily, MOCs, projects/.../*.md).
function compileGlob(pattern: string): (path: string) => boolean {
  const regex = patternToRegExp(pattern);
  return (path) => regex.test(path);
}

function patternToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else if (character !== undefined && ".+()|^$[]{}\\".includes(character)) {
      source += `\\${character}`;
    } else if (character !== undefined) {
      source += character;
    }
  }
  source += "$";
  return new RegExp(source);
}
