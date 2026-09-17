/**
 * Bounded shutdown fence for in-flight `awaken --background` workers.
 *
 * Gives every tracked worker one shared grace window, cancels and drains any
 * remainder, then flips rows still marked `running` to `failed` with
 * `failure_reason='daemon_shutdown'` in one SurrealQL update.
 *
 * Invariants:
 *   - The natural-completion race uses one shared timer rather than
 *     per-promise timeouts. After that grace, explicit cancellation and a
 *     final drain guarantee no worker can outlive the SurrealDB SDK.
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
import { AWAKEN_MONOTONIC_FINISHED_AT_SQL } from "../core/awaken/awakenRun";
import type { BackgroundRegistry } from "../core/awaken/backgroundRegistry";

export interface AwaitBackgroundWorkersOptions {
  registry: BackgroundRegistry;
  db: Surreal;
  /**
   * Maximum time, in milliseconds, to wait for tracked workers to
   * settle naturally. Once exceeded, remaining workers are cancelled and
   * drained before every `awaken_run` row still at `status='running'` is
   * flipped to `failed` with `failure_reason='daemon_shutdown'`. The daemon
   * passes `BACKGROUND_WORKER_GRACE_MS`; tests pass a smaller value so the
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
 * Once either every tracked promise settles or the grace expires, close
 * admission, cancel and drain any remainder, then stamp any still-running
 * row with the daemon shutdown reason.
 */
export async function awaitBackgroundWorkers(
  options: AwaitBackgroundWorkersOptions,
): Promise<AwaitBackgroundWorkersResult> {
  const pending = options.registry.pendingPromises();
  const startSize = pending.length;
  if (startSize === 0) {
    options.registry.stop();
    await options.registry.drain();
    // Still run the orphan flip in case a previous boot left a row at
    // `running`; the UPDATE is cheap and idempotent.
    const orphaned = await flipOrphans(options.db);
    return { completed: 0, orphaned };
  }

  // Race the registry's defensive snapshot against one shared timer. The
  // grace bounds natural completion; explicit cancellation and drain follow.
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), options.graceMs);
  });
  // Promise.allSettled never rejects; the wrapper is just an isolation
  // boundary so a worker rejection cannot escape into the daemon path.
  const allSettledPromise = Promise.allSettled(pending).then(() => "settled" as const);
  let outcome: "settled" | "timeout";
  try {
    outcome = await Promise.race([allSettledPromise, timeoutPromise]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  const completed = outcome === "settled" ? startSize : startSize - options.registry.size();
  options.registry.stop();
  await options.registry.drain();
  const orphaned = await flipOrphans(options.db);
  return { completed, orphaned };
}

/**
 * Flip every `awaken_run` row currently at `status='running'` to
 * `status='failed'` with `failure_reason='daemon_shutdown'` and
 * a server-clock `finished_at` clamped to the immutable `started_at`. The
 * filter uses a single UPDATE bound on the status string so paused, cancelled,
 * completed, and previously-failed rows are untouched. Returns the number of
 * rows updated.
 */
async function flipOrphans(db: Surreal): Promise<number> {
  try {
    const sql = `UPDATE awaken_run SET status = 'failed', failure_reason = $reason, finished_at = ${AWAKEN_MONOTONIC_FINISHED_AT_SQL} WHERE status = $running RETURN id;`;
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
