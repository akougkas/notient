/**
 * Bounded shutdown fence for in-flight `awaken --background` workers.
 *
 * Spec: docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md
 * §3.5 (operational tables) and the Phase D follow-up that added
 * shutdown awareness to background awaken workers. The daemon used to
 * SIGTERM through any pending workers; rows stayed at `status='running'`
 * until the next operator-driven `awaken --resume`. This helper races
 * every tracked promise against a single shared timeout, then flips any
 * row whose status is still `running` to `failed` with
 * `failure_reason='daemon_shutdown'` in a single SurrealQL UPDATE.
 *
 * Invariants:
 *   - The race uses one shared timer rather than per-promise timeouts so
 *     the helper always returns within `graceMs` of the call site,
 *     regardless of how many workers are tracked.
 *   - The orphan-flip UPDATE filters on `status = 'running'` so paused,
 *     cancelled, completed, and previously-failed rows are untouched. A
 *     worker that completed naturally during the grace window already
 *     flipped its own status to `completed`; the UPDATE simply does not
 *     match it.
 *   - The helper never throws. The daemon's shutdown sequence wraps the
 *     call in its own try/catch as defense-in-depth, but a registry
 *     swap-out, a SurrealDB transport failure, or a malformed UPDATE
 *     binding is caught here so the caller sees a clean `Promise<{ ... }>`.
 */

import type { Surreal } from "surrealdb";
import type { BackgroundRegistry } from "../core/awaken/backgroundRegistry";

export interface AwaitBackgroundWorkersOptions {
  registry: BackgroundRegistry;
  db: Surreal;
  /**
   * Maximum time, in milliseconds, to wait for tracked workers to
   * settle. Once exceeded, every `awaken_run` row still at
   * `status='running'` is flipped to `failed` with
   * `failure_reason='daemon_shutdown'`. The daemon passes
   * `BACKGROUND_WORKER_GRACE_MS`; tests pass a smaller value so the
   * grace-exceeded path runs quickly.
   */
  graceMs: number;
}

export interface AwaitBackgroundWorkersResult {
  /** Workers that settled inside the grace window. */
  completed: number;
  /** Awaken rows that were still `running` after the grace and got flipped. */
  orphaned: number;
}

const FAILURE_REASON = "daemon_shutdown";

/**
 * Race the registry's pending promises against a single shared timeout.
 * Returns when either every tracked promise has settled or the timeout
 * fires. After the wait, any `awaken_run` row whose status is still
 * `running` is flipped to `failed` with the daemon shutdown reason
 * stamped on `failure_reason`.
 */
export async function awaitBackgroundWorkers(
  options: AwaitBackgroundWorkersOptions,
): Promise<AwaitBackgroundWorkersResult> {
  const pending = options.registry.pendingPromises();
  const startSize = pending.length;
  if (startSize === 0) {
    // Nothing in flight. Still run the orphan flip in case a previous
    // boot left a row at `running`; the UPDATE is cheap and idempotent.
    const orphaned = await flipOrphans(options.db);
    return { completed: 0, orphaned };
  }

  // The registry settles its entries on `.finally`; race the snapshot
  // against a single shared timer so this helper always returns within
  // `graceMs` no matter how many promises are tracked.
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), options.graceMs);
  });
  // Promise.allSettled never rejects; the wrapper is just an isolation
  // boundary so a worker rejection cannot escape into the daemon path.
  const allSettledPromise = Promise.allSettled(pending).then(() => "settled" as const);
  try {
    await Promise.race([allSettledPromise, timeoutPromise]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  const remainingAfterRace = options.registry.size();
  const completed = startSize - remainingAfterRace;
  const orphaned = await flipOrphans(options.db);
  return { completed, orphaned };
}

/**
 * Flip every `awaken_run` row currently at `status='running'` to
 * `status='failed'` with `failure_reason='daemon_shutdown'` and
 * `finished_at = time::now()`. Returns the number of rows updated. The
 * filter uses a single UPDATE bound on the status string so paused,
 * cancelled, completed, and previously-failed rows are untouched.
 */
async function flipOrphans(db: Surreal): Promise<number> {
  try {
    const sql =
      "UPDATE awaken_run SET status = 'failed', failure_reason = $reason, finished_at = time::now() WHERE status = $running RETURN id;";
    const [rows] = await db
      .query<[Array<{ id: unknown }>]>(sql, { reason: FAILURE_REASON, running: "running" })
      .collect<[Array<{ id: unknown }>]>();
    return rows.length;
  } catch {
    // Defense-in-depth: a transport error during shutdown must not
    // block the daemon from exiting. The caller wraps the whole helper
    // in its own try/catch; this inner catch keeps the helper's return
    // shape stable so the wrapper can log a single structured event
    // rather than reasoning about a partial result.
    return 0;
  }
}
