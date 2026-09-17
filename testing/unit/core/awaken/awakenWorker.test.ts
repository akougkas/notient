import { describe, expect, test } from "bun:test";
import { DateTime } from "surrealdb";
import {
  reconcileCountersFromTierState,
  runAwakenWorker,
  sliceAfterCursor,
  waitForNoteIndexed,
} from "../../../../src/core/awaken/awakenWorker";
import {
  createPriorityComparator,
  sortByPriorityGlobs,
} from "../../../../src/core/awaken/priorityGlob";
import { EventBus } from "../../../../src/core/events/eventBus";

describe("awaken worker module shape", () => {
  test("sortByPriorityGlobs orders by glob bucket then alphabetically", () => {
    const paths = [
      "projects/a.md",
      "daily/2024-04-29.md",
      "MOCs/Index.md",
      "projects/z.md",
      "daily/2024-04-28.md",
      "notes/general.md",
    ];
    const sorted = sortByPriorityGlobs(paths, ["daily/**", "MOCs/**"]);
    expect(sorted).toEqual([
      "daily/2024-04-28.md",
      "daily/2024-04-29.md",
      "MOCs/Index.md",
      "notes/general.md",
      "projects/a.md",
      "projects/z.md",
    ]);
  });

  test("sortByPriorityGlobs falls back to alphabetical when no globs provided", () => {
    const sorted = sortByPriorityGlobs(["b.md", "a.md", "c.md"], []);
    expect(sorted).toEqual(["a.md", "b.md", "c.md"]);
  });

  test("a missing cursor resumes at its strict priority-order successor", () => {
    const comparator = createPriorityComparator(["daily/**", "MOCs/**"]);
    const ordered = ["daily/a.md", "daily/c.md", "MOCs/a.md", "notes/a.md"];

    expect(sliceAfterCursor(ordered, "daily/b.md", comparator)).toEqual([
      "daily/c.md",
      "MOCs/a.md",
      "notes/a.md",
    ]);
    expect(sliceAfterCursor(ordered, "MOCs/z.md", comparator)).toEqual(["notes/a.md"]);
    expect(sliceAfterCursor(ordered, "z.md", comparator)).toEqual([]);
  });

  test("module exports the public worker surface", () => {
    expect(typeof runAwakenWorker).toBe("function");
    expect(typeof sortByPriorityGlobs).toBe("function");
  });
});

describe("waitForNoteIndexed listener scoping", () => {
  // Regression: bug #4 / bug #5. Awaken concurrency with the watcher
  // produced false `failed` increments because `indexer:error` events for
  // unrelated paths terminated the currently-waited promise. The fix
  // (carry `path` on every emit and filter the listener) means errors for
  // other notes must be ignored here.
  test("ignores indexer:error for a different note and resolves on note-indexed", async () => {
    const bus = new EventBus();
    const pending = waitForNoteIndexed(bus, "a.md", new AbortController().signal);

    const state: { value: "resolved" | "rejected" | "pending" } = { value: "pending" };
    pending.then(
      () => {
        state.value = "resolved";
      },
      () => {
        state.value = "rejected";
      },
    );

    // Emit an error for a different note. The wait must NOT settle.
    bus.emit({
      type: "indexer:error",
      path: "b.md",
      message: "transaction conflict on b.md",
      phase: "tier1",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.value).toBe("pending");

    // Now emit the terminal event for the awaited note. The wait resolves.
    bus.emit({
      type: "indexer:note-indexed",
      path: "a.md",
      result: {
        chunkCount: 0,
        embedCount: 0,
        durationMs: 1,
        llmCalls: 0,
        extractionWindows: 0,
      },
    });
    await pending;
    expect(state.value).toBe("resolved");
  });

  test("rejects when indexer:error matches the awaited note path", async () => {
    const bus = new EventBus();
    const pending = waitForNoteIndexed(bus, "a.md", new AbortController().signal);

    bus.emit({
      type: "indexer:error",
      path: "a.md",
      message: "tier1 boom",
      phase: "tier1",
    });
    await expect(pending).rejects.toThrow("tier1 boom");
  });

  test("shutdown cancellation rejects a held note wait and detaches its listeners", async () => {
    const bus = new EventBus();
    const controller = new AbortController();
    const pending = waitForNoteIndexed(bus, "held.md", controller.signal);

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    // These terminal events arrive after cancellation in the production
    // shutdown race. The removed listeners must not revive the settled wait.
    bus.emit({
      type: "indexer:note-indexed",
      path: "held.md",
      result: {
        chunkCount: 0,
        embedCount: 0,
        durationMs: 1,
        llmCalls: 0,
        extractionWindows: 0,
      },
    });
    bus.emit({ type: "indexer:error", path: "held.md", message: "late" });
    await Promise.resolve();
  });

  test("does not accept tier progress as canonical note completion", async () => {
    const bus = new EventBus();
    const pending = waitForNoteIndexed(bus, "a.md", new AbortController().signal);
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });

    bus.emit({ type: "indexer:tier3-done", path: "a.md" });
    await Promise.resolve();
    expect(settled).toBe(false);

    bus.emit({
      type: "indexer:note-indexed",
      path: "a.md",
      result: {
        chunkCount: 0,
        embedCount: 0,
        durationMs: 1,
        llmCalls: 0,
        extractionWindows: 0,
      },
    });
    await pending;
    expect(settled).toBe(true);
  });
});

