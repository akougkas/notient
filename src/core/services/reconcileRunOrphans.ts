import type { Surreal } from "surrealdb";
import { AWAKEN_MONOTONIC_FINISHED_AT_SQL } from "../awaken/awakenRun";

export const DAEMON_RESTART_ORPHAN_REASON = "daemon_restart_orphan";
export const RESTORE_IMPORT_ORPHAN_REASON = "restore_import_orphan";

export interface ReconcileRunOrphansOptions {
  reason: typeof DAEMON_RESTART_ORPHAN_REASON | typeof RESTORE_IMPORT_ORPHAN_REASON;
  now?: () => number;
}

export interface ReconcileRunOrphansResult {
  awakenRuns: number;
  agentRuns: number;
}

/**
 * Terminalize process-owned work that has no process left to finish it.
 *
 * A running awaken row and an unfinished agent row are durable provenance,
 * but their active lifecycle state belongs to the process that created them.
 * Bootstrap and post-import restore both pass through this one boundary.
 * Paused awaken rows are operator checkpoints, not orphans, and deliberately
 * remain resumable.
 */
export async function reconcileRunOrphans(
  db: Surreal,
  options: ReconcileRunOrphansOptions,
): Promise<ReconcileRunOrphansResult> {
  const finishedAt = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(finishedAt) || finishedAt < 0) {
    throw new Error("run orphan reconciliation requires a non-negative millisecond clock");
  }

  const awakenRows = await collectIds(
    db,
    `UPDATE awaken_run SET status = 'failed', failure_reason = $reason, finished_at = ${AWAKEN_MONOTONIC_FINISHED_AT_SQL} WHERE status = $running RETURN id;`,
    { reason: options.reason, running: "running" },
    "awaken_run",
  );
  const agentRows = await collectIds(
    db,
    "UPDATE agent_run SET finished_at = $finishedAt, ok = false, error = $reason WHERE finished_at IS NONE AND ok IS NONE RETURN id;",
    { finishedAt, reason: options.reason },
    "agent_run",
  );
  return { awakenRuns: awakenRows.length, agentRuns: agentRows.length };
}

async function collectIds(
  db: Surreal,
  sql: string,
  bindings: Record<string, unknown>,
  table: string,
): Promise<Array<{ id: unknown }>> {
  const result: unknown = await db.query(sql, bindings).collect();
  if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0])) {
    throw new Error(`${table} orphan reconciliation returned an invalid statement envelope`);
  }
  for (const row of result[0]) {
    if (typeof row !== "object" || row === null || !("id" in row)) {
      throw new Error(`${table} orphan reconciliation returned an invalid row`);
    }
  }
  return result[0] as Array<{ id: unknown }>;
}
