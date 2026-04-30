import type { Surreal } from "surrealdb";

export interface ReconcileAwakenOrphansResult {
  reconciled: number;
}

export const DAEMON_RESTART_ORPHAN_REASON = "daemon_restart_orphan";

/**
 * Clear awaken runs that survived a previous daemon crash.
 *
 * A process killed with SIGKILL cannot run the graceful shutdown fence, so
 * rows left in `running` keep occupying the partial unique active slot.
 * Boot reconciliation marks those failed before RPC starts. Paused rows are
 * intentional operator checkpoints and stay resumable across daemon restarts.
 */
export async function reconcileAwakenOrphans(db: Surreal): Promise<ReconcileAwakenOrphansResult> {
  const sql =
    "UPDATE awaken_run SET status = 'failed', failure_reason = $reason, finished_at = time::now() WHERE status = $running RETURN id;";
  const [rows] = await db
    .query<[Array<{ id: unknown }>]>(sql, {
      reason: DAEMON_RESTART_ORPHAN_REASON,
      running: "running",
    })
    .collect<[Array<{ id: unknown }>]>();
  return { reconciled: rows.length };
}
