import { describe, expect, test } from "bun:test";
import { EventBus } from "../../../../src/core/events/eventBus";
import { type IndexNoteFn, IndexerQueue } from "../../../../src/core/indexer/indexerQueue";

function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("IndexerQueue", () => {
  test("rejects invalid debounce intervals instead of repairing them", () => {
    const indexNote: IndexNoteFn = async () => {};
    for (const debounceMs of [-1, 1.5, 600_001, Number.NaN]) {
      expect(
        () =>
          new IndexerQueue({
            indexNote,
            debounceMs,
            bus: new EventBus(),
            isExcluded: () => false,
          }),
      ).toThrow("debounceMs must be an integer between 0 and 600000");
    }
  });

  test("debounces repeated enqueues for the same path", async () => {
    const calls: string[] = [];
    const fn: IndexNoteFn = async (path) => {
      calls.push(path);
    };
    const bus = new EventBus();
    const queue = new IndexerQueue({ indexNote: fn, debounceMs: 30, bus, isExcluded: () => false });
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
    const queue = new IndexerQueue({ indexNote: fn, debounceMs: 10, bus, isExcluded: () => false });
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
    const queue = new IndexerQueue({ indexNote: fn, debounceMs: 5, bus, isExcluded: () => false });
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
    const queue = new IndexerQueue({ indexNote: fn, debounceMs: 5, bus, isExcluded: () => false });
    queue.enqueue("/a.md");
    queue.dispose();
    await tick(40);
    expect(calls).toEqual([]);
  });

  test("stopAccepting drains queued work and refuses later enqueues", async () => {
    const calls: string[] = [];
    const queue = new IndexerQueue({
      bus: new EventBus(),
      debounceMs: 20,
      indexNote: async (path) => {
        calls.push(path);
      },

      isExcluded: () => false,
    });

    queue.enqueue("/accepted.md");
    queue.stopAccepting();
    queue.enqueue("/late.md");
    await queue.drain();

    expect(calls).toEqual(["/accepted.md"]);
    queue.dispose();
  });

  test("maintenance pause drains accepted work and resumes admission", async () => {
    const calls: string[] = [];
    const queue = new IndexerQueue({
      bus: new EventBus(),
      debounceMs: 5,
      indexNote: async (path) => {
        calls.push(path);
      },
      isExcluded: () => false,
    });

    queue.enqueue("/accepted.md");
    queue.pause();
    queue.enqueue("/paused.md");
    await queue.drain();
    queue.resume();
    queue.enqueue("/resumed.md");
    await queue.drain();

    expect(calls).toEqual(["/accepted.md", "/resumed.md"]);
    queue.dispose();
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
    ]);
    const queue = new IndexerQueue({
      indexNote: fn,
      debounceMs: 5,
      bus,
      isExcluded: (path) => excluded.has(path),
    });
    queue.enqueue("Notient/conversations/2026-04-25 chat.md");
    queue.enqueue("Notient/proposals/p1.md");
    queue.enqueue("notes/keep.md");
    expect(queue.pendingCount()).toBe(1);
    await tick(40);
    expect(calls).toEqual(["notes/keep.md"]);
    queue.dispose();
  });

  test("higher-priority enqueue drains before earlier lower-priority entries", async () => {
    const calls: string[] = [];
    const release: (() => void)[] = [];
    const gate = new Promise<void>((resolve) => {
      release.push(resolve);
    });
    let first = true;
    const fn: IndexNoteFn = async (path) => {
      if (first) {
        first = false;
        calls.push(path);
        await gate;
        return;
      }
      calls.push(path);
    };
    const bus = new EventBus();
    const queue = new IndexerQueue({ indexNote: fn, debounceMs: 5, bus, isExcluded: () => false });
    queue.enqueue("/blocker.md", 2);
    await tick(20);
    queue.enqueue("/low.md", 1);
    queue.enqueue("/high.md", 0);
    await tick(20);
    expect(calls).toEqual(["/blocker.md"]);
    release[0]();
    await tick(40);
    expect(calls).toEqual(["/blocker.md", "/high.md", "/low.md"]);
    queue.dispose();
  });

  test("pendingCount(priority) reports per-tier backlog across debounce and ready", async () => {
    const release: (() => void)[] = [];
    const gate = new Promise<void>((resolve) => {
      release.push(resolve);
    });
    let first = true;
    const fn: IndexNoteFn = async () => {
      if (first) {
        first = false;
        await gate;
      }
    };
    const bus = new EventBus();
    const queue = new IndexerQueue({ indexNote: fn, debounceMs: 30, bus, isExcluded: () => false });
    queue.enqueue("/blocker.md", 0);
    await tick(50);
    queue.enqueue("/ready-low.md", 1);
    queue.enqueue("/ready-high.md", 0);
    await tick(50);
    queue.enqueue("/pending-low.md", 1);
    queue.enqueue("/pending-high.md", 0);
    expect(queue.pendingCount(0)).toBe(2);
    expect(queue.pendingCount(1)).toBe(2);
    expect(queue.pendingCount(2)).toBe(0);
    expect(queue.pendingCount()).toBe(4);
    release[0]();
    await tick(120);
    queue.dispose();
  });

  test("re-enqueue while debouncing updates priority to the latest value", async () => {
    const calls: string[] = [];
    const release: (() => void)[] = [];
    const gate = new Promise<void>((resolve) => {
      release.push(resolve);
    });
    let first = true;
    const fn: IndexNoteFn = async (path) => {
      if (first) {
        first = false;
        calls.push(path);
        await gate;
        return;
      }
      calls.push(path);
    };
    const bus = new EventBus();
    const queue = new IndexerQueue({ indexNote: fn, debounceMs: 30, bus, isExcluded: () => false });
    queue.enqueue("/blocker.md", 2);
    await tick(50);
    queue.enqueue("/sibling.md", 1);
    queue.enqueue("/upgrade.md", 2);
    await tick(10);
    queue.enqueue("/upgrade.md", 0);
    expect(queue.pendingCount(0)).toBe(1);
    expect(queue.pendingCount(2)).toBe(0);
    await tick(50);
    expect(calls).toEqual(["/blocker.md"]);
    release[0]();
    await tick(60);
    expect(calls).toEqual(["/blocker.md", "/upgrade.md", "/sibling.md"]);
    queue.dispose();
  });
});
