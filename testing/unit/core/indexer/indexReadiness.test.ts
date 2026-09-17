import { describe, expect, test } from "bun:test";
import { searchCoverage, unknownIndexingReadiness } from "../../../../src/api/indexing";
import { EventBus } from "../../../../src/core/events/eventBus";
import { IndexReadiness } from "../../../../src/core/indexer/indexReadiness";

const A = "a".repeat(64);
const B = "b".repeat(64);
function fixture() {
  const bus = new EventBus();
  return { bus, readiness: new IndexReadiness(bus, (path) => path.startsWith("Excluded/")) };
}

describe("structural index readiness", () => {
  test("an explicit rebuild invalidates receipts and a late commit cannot resurrect a removed note", () => {
    const { readiness } = fixture();
    readiness.finishScan(new Map([["a.md", A]]), new Map([["a.md", A]]));
    readiness.invalidate();
    expect(readiness.snapshot()).toMatchObject({ state: "indexing", current: 0, pending: 1 });
    readiness.removed("a.md");
    readiness.committed("a.md", A);
    readiness.failed("a.md", "late attempt failed after removal");
    expect(readiness.snapshot()).toMatchObject({ state: "current", total: 0 });
    readiness.dispose();
  });
  test("unknown inventory stays scanning; only matching durable revisions count as current", () => {
    const { readiness } = fixture();
    expect(readiness.snapshot()).toMatchObject({ state: "scanning", total: null });
    readiness.finishScan(
      new Map([
        ["a.md", A],
        ["b.md", B],
        ["Excluded/a.md", A],
      ]),
      new Map([
        ["a.md", A],
        ["b.md", A],
      ]),
    );
    expect(readiness.snapshot()).toMatchObject({
      state: "indexing",
      total: 2,
      current: 1,
      pending: 1,
      failed: 0,
    });
    readiness.committed("b.md", B);
    expect(readiness.snapshot()).toMatchObject({ state: "current", current: 2, pending: 0 });
    readiness.dispose();
  });

  test("failure survives a drained queue and a retry until the exact source commits", () => {
    const { bus, readiness } = fixture();
    readiness.finishScan(new Map([["a.md", A]]), new Map());
    bus.emit({
      type: "indexer:error",
      path: "a.md",
      phase: "tier1",
      message: "transaction failed",
      sourceRevision: A,
    });
    expect(readiness.snapshot()).toMatchObject({
      state: "failed",
      current: 0,
      failed: 1,
      pending: 0,
      failures: [{ path: "a.md", message: "transaction failed" }],
    });
    readiness.observe("a.md", A);
    expect(readiness.snapshot().failed).toBe(1);
    bus.emit({ type: "indexer:tier1-done", path: "a.md", bodySha: A });
    expect(readiness.snapshot()).toMatchObject({
      state: "current",
      current: 1,
      failed: 0,
      failures: [],
    });
    readiness.dispose();
  });

  test("a stale completion or failure cannot mark a newer file current", () => {
    const { bus, readiness } = fixture();
    readiness.finishScan(new Map([["a.md", A]]), new Map());
    readiness.observe("a.md", B);
    readiness.committed("a.md", A);
    bus.emit({
      type: "indexer:error",
      path: "a.md",
      phase: "tier1",
      sourceRevision: A,
      message: "old request failed",
    });
    expect(readiness.snapshot()).toMatchObject({
      state: "indexing",
      current: 0,
      pending: 1,
      failed: 0,
    });
    readiness.committed("a.md", B);
    expect(readiness.snapshot().state).toBe("current");
    readiness.dispose();
  });

  test("reconciliation does not overwrite additions, removals, edits or commits observed during its scan", () => {
    const { readiness } = fixture();
    readiness.beginScan();
    readiness.observe("a.md", B);
    readiness.removed("removed.md");
    readiness.observe("new.md", A);
    readiness.committed("new.md", A);
    readiness.committed("b.md", B);
    readiness.finishScan(
      new Map([
        ["a.md", A],
        ["removed.md", A],
        ["b.md", B],
      ]),
      new Map([
        ["a.md", A],
        ["b.md", A],
      ]),
    );
    expect(readiness.snapshot()).toMatchObject({ total: 3, current: 2, pending: 1 });
    readiness.dispose();
  });

  test("embedding and extraction failures do not invalidate a successful lexical index", () => {
    const { bus, readiness } = fixture();
    readiness.finishScan(new Map([["a.md", A]]), new Map([["a.md", A]]));
    bus.emit({ type: "indexer:error", path: "a.md", phase: "tier2", message: "model unavailable" });
    expect(readiness.snapshot()).toMatchObject({ state: "current", failed: 0 });
    readiness.pause();
    expect(readiness.snapshot().state).toBe("paused");
    readiness.dispose();
  });

  test("search coverage is incomplete if a note changes and finishes indexing during the query", () => {
    const { readiness } = fixture();
    readiness.finishScan(new Map([["a.md", A]]), new Map([["a.md", A]]));
    const before = readiness.snapshot();
    expect(searchCoverage(before, before).state).toBe("current");
    readiness.observe("a.md", B);
    readiness.committed("a.md", B);
    expect(searchCoverage(before, readiness.snapshot())).toMatchObject({ state: "incomplete" });
    expect(searchCoverage(unknownIndexingReadiness(), before).state).toBe("unknown");
    readiness.dispose();
  });
});
