import { describe, expect, test } from "bun:test";
import { RecordId, type Surreal, Table } from "surrealdb";
import type { VaultAdapter } from "../../adapters/vaultAdapter";
import type { SurrealConnection } from "../../core/db/surreal";
import { EventBus } from "../../core/events/eventBus";
import type { IndexerQueue } from "../../core/indexer/indexerQueue";
import { makeAwakenHandler, makeAwakenResumeHandler, makeReindexHandler } from "./awaken";

interface RecordedEnqueue {
  path: string;
  priority: number | undefined;
  tierFilter: ReadonlyArray<number> | undefined;
}

interface FakeQueue {
  records: RecordedEnqueue[];
  enqueued: string[];
  enqueue: (path: string, priority?: number, tierFilter?: ReadonlyArray<number>) => void;
  drain: () => Promise<void>;
}

/**
 * Build a queue stub that tees every `enqueue(path)` into an
 * `indexer:tier3-done` event on the bus. The awaken handler now drives
 * `runAwakenWorker`, which awaits per-note completion via that event;
 * without this tee the worker would block on `findCurrent` -> `enqueue`
 * forever in unit tests.
 */
function makeQueue(bus: EventBus): FakeQueue {
  const queue: FakeQueue = {
    records: [],
    enqueued: [],
    enqueue: (path, priority, tierFilter) => {
      queue.records.push({ path, priority, tierFilter });
      queue.enqueued.push(path);
      // Emit on a microtask boundary so the worker has a chance to
      // register its `indexer:tier3-done` listener before the event
      // fires.
      queueMicrotask(() => {
        bus.emit({ type: "indexer:tier3-done", path });
      });
    },
    drain: async () => {},
  };
  return queue;
}

function makeVault(
  files: { path: string; mtime: number }[],
): Pick<VaultAdapter, "listMarkdown" | "read"> {
  return {
    listMarkdown: async () => files,
    read: async (path: string) => `# ${path}\n`,
  };
}

/**
 * `makeVault` variant whose `read` throws. Reindex unit tests use this
 * shape so the `preCreateNoteRows` pass inside `makeReindexHandler` is
 * skipped (the per-path try/catch swallows the read error and
 * continues). The reindex tests assert exact `surreal.queries` lengths
 * against the `clearTierAtByPath` step alone; a working `read` would
 * interleave `prepareNoteRow` queries and break those assertions.
 */
function makeVaultWithoutRead(
  files: { path: string; mtime: number }[],
): Pick<VaultAdapter, "listMarkdown" | "read"> {
  return {
    listMarkdown: async () => files,
    read: async () => {
      throw new Error("vault.read not implemented in this test fixture");
    },
  };
}

interface RecordedQuery {
  sql: string;
  bindings: Record<string, unknown> | undefined;
}

interface FakeSurrealConnection extends SurrealConnection {
  queries: RecordedQuery[];
  awakenRows: Map<string, AwakenRowState>;
}

interface AwakenRowState {
  id: RecordId<"awaken_run">;
  status: string;
  started_at: Date;
  finished_at: Date | null;
  total: number;
  processed: number;
  failed: number;
  tier_filter: number[];
  priority_globs: string[];
  cursor: string | null;
  error: string | null;
}

/**
 * Build a SurrealConnection-shaped fake that supports the awaken handler's
 * runtime needs:
 *
 *   - `db.create(new Table("awaken_run"))` for `createRun` (the awaken
 *     control plane).
 *   - `db.query(SELECT ... FROM awaken_run ...)` for `findCurrent`,
 *     `findLatestResumable`, and `findById`.
 *   - `db.query(UPDATE $id SET ...)` for `updateStatus`.
 *   - `db.live(new Table("awaken_run"))` returning a noop subscription so
 *     the worker's status-change subscription resolves (the unit tests
 *     never flip the row mid-flight, so the noop is sufficient).
 *   - `db.query(...)` calls fired by `clearTierAtByPath` (the reindex
 *     handler).
 *
 * Every recorded query is appended to `queries` so the existing reindex
 * tests still inspect SQL exactly as before.
 */
