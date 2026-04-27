import { describe, expect, test } from "bun:test";
import type { VaultAdapter } from "../../adapters/vaultAdapter";
import { EventBus } from "../../core/events/eventBus";
import type { IndexerQueue } from "../../core/indexer/indexerQueue";
import { makeAwakenHandler, makeReindexHandler } from "./awaken";

interface FakeQueue {
  enqueued: string[];
  enqueue: (path: string) => void;
  drain: () => Promise<void>;
}

function makeQueue(): FakeQueue {
  const queue: FakeQueue = {
    enqueued: [],
    enqueue: (path: string) => {
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
});
