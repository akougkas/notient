import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import {
  DAEMON_RESTART_ORPHAN_REASON,
  RESTORE_IMPORT_ORPHAN_REASON,
  reconcileRunOrphans,
} from "../../../../src/core/services/reconcileRunOrphans";

describe("reconcileRunOrphans", () => {
  test("terminalizes process-owned work while preserving paused awaken checkpoints", async () => {
    const calls: Array<{ sql: string; bindings: Record<string, unknown> }> = [];
    const results = [
      [
        { id: 'awaken_run:u"00000000-0000-4000-8000-000000000001"' },
        { id: 'awaken_run:u"00000000-0000-4000-8000-000000000002"' },
      ],
      [{ id: 'agent_run:u"00000000-0000-4000-8000-000000000003"' }],
    ];
    const db = {
      query: (sql: string, bindings: Record<string, unknown>) => {
        calls.push({ sql, bindings });
        const rows = results[calls.length - 1] ?? [];
        return { collect: async () => [rows] };
      },
    } as unknown as Surreal;

    const result = await reconcileRunOrphans(db, {
      reason: RESTORE_IMPORT_ORPHAN_REASON,
      now: () => 1_900_000_000_000,
    });

    expect(result).toEqual({ awakenRuns: 2, agentRuns: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.sql).toContain("UPDATE awaken_run");
    expect(calls[0]?.sql).toContain("status = 'failed'");
    expect(calls[0]?.sql).toContain("failure_reason = $reason");
    expect(calls[0]?.sql).toContain("finished_at = array::max([started_at, time::now()])");
    expect(calls[0]?.sql).toContain("WHERE status = $running");
    expect(calls[0]?.sql).not.toContain("paused");
    expect(calls[0]?.bindings).toEqual({
      reason: RESTORE_IMPORT_ORPHAN_REASON,
      running: "running",
    });
    expect(calls[1]?.sql).toContain("UPDATE agent_run");
    expect(calls[1]?.sql).toContain("finished_at = $finishedAt");
    expect(calls[1]?.sql).toContain("ok = false");
    expect(calls[1]?.sql).toContain("error = $reason");
    expect(calls[1]?.sql).toContain("finished_at IS NONE AND ok IS NONE");
    expect(calls[1]?.bindings).toEqual({
      finishedAt: 1_900_000_000_000,
      reason: RESTORE_IMPORT_ORPHAN_REASON,
    });
  });

  test("supports the same canonical boundary during daemon restart", async () => {
    const db = {
      query: () => ({ collect: async () => [[]] }),
    } as unknown as Surreal;

    await expect(
      reconcileRunOrphans(db, {
        reason: DAEMON_RESTART_ORPHAN_REASON,
        now: () => 0,
      }),
    ).resolves.toEqual({ awakenRuns: 0, agentRuns: 0 });
  });

  test("refuses malformed query envelopes instead of hiding storage failure", async () => {
    const db = {
      query: () => ({ collect: async () => [] }),
    } as unknown as Surreal;

    await expect(reconcileRunOrphans(db, { reason: RESTORE_IMPORT_ORPHAN_REASON })).rejects.toThrow(
      "invalid statement envelope",
    );
  });
});
