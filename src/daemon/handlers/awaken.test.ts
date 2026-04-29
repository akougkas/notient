import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import type { VaultAdapter } from "../../adapters/vaultAdapter";
import type { SurrealConnection } from "../../core/db/surreal";
import { EventBus } from "../../core/events/eventBus";
import type { IndexerQueue } from "../../core/indexer/indexerQueue";
import { makeAwakenHandler, makeReindexHandler } from "./awaken";

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

function makeQueue(): FakeQueue {
  const queue: FakeQueue = {
    records: [],
    enqueued: [],
    enqueue: (path, priority, tierFilter) => {
      queue.records.push({ path, priority, tierFilter });
      queue.enqueued.push(path);
    },
    drain: async () => {},
  };
  return queue;
}

function makeVault(files: { path: string; mtime: number }[]): Pick<VaultAdapter, "listMarkdown"> {
  return {
    listMarkdown: async () => files,
  };
}

interface RecordedQuery {
  sql: string;
  bindings: Record<string, unknown> | undefined;
}

interface FakeSurrealConnection extends SurrealConnection {
  queries: RecordedQuery[];
}

/**
 * Build a SurrealConnection-shaped object whose `db.query` records the
 * SQL and bindings each invocation receives. The reindex handler uses
 * `clearTierAtByPath` which compiles to a single `UPDATE note SET ...
 * WHERE path = $path` query per matched note; the tests inspect the
 * recorded SQL to assert which `tier{N}_at` columns the operator's
 * `--tier` filter cleared.
 */
function makeFakeSurreal(): FakeSurrealConnection {
  const queries: RecordedQuery[] = [];
  const fakeDb = {
    query: (sql: string, bindings?: Record<string, unknown>) => {
      queries.push({ sql, bindings });
      return {
        collect: async () => [[]] as unknown as unknown[],
      };
    },
  };
  return {
    db: fakeDb as unknown as Surreal,
    close: async () => {},
    queries,
  };
}

describe("awaken handler", () => {
  test("enqueues every markdown file", async () => {
    const bus = new EventBus();
    const queue = makeQueue();
    const vault = makeVault([
      { path: "a.md", mtime: 1000 },
      { path: "b.md", mtime: 2000 },
    ]);
    const lines: string[] = [];
    const handler = makeAwakenHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
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
  });

  test("filters by since when provided", async () => {
    const bus = new EventBus();
    const queue = makeQueue();
    const vault = makeVault([
      { path: "old.md", mtime: 1000 },
      { path: "new.md", mtime: 5000 },
    ]);
    const handler = makeAwakenHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
    });
    await handler({ since: 3000 }, () => {}, "req-1");
    expect(queue.enqueued).toEqual(["new.md"]);
  });

  test("forwards a partial tier filter to the queue", async () => {
    const bus = new EventBus();
    const queue = makeQueue();
    const vault = makeVault([
      { path: "a.md", mtime: 1 },
      { path: "b.md", mtime: 2 },
    ]);
    const handler = makeAwakenHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
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
    const queue = makeQueue();
    const vault = makeVault([{ path: "a.md", mtime: 1 }]);
    const handler = makeAwakenHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
    });
    await handler({ tier: [1, 2, 3] }, () => {}, "req-1");
    expect(queue.records[0]?.tierFilter).toBeUndefined();
  });

  test("falls back to the default filter when `tier` is empty or invalid", async () => {
    const bus = new EventBus();
    const queue = makeQueue();
    const vault = makeVault([{ path: "a.md", mtime: 1 }]);
    const handler = makeAwakenHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
    });
    const result = await handler({ tier: ["abc", 0, 5] }, () => {}, "req-1");
    expect(result.tier).toEqual([1, 2, 3]);
    expect(queue.records[0]?.tierFilter).toBeUndefined();
  });
});

describe("reindex handler", () => {
  test("enqueues paths matching the glob", async () => {
    const bus = new EventBus();
    const queue = makeQueue();
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
    const queue = makeQueue();
    const surreal = makeFakeSurreal();
    const vault = makeVault([
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
    const queue = makeQueue();
    const surreal = makeFakeSurreal();
    const vault = makeVault([{ path: "notes/a.md", mtime: 1 }]);
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
    const queue = makeQueue();
    const surreal = makeFakeSurreal();
    const vault = makeVault([{ path: "notes/a.md", mtime: 1 }]);
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
    const queue = makeQueue();
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
