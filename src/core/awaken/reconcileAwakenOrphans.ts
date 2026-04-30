import type { Surreal } from "surrealdb";

export interface ReconcileAwakenOrphansResult {
  reconciled: number;
}

export const DAEMON_RESTART_ORPHAN_REASON = "daemon_restart_orphan";

/**
 * Clear awaken runs that survived a previous daemon crash.
 *
 * A process killed with SIGKILL cannot run the graceful shutdown fence, so
 * rows left in `running` or `paused` keep occupying the partial unique
 * active slot. Boot reconciliation marks them failed before RPC starts.
 */
export async function reconcileAwakenOrphans(db: Surreal): Promise<ReconcileAwakenOrphansResult> {
  const sql =
    "UPDATE awaken_run SET status = 'failed', failure_reason = $reason, finished_at = time::now() WHERE status INSIDE $activeStatuses RETURN id;";
  const [rows] = await db
    .query<[Array<{ id: unknown }>]>(sql, {
      reason: DAEMON_RESTART_ORPHAN_REASON,
      activeStatuses: ["running", "paused"],
    })
    .collect<[Array<{ id: unknown }>]>();
  return { reconciled: rows.length };
}