function makeFakeSurreal(): FakeSurrealConnection {
  const queries: RecordedQuery[] = [];
  const awakenRows = new Map<string, AwakenRowState>();
  let runCounter = 0;

  function selectAwakenRow(filter: (row: AwakenRowState) => boolean): AwakenRowState[] {
    return Array.from(awakenRows.values())
      .filter(filter)
      .sort((a, b) => b.started_at.getTime() - a.started_at.getTime());
  }

  function runQuery(sql: string, bindings: Record<string, unknown> | undefined): unknown[] {
    queries.push({ sql, bindings });
    if (sql.startsWith("SELECT") && sql.includes("FROM awaken_run")) {
      if (sql.includes("WHERE id = $id")) {
        const idCandidate = bindings?.id;
        if (idCandidate instanceof RecordId) {
          const row = awakenRows.get(idCandidate.id.toString());
          return [row === undefined ? [] : [row]];
        }
        return [[]];
      }
      if (sql.includes("status INSIDE ['running','paused']")) {
        const matches = selectAwakenRow(
          (row) => row.status === "running" || row.status === "paused",
        );
        return [matches.length === 0 ? [] : [matches[0]]];
      }
      if (sql.includes("status INSIDE ['paused','failed']")) {
        const matches = selectAwakenRow(
          (row) => row.status === "paused" || row.status === "failed",
        );
        return [matches.length === 0 ? [] : [matches[0]]];
      }
      return [[]];
    }
    if (sql.startsWith("UPDATE $id SET")) {
      const idCandidate = bindings?.id;
      if (idCandidate instanceof RecordId) {
        const row = awakenRows.get(idCandidate.id.toString());
        if (row !== undefined) {
          if (typeof bindings?.status === "string") row.status = bindings.status;
          if (typeof bindings?.processed === "number") row.processed = bindings.processed;
          if (typeof bindings?.failed === "number") row.failed = bindings.failed;
          if (typeof bindings?.cursor === "string") row.cursor = bindings.cursor;
          if (sql.includes("cursor = NONE")) row.cursor = null;
          if (sql.includes("finished_at = time::now()")) row.finished_at = new Date();
        }
      }
      return [[]];
    }
    return [[]];
  }

  const fakeDb = {
    create: (target: unknown) => {
      const tableName = target instanceof Table ? target.name : String(target);
      return {
        content: async (input: Record<string, unknown>) => {
          if (tableName !== "awaken_run") {
            return { id: new RecordId(tableName, `fake-${runCounter++}`) };
          }
          runCounter += 1;
          const id = new RecordId("awaken_run", `fake-${runCounter}`);
          const row: AwakenRowState = {
            id,
            status: typeof input.status === "string" ? input.status : "running",
            started_at: new Date(),
            finished_at: null,
            total: typeof input.total === "number" ? input.total : 0,
            processed: 0,
            failed: 0,
            tier_filter: Array.isArray(input.tier_filter) ? (input.tier_filter as number[]) : [],
            priority_globs: Array.isArray(input.priority_globs)
              ? (input.priority_globs as string[])
              : [],
            cursor: null,
            error: null,
          };
          awakenRows.set(id.id.toString(), row);
          return { id };
        },
      };
    },
    query: (sql: string, bindings?: Record<string, unknown>) => {
      const result = runQuery(sql, bindings);
      return {
        collect: async () => result,
      };
    },
    live: async () => ({
      subscribe: () => () => {},
      kill: async () => {},
    }),
  };
  return {
    db: fakeDb as unknown as Surreal,
    close: async () => {},
    queries,
    awakenRows,
  };
}

