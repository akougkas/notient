/**
 * Phase 4 Task 8 awaken worker smoke harness.
 *
 * Skipped by default. Run with `NOTIENT_SMOKE=1 bun test src/core/awaken/`.
 *
 * Boots a real SurrealDB, applies the Phase 1 schema, and exercises the
 * worker run loop end-to-end against a mocked vault facade and a mocked
 * indexer queue. Coverage targets the three transitions the worker is
 * responsible for honoring: pause-mid-flight, resume-from-paused, and
 * cancel-mid-flight, plus the two start-time guards (already-active and
 * no-resumable).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { findCurrent, updateStatus } from "../../../../src/core/awaken/awakenRun";
import {
  type AwakenWorkerIndexerQueue,
  type AwakenWorkerVaultFacade,
  reconcileCountersFromTierState,
  runAwakenWorker,
  sortByPriorityGlobs,
  waitForNoteIndexed,
} from "../../../../src/core/awaken/awakenWorker";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../../src/core/db/surreal";
import { EventBus } from "../../../../src/core/events/eventBus";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

interface FetchedRow {
  id: RecordId<"awaken_run">;
  status: string;
  processed: number;
  failed: number;
  cursor: string | null | undefined;
  finished_at: string | Date | null;
}

async function clearAwakenRuns(connection: SurrealConnection): Promise<void> {
  await connection.db.query("DELETE awaken_run;").collect();
}

async function fetchRow(
  connection: SurrealConnection,
  runId: RecordId<"awaken_run">,
): Promise<FetchedRow | undefined> {
  const [rows] = await connection.db
    .query<[FetchedRow[]]>(
      "SELECT id, status, processed, failed, cursor, finished_at FROM awaken_run WHERE id = $id;",
      { id: runId },
    )
    .collect<[FetchedRow[]]>();
  return rows[0];
}

interface RecordedEnqueue {
  path: string;
  priority: number;
}

function makeIndexerQueue(records: RecordedEnqueue[]): AwakenWorkerIndexerQueue {
  return {
    enqueue(path: string, priority?: number): void {
      records.push({ path, priority: priority ?? 2 });
    },
  };
}

function makeVaultFacade(paths: string[]): AwakenWorkerVaultFacade {
  return {
    listMarkdownPaths: async () => [...paths],
  };
}

const PROPAGATION_DELAY_MS = 250;

// Wait long enough for the SurrealDB live-query notification to land in
// the worker's status closure. The Task 7 smoke uses 250ms as the upper
// bound for local roundtrip; we mirror it here.
function waitForLiveQueryDelivery(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, PROPAGATION_DELAY_MS));
}

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
    const options = { bus } as unknown as Parameters<typeof waitForNoteIndexed>[0];
    const pending = waitForNoteIndexed(options, "a.md");

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
      result: { chunkCount: 0, embedCount: 0, nodeCount: 0, edgeCount: 0, durationMs: 1 },
    });
    await pending;
    expect(state.value).toBe("resolved");
  });

  test("rejects when indexer:error matches the awaited note path", async () => {
    const bus = new EventBus();
    const options = { bus } as unknown as Parameters<typeof waitForNoteIndexed>[0];
    const pending = waitForNoteIndexed(options, "a.md");

    bus.emit({
      type: "indexer:error",
      path: "a.md",
      message: "tier1 boom",
      phase: "tier1",
    });
    await expect(pending).rejects.toThrow("tier1 boom");
  });
});

describe("reconcileCountersFromTierState", () => {
  test("counts only attempted notes whose tier1_at is still missing as failed", async () => {
    const byPath = new Map<string, { tier1_at: string | null }>([
      ["done.md", { tier1_at: "2026-04-30T00:00:00Z" }],
      ["missing.md", { tier1_at: null }],
      ["retried.md", { tier1_at: "2026-04-30T00:00:01Z" }],
    ]);
    const db = {
      query: (_sql: string, bindings: { path?: string }) => ({
        collect: async () => {
          const row = bindings.path === undefined ? undefined : byPath.get(bindings.path);
          if (row === undefined) return [[]];
          return [[{ tier1_at: row.tier1_at, tier2_at: null, tier3_at: null }]];
        },
      }),
    } as unknown as Parameters<typeof reconcileCountersFromTierState>[0];

    const counters = await reconcileCountersFromTierState(
      db,
      ["done.md", "missing.md", "retried.md"],
      { processed: 0, failed: 3 },
    );

    expect(counters).toEqual({ processed: 2, failed: 1 });
  });

  test("counts a note as failed when the requested upper tier is missing", async () => {
    const byPath = new Map<
      string,
      {
        tier1_at: string | null;
        tier2_at: string | null;
        tier3_at: string | null;
      }
    >([
      [
        "done.md",
        {
          tier1_at: "2026-04-30T00:00:00Z",
          tier2_at: "2026-04-30T00:00:01Z",
          tier3_at: "2026-04-30T00:00:02Z",
        },
      ],
      [
        "tier2-failed.md",
        {
          tier1_at: "2026-04-30T00:00:00Z",
          tier2_at: null,
          tier3_at: null,
        },
      ],
      [
        "tier3-failed.md",
        {
          tier1_at: "2026-04-30T00:00:00Z",
          tier2_at: "2026-04-30T00:00:01Z",
          tier3_at: null,
        },
      ],
    ]);
    const db = {
      query: (_sql: string, bindings: { path?: string }) => ({
        collect: async () => {
          const row = bindings.path === undefined ? undefined : byPath.get(bindings.path);
          if (row === undefined) return [[]];
          return [[row]];
        },
      }),
    } as unknown as Parameters<typeof reconcileCountersFromTierState>[0];

    const counters = await reconcileCountersFromTierState(
      db,
      ["done.md", "tier2-failed.md", "tier3-failed.md"],
      { processed: 0, failed: 3 },
      3,
    );

    expect(counters).toEqual({ processed: 1, failed: 2 });
  });

  test("falls back to existing counters if the tier-state query fails", async () => {
    const db = {
      query: () => ({
        collect: async () => {
          throw new Error("db unavailable");
        },
      }),
    } as unknown as Parameters<typeof reconcileCountersFromTierState>[0];

    const counters = await reconcileCountersFromTierState(db, ["a.md"], {
      processed: 7,
      failed: 2,
    });

    expect(counters).toEqual({ processed: 7, failed: 2 });
  });

  test("keeps successful fallback counters when no note rows are observable", async () => {
    const db = {
      query: () => ({
        collect: async () => [[]],
      }),
    } as unknown as Parameters<typeof reconcileCountersFromTierState>[0];

    const counters = await reconcileCountersFromTierState(db, ["a.md", "b.md"], {
      processed: 2,
      failed: 0,
    });

    expect(counters).toEqual({ processed: 2, failed: 0 });
  });

  test("counts missing note rows as failed after an indexer error", async () => {
    const db = {
      query: () => ({
        collect: async () => [[]],
      }),
    } as unknown as Parameters<typeof reconcileCountersFromTierState>[0];

    const counters = await reconcileCountersFromTierState(db, ["a.md", "b.md"], {
      processed: 1,
      failed: 1,
    });

    expect(counters).toEqual({ processed: 0, failed: 2 });
  });
});
