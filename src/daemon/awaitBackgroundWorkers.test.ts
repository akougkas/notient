import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import { AwakenBackgroundRegistry } from "../core/awaken/backgroundRegistry";
import { awaitBackgroundWorkers } from "./awaitBackgroundWorkers";

interface RecordedQuery {
  sql: string;
  bindings: Record<string, unknown> | undefined;
}

interface FakeDb {
  db: Surreal;
  queries: RecordedQuery[];
  rowsToReturn: Array<{ id: string }>;
}

/**
 * Build a SurrealDB-shaped fake whose `query` records every call and
 * returns the configured row set on the orphan-flip UPDATE. The
 * `awaitBackgroundWorkers` helper only invokes one query (the UPDATE),
 * so the fake's surface stays small.
 */
function makeFakeDb(rowsToReturn: Array<{ id: string }> = []): FakeDb {
  const queries: RecordedQuery[] = [];
  const db = {
    query: (sql: string, bindings?: Record<string, unknown>) => {
      queries.push({ sql, bindings });
      return {
        collect: async () => [rowsToReturn],
      };
    },
  } as unknown as Surreal;
  return { db, queries, rowsToReturn };
}

/**
 * Fake whose `query.collect()` rejects so the helper's defensive
 * try/catch is exercised.
 */
function makeFailingDb(): FakeDb {
  const queries: RecordedQuery[] = [];
  const db = {
    query: (sql: string, bindings?: Record<string, unknown>) => {
      queries.push({ sql, bindings });
      return {
        collect: async () => {
          throw new Error("transport closed");
        },
      };
    },
  } as unknown as Surreal;
  return { db, queries, rowsToReturn: [] };
}

describe("awaitBackgroundWorkers", () => {
  test("returns immediately when no workers are tracked but still runs the orphan flip", async () => {
    const registry = new AwakenBackgroundRegistry();
    const fake = makeFakeDb([]);
    const result = await awaitBackgroundWorkers({
      registry,
      db: fake.db,
      graceMs: 1_000,
    });
    expect(result.completed).toBe(0);
    expect(result.orphaned).toBe(0);
    // The UPDATE always runs so a row left at `running` from a prior
    // boot still gets flipped on this shutdown.
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0]?.sql).toContain("UPDATE awaken_run");
    expect(fake.queries[0]?.sql).toContain("status = 'failed'");
    expect(fake.queries[0]?.sql).toContain("failure_reason = $reason");
    expect(fake.queries[0]?.sql).toContain("WHERE status = $running");
    expect(fake.queries[0]?.bindings?.reason).toBe("daemon_shutdown");
    expect(fake.queries[0]?.bindings?.running).toBe("running");
  });

  test("counts settled workers as completed when they all resolve inside the grace", async () => {
    const registry = new AwakenBackgroundRegistry();
    const resolvers: Array<() => void> = [];
    for (let index = 0; index < 3; index += 1) {
      const promise = new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
      registry.track(promise);
    }
    const fake = makeFakeDb([]);

    // Resolve every worker on a microtask boundary so the helper's
    // race against the timeout sees them as already-settled.
    queueMicrotask(() => {
      for (const resolve of resolvers) resolve();
    });

    const result = await awaitBackgroundWorkers({
      registry,
      db: fake.db,
      graceMs: 1_000,
    });
    expect(result.completed).toBe(3);
    expect(result.orphaned).toBe(0);
    expect(registry.size()).toBe(0);
  });

  test("flips orphan rows when the grace window expires before workers settle", async () => {
    const registry = new AwakenBackgroundRegistry();
    // A wedged promise that never resolves. The helper's race against
    // the grace timeout must still return.
    const wedged = new Promise<void>(() => {
      // Intentionally never resolves; the grace timer wins the race.
    });
    registry.track(wedged);

    // Surface two orphan rows on the UPDATE so the orphan count flows
    // through the result.
    const fake = makeFakeDb([{ id: "awaken_run:r1" }, { id: "awaken_run:r2" }]);

    const startedAt = Date.now();
    const result = await awaitBackgroundWorkers({
      registry,
      db: fake.db,
      graceMs: 50,
    });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(500);
    expect(result.completed).toBe(0);
    expect(result.orphaned).toBe(2);
    expect(registry.size()).toBe(1);
  });

  test("never throws when the SurrealDB UPDATE rejects", async () => {
    const registry = new AwakenBackgroundRegistry();
    const fake = makeFailingDb();
    const result = await awaitBackgroundWorkers({
      registry,
      db: fake.db,
      graceMs: 50,
    });
    expect(result.completed).toBe(0);
    expect(result.orphaned).toBe(0);
  });

  test("a rejected worker promise does not crash the helper", async () => {
    const registry = new AwakenBackgroundRegistry();
    let rejectFn: (error: unknown) => void = () => {
      throw new Error("rejectFn not assigned");
    };
    const failing = new Promise<never>((_resolve, reject) => {
      rejectFn = reject;
    });
    // Attach the no-op catch BEFORE `track` so Bun's unhandled-
    // rejection guard sees a caller-side handler the moment the
    // rejection propagates.
    failing.catch(() => {});
    registry.track(failing);
    rejectFn(new Error("worker boom"));
    const fake = makeFakeDb([]);
    const result = await awaitBackgroundWorkers({
      registry,
      db: fake.db,
      graceMs: 50,
    });
    // The failing promise settled (with a rejection), so it counts as
    // completed for the purpose of the shutdown fence.
    expect(result.completed).toBe(1);
    expect(result.orphaned).toBe(0);
  });
});