describe("awaken handler", () => {
  test("creates an awaken_run row, enqueues every markdown file, and reaches completed", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal();
    const vault = makeVault([
      { path: "a.md", mtime: 1000 },
      { path: "b.md", mtime: 2000 },
    ]);
    const lines: string[] = [];
    const handler = makeAwakenHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      surreal,
    });
    const result = await handler(
      {},
      (line) => {
        lines.push(line);
      },
      "req-1",
    );
    expect(queue.enqueued.sort()).toEqual(["a.md", "b.md"]);
    expect(result.ok).toBe(true);
    expect(result.queued).toBe(2);
    expect(result.status).toBe("completed");
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(0);
    expect(typeof result.runId).toBe("string");
    // The fake surreal recorded a row that the control-plane CLI helpers
    // would now find via `findCurrent` / `findById`.
    expect(surreal.awakenRows.size).toBe(1);
    const row = Array.from(surreal.awakenRows.values())[0];
    expect(row?.status).toBe("completed");
    expect(row?.processed).toBe(2);
    expect(row?.total).toBe(2);
  });

  test("filters by since when provided", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal();
    const vault = makeVault([
      { path: "old.md", mtime: 1000 },
      { path: "new.md", mtime: 5000 },
    ]);
    const handler = makeAwakenHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      surreal,
    });
    await handler({ since: 3000 }, () => {}, "req-1");
    expect(queue.enqueued).toEqual(["new.md"]);
  });

  test("forwards a partial tier filter to the queue", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal();
    const vault = makeVault([
      { path: "a.md", mtime: 1 },
      { path: "b.md", mtime: 2 },
    ]);
    const handler = makeAwakenHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      surreal,
    });
    const result = await handler({ tier: [2] }, () => {}, "req-1");
    expect(result.tier).toEqual([2]);
    expect(queue.records).toHaveLength(2);
    for (const record of queue.records) {
      expect(record.tierFilter).toEqual([2]);
    }
  });

  test("forwards an undefined tier filter for the default `[1, 2, 3]` filter", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal();
    const vault = makeVault([{ path: "a.md", mtime: 1 }]);
    const handler = makeAwakenHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      surreal,
    });
    await handler({ tier: [1, 2, 3] }, () => {}, "req-1");
    expect(queue.records[0]?.tierFilter).toBeUndefined();
  });

  test("falls back to the default filter when `tier` is empty or invalid", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal();
    const vault = makeVault([{ path: "a.md", mtime: 1 }]);
    const handler = makeAwakenHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      surreal,
    });
    const result = await handler({ tier: ["abc", 0, 5] }, () => {}, "req-1");
    expect(result.tier).toEqual([1, 2, 3]);
    expect(queue.records[0]?.tierFilter).toBeUndefined();
  });

  test("background: true returns immediately with a runId before the worker finishes", async () => {
    // Slow stub indexer: the bus event tee waits 50ms per path before
    // emitting `indexer:tier3-done`, so a foreground call would block on
    // every enqueue. The background path must return before the first
    // event fires.
    const bus = new EventBus();
    const surreal = makeFakeSurreal();
    let enqueueCount = 0;
    const slowQueue = {
      records: [] as RecordedEnqueue[],
      enqueued: [] as string[],
      enqueue: (path: string, priority?: number, tierFilter?: ReadonlyArray<number>): void => {
        slowQueue.records.push({ path, priority, tierFilter });
        slowQueue.enqueued.push(path);
        enqueueCount += 1;
        setTimeout(() => {
          bus.emit({ type: "indexer:tier3-done", path });
        }, 50);
      },
      drain: async () => {},
    };
    const vault = makeVault([
      { path: "a.md", mtime: 1 },
      { path: "b.md", mtime: 2 },
      { path: "c.md", mtime: 3 },
    ]);
    const handler = makeAwakenHandler({
      bus,
      indexer: slowQueue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      surreal,
    });
    const startedAt = Date.now();
    const result = await handler({ background: true }, () => {}, "req-1");
    const elapsed = Date.now() - startedAt;

    expect(result.ok).toBe(true);
    expect(result.background).toBe(true);
    expect(result.status).toBe("running");
    expect(typeof result.runId).toBe("string");
    // The background path must not block on the slow enqueue cycle. The
    // first `setTimeout` would only fire after 50ms; the handler should
    // return well before three enqueues complete.
    expect(elapsed).toBeLessThan(150);
    expect(enqueueCount).toBeLessThanOrEqual(1);

    // Wait for the background worker to drain so the test does not leak
    // a pending timer into the next test.
    await new Promise((resolve) => setTimeout(resolve, 250));
  });

  test("rejects an awaken.run when surreal is missing", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const vault = makeVault([{ path: "a.md", mtime: 1 }]);
    const handler = makeAwakenHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
    });
    let caught: unknown;
    try {
      await handler({}, () => {}, "req-1");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("SurrealDB connection is required");
  });
});

describe("awaken resume handler", () => {
  function seedPausedRow(
    surreal: FakeSurrealConnection,
    paths: ReadonlyArray<string>,
    cursor: string,
  ): RecordId<"awaken_run"> {
    const id = new RecordId("awaken_run", "fake-paused");
    const row: AwakenRowState = {
      id,
      status: "paused",
      started_at: new Date(),
      finished_at: null,
      total: paths.length,
      processed: paths.indexOf(cursor) + 1,
      failed: 0,
      tier_filter: [1, 2, 3],
      priority_globs: [],
      cursor,
      error: null,
    };
    surreal.awakenRows.set(id.id.toString(), row);
    return id;
  }

  async function waitForRowStatus(
    surreal: FakeSurrealConnection,
    runId: RecordId<"awaken_run">,
    target: string,
    timeoutMs = 1_000,
  ): Promise<AwakenRowState> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const row = surreal.awakenRows.get(runId.id.toString());
      if (row !== undefined && row.status === target) return row;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const row = surreal.awakenRows.get(runId.id.toString());
    if (row === undefined) {
      throw new Error("awaken resume test: row vanished before reaching target status");
    }
    throw new Error(
      `awaken resume test: row reached status='${row.status}' instead of '${target}'`,
    );
  }

  test("rejects when no resumable row exists", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal();
    const vault = makeVault([{ path: "a.md", mtime: 1 }]);
    const handler = makeAwakenResumeHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      surreal,
    });
    let caught: unknown;
    try {
      await handler();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("no resumable awaken run found");
  });

  test("rejects when surreal is missing", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const vault = makeVault([{ path: "a.md", mtime: 1 }]);
    const handler = makeAwakenResumeHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
    });
    let caught: unknown;
    try {
      await handler();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("SurrealDB connection is required");
  });

  test("flips paused row to running, kicks worker, and drives it to completed", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal();
    const paths = ["a.md", "b.md", "c.md", "d.md", "e.md"];
    const vault = makeVault(paths.map((entry, index) => ({ path: entry, mtime: index })));
    const runId = seedPausedRow(surreal, paths, "b.md");

    const handler = makeAwakenResumeHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      surreal,
    });

    const result = await handler();
    expect(result.ok).toBe(true);
    expect(result.status).toBe("running");
    expect(result.runId).toBe(runId.toString());
    expect(result.processed).toBe(2);
    expect(result.total).toBe(paths.length);

    const finalRow = await waitForRowStatus(surreal, runId, "completed");
    expect(finalRow.processed).toBe(paths.length);
    expect(finalRow.failed).toBe(0);
    // Only the paths after the cursor were enqueued during resume.
    expect(queue.enqueued).toEqual(["c.md", "d.md", "e.md"]);
  });
});

