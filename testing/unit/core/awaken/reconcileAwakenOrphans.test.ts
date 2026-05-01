import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import {
  DAEMON_RESTART_ORPHAN_REASON,
  reconcileAwakenOrphans,
} from "../../../../src/core/awaken/reconcileAwakenOrphans";

describe("reconcileAwakenOrphans", () => {
  test("marks running awaken rows failed with the restart orphan reason", async () => {
    const calls: Array<{ sql: string; bindings: Record<string, unknown> }> = [];
    const db = {
      query: (sql: string, bindings: Record<string, unknown>) => {
        calls.push({ sql, bindings });
        return {
          collect: async () => [[{ id: "awaken_run:one" }, { id: "awaken_run:two" }]],
        };
      },
    } as unknown as Surreal;

    const result = await reconcileAwakenOrphans(db);

    expect(result).toEqual({ reconciled: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("UPDATE awaken_run");
    expect(calls[0]?.sql).toContain("status = 'failed'");
    expect(calls[0]?.sql).toContain("failure_reason = $reason");
    expect(calls[0]?.sql).toContain("finished_at = time::now()");
    expect(calls[0]?.sql).toContain("WHERE status = $running");
    expect(calls[0]?.bindings).toEqual({
      reason: DAEMON_RESTART_ORPHAN_REASON,
      running: "running",
    });
  });
});
