import { describe, expect, test } from "bun:test";
import { EventBus } from "../events/eventBus";
import { type IndexNoteFn, IndexerQueue } from "./indexerQueue";

function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("IndexerQueue", () => {
  test("debounces repeated enqueues for the same path", async () => {
    const calls: string[] = [];
    const fn: IndexNoteFn = async (path) => {
      calls.push(path);
    };
    const bus = new EventBus();
    const queue = new IndexerQueue({ indexNote: fn, debounceMs: 30, bus });
    queue.enqueue("/a.md");
    await tick(10);
    queue.enqueue("/a.md");
    await tick(10);
    queue.enqueue("/a.md");
    await tick(80);
    expect(calls).toEqual(["/a.md"]);
    queue.dispose();
  });

  test("processes distinct paths in enqueue order", async () => {
    const calls: string[] = [];
    const fn: IndexNoteFn = async (path) => {
      calls.push(path);
    };
    const bus = new EventBus();
    const queue = new IndexerQueue({ indexNote: fn, debounceMs: 10, bus });
    queue.enqueue("/a.md");
    queue.enqueue("/b.md");
    queue.enqueue("/c.md");
    await tick(120);
    expect(calls).toEqual(["/a.md", "/b.md", "/c.md"]);
    queue.dispose();
  });

  test("emits indexer:error on failure but continues", async () => {
    const bus = new EventBus();
    const errors: string[] = [];
    bus.on("indexer:error", (e) => errors.push(e.message));
    let i = 0;
    const fn: IndexNoteFn = async (path) => {
      i++;
      if (i === 1) throw new Error(`bad ${path}`);
    };
    const queue = new IndexerQueue({ indexNote: fn, debounceMs: 5, bus });
    queue.enqueue("/a.md");
    queue.enqueue("/b.md");
    await tick(80);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bad /a.md");
    queue.dispose();
  });

  test("dispose stops further work", async () => {
    const calls: string[] = [];
    const fn: IndexNoteFn = async (path) => {
      calls.push(path);
    };
    const bus = new EventBus();
    const queue = new IndexerQueue({ indexNote: fn, debounceMs: 5, bus });
    queue.enqueue("/a.md");
    queue.dispose();
    await tick(40);
    expect(calls).toEqual([]);
  });

  test("isExcluded predicate skips Notient-owned folders without enqueuing", async () => {
    const calls: string[] = [];
    const fn: IndexNoteFn = async (path) => {
      calls.push(path);
    };
    const bus = new EventBus();
    const excluded = new Set([
      "Notient/conversations/2026-04-25 chat.md",
      "Notient/proposals/p1.md",
      "Notient/searches/s1.md",
    ]);
    const queue = new IndexerQueue({
      indexNote: fn,
      debounceMs: 5,
      bus,
      isExcluded: (path) => excluded.has(path),
    });
    queue.enqueue("Notient/conversations/2026-04-25 chat.md");
    queue.enqueue("Notient/proposals/p1.md");
    queue.enqueue("Notient/searches/s1.md");
    queue.enqueue("notes/keep.md");
    expect(queue.pendingCount()).toBe(1);
    await tick(40);
    expect(calls).toEqual(["notes/keep.md"]);
    queue.dispose();
  });
});