describe("reindex handler", () => {
  test("enqueues paths matching the glob", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const vault = makeVault([
      { path: "notes/a.md", mtime: 1 },
      { path: "notes/b.md", mtime: 2 },
      { path: "drafts/c.md", mtime: 3 },
    ]);
    const handler = makeReindexHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
    });
    await handler({ pattern: "notes/*.md" }, () => {}, "req-1");
    expect(queue.enqueued.sort()).toEqual(["notes/a.md", "notes/b.md"]);
  });

  test("clears only the requested tier_at column when --tier 2 is supplied", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal();
    const vault = makeVaultWithoutRead([
      { path: "notes/a.md", mtime: 1 },
      { path: "notes/b.md", mtime: 2 },
    ]);
    const handler = makeReindexHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      surreal,
    });
    await handler({ pattern: "notes/*.md", tier: [2] }, () => {}, "req-1");

    expect(surreal.queries).toHaveLength(2);
    for (const recorded of surreal.queries) {
      expect(recorded.sql).toContain("tier2_at = NONE");
      expect(recorded.sql).not.toContain("tier1_at = NONE");
      expect(recorded.sql).not.toContain("tier3_at = NONE");
    }
    const paths = surreal.queries.map((recorded) => recorded.bindings?.path).sort();
    expect(paths).toEqual(["notes/a.md", "notes/b.md"]);

    for (const record of queue.records) {
      expect(record.tierFilter).toEqual([2]);
    }
  });

  test("clears multiple tier_at columns when --tier 2,3 is supplied", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal();
    const vault = makeVaultWithoutRead([{ path: "notes/a.md", mtime: 1 }]);
    const handler = makeReindexHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      surreal,
    });
    await handler({ pattern: "notes/*.md", tier: [2, 3] }, () => {}, "req-1");

    expect(surreal.queries).toHaveLength(1);
    const recorded = surreal.queries[0];
    expect(recorded?.sql).toContain("tier2_at = NONE");
    expect(recorded?.sql).toContain("tier3_at = NONE");
    expect(recorded?.sql).not.toContain("tier1_at = NONE");
  });

  test("falls back to the default filter and clears every tier_at when --tier is invalid", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal();
    const vault = makeVaultWithoutRead([{ path: "notes/a.md", mtime: 1 }]);
    const handler = makeReindexHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      surreal,
    });
    const result = await handler({ pattern: "notes/*.md", tier: ["abc"] }, () => {}, "req-1");
    expect(result.tier).toEqual([1, 2, 3]);

    const recorded = surreal.queries[0];
    expect(recorded?.sql).toContain("tier1_at = NONE");
    expect(recorded?.sql).toContain("tier2_at = NONE");
    expect(recorded?.sql).toContain("tier3_at = NONE");

    // The full filter does not narrow per-tier execution; the queue
    // therefore receives `undefined` so the indexer's default code
    // path runs every tier.
    for (const record of queue.records) {
      expect(record.tierFilter).toBeUndefined();
    }
  });

  test("skips the SurrealDB clear step when no connection is wired", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const vault = makeVault([{ path: "notes/a.md", mtime: 1 }]);
    const handler = makeReindexHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
    });
    await handler({ pattern: "notes/*.md", tier: [2] }, () => {}, "req-1");
    expect(queue.records[0]?.tierFilter).toEqual([2]);
  });
});