describe("reconcileCountersFromTierState", () => {
  const TIER_1 = new DateTime("2026-08-29T00:00:00Z");
  const TIER_2 = new DateTime("2026-08-29T00:00:01Z");
  const TIER_3 = new DateTime("2026-08-29T00:00:02Z");

  function mockDb(result: unknown): Parameters<typeof reconcileCountersFromTierState>[0] {
    return {
      query: () => ({ collect: async () => result }),
    } as unknown as Parameters<typeof reconcileCountersFromTierState>[0];
  }

  test("reads every attempted path in one batched query", async () => {
    const calls: Array<{ sql: string; paths: string[] }> = [];
    const db = {
      query: (sql: string, bindings: { paths: string[] }) => ({
        collect: async () => {
          calls.push({ sql, paths: bindings.paths });
          return [
            bindings.paths.map((path) => ({
              path,
              tier1_at: TIER_1,
            })),
          ];
        },
      }),
    } as unknown as Parameters<typeof reconcileCountersFromTierState>[0];

    const counters = await reconcileCountersFromTierState(
      db,
      ["a.md", "b.md", "c.md"].map((path) => ({ path, terminal: "indexed" as const })),
      1,
    );

    expect(counters).toEqual({ processed: 3, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("path IN $paths");
    expect(calls[0]?.paths).toEqual(["a.md", "b.md", "c.md"]);
  });

  test("surfaces a successful terminal event without its persisted tier stamp", async () => {
    const db = mockDb([[{ path: "done.md", tier1_at: TIER_1 }]]);
    await expect(
      reconcileCountersFromTierState(
        db,
        [
          { path: "done.md", terminal: "indexed" },
          { path: "missing.md", terminal: "indexed" },
        ],
        1,
      ),
    ).rejects.toThrow("without persisted Tier 1 completion");
  });

  test("requires the requested upper tier for every successful outcome", async () => {
    const db = mockDb([
      [
        { path: "done.md", tier1_at: TIER_1, tier2_at: TIER_2, tier3_at: TIER_3 },
        { path: "tier3-missing.md", tier1_at: TIER_1, tier2_at: TIER_2 },
      ],
    ]);
    await expect(
      reconcileCountersFromTierState(
        db,
        [
          { path: "done.md", terminal: "indexed" },
          { path: "tier3-missing.md", terminal: "indexed" },
        ],
        3,
      ),
    ).rejects.toThrow("without persisted Tier 3 completion");
  });

  test("counts explicit terminal failures even when no note row was created", async () => {
    const db = mockDb([[{ path: "done.md", tier1_at: TIER_1 }]]);
    const counters = await reconcileCountersFromTierState(
      db,
      [
        { path: "done.md", terminal: "indexed" },
        { path: "failed-before-tier1.md", terminal: "failed" },
      ],
      1,
    );
    expect(counters).toEqual({ processed: 1, failed: 1 });
  });

  test("an indexer failure remains failed even if an old tier stamp exists", async () => {
    const db = mockDb([[{ path: "stale.md", tier1_at: TIER_1 }]]);
    const counters = await reconcileCountersFromTierState(
      db,
      [{ path: "stale.md", terminal: "failed" }],
      1,
    );
    expect(counters).toEqual({ processed: 0, failed: 1 });
  });

  test("surfaces the tier-state query error instead of returning event counters", async () => {
    const db = {
      query: () => ({
        collect: async () => {
          throw new Error("db unavailable");
        },
      }),
    } as unknown as Parameters<typeof reconcileCountersFromTierState>[0];

    await expect(
      reconcileCountersFromTierState(db, [{ path: "a.md", terminal: "indexed" }], 1),
    ).rejects.toThrow("db unavailable");
  });

  for (const [label, envelope] of [
    ["empty", []],
    ["multiple statements", [[], []]],
    ["non-array statement", [{ path: "a.md" }]],
  ] as const) {
    test(`rejects ${label} query envelope`, async () => {
      await expect(
        reconcileCountersFromTierState(
          mockDb(envelope),
          [{ path: "a.md", terminal: "indexed" }],
          1,
        ),
      ).rejects.toThrow("invalid statement envelope");
    });
  }

  test.each([
    [42, "row must be an object"],
    [{ path: 42, tier1_at: TIER_1 }, "canonical vault-relative Markdown path"],
    [{ path: "../a.md", tier1_at: TIER_1 }, "canonical vault-relative Markdown path"],
    [{ path: "a.md", tier1_at: "2026-08-29T00:00:00Z" }, "native SurrealDB datetime"],
    [{ path: "a.md", tier1_at: null }, "null instead of SurrealDB NONE"],
    [{ path: "a.md", tier2_at: TIER_2 }, "tier2_at exists without tier1_at"],
    [{ path: "a.md", tier1_at: TIER_2, tier2_at: TIER_1 }, "tier2_at precedes tier1_at"],
    [{ path: "a.md", tier1_at: TIER_1, surprise: true }, "unsupported field"],
  ])("rejects corrupt tier-state row %#", async (row, message) => {
    await expect(
      reconcileCountersFromTierState(mockDb([[row]]), [{ path: "a.md", terminal: "indexed" }], 1),
    ).rejects.toThrow(String(message));
  });

  test("rejects duplicate and unrequested query rows", async () => {
    await expect(
      reconcileCountersFromTierState(
        mockDb([
          [
            { path: "a.md", tier1_at: TIER_1 },
            { path: "a.md", tier1_at: TIER_1 },
          ],
        ]),
        [{ path: "a.md", terminal: "indexed" }],
        1,
      ),
    ).rejects.toThrow("duplicate path");

    await expect(
      reconcileCountersFromTierState(
        mockDb([[{ path: "other.md", tier1_at: TIER_1 }]]),
        [{ path: "a.md", terminal: "indexed" }],
        1,
      ),
    ).rejects.toThrow("unrequested path");
  });

  test("rejects malformed and duplicate terminal outcomes before querying", async () => {
    const db = mockDb([[]]);
    await expect(
      reconcileCountersFromTierState(db, [{ path: "../a.md", terminal: "indexed" }], 1),
    ).rejects.toThrow("canonical vault-relative Markdown path");
    await expect(
      reconcileCountersFromTierState(
        db,
        [
          { path: "a.md", terminal: "indexed" },
          { path: "a.md", terminal: "failed" },
        ],
        1,
      ),
    ).rejects.toThrow("duplicate outcome path");
  });

  test("an empty reconciliation is an exact zero without a database query", async () => {
    let queried = false;
    const db = {
      query: () => {
        queried = true;
        throw new Error("must not query");
      },
    } as unknown as Parameters<typeof reconcileCountersFromTierState>[0];
    await expect(reconcileCountersFromTierState(db, [], 3)).resolves.toEqual({
      processed: 0,
      failed: 0,
    });
    expect(queried).toBe(false);
  });
});
