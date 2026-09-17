import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import type { AgentRunCapability } from "../../../../src/core/coordinator/types";
import { EventBus } from "../../../../src/core/events/eventBus";
import {
  type EmbeddingRepairResult,
  runEmbeddingRepair,
} from "../../../../src/core/indexer/embeddingRepair";
import { IndexerQueue } from "../../../../src/core/indexer/indexerQueue";

interface NoteState {
  path: string;
  pending: boolean;
  tier2Done: boolean;
}

function fakeDb(notes: NoteState[]): Surreal {
  const query = (sql: string, bindings?: { path?: string }): unknown => {
    let reply: unknown[];
    if (sql.includes("SELECT path, tier2_at FROM note")) {
      reply = [
        notes
          .filter((note) => note.pending)
          .sort((left, right) => left.path.localeCompare(right.path))
          .map((note) => ({
            path: note.path,
            tier2_at: note.tier2Done ? new Date("2026-08-29T12:00:00Z") : null,
          })),
      ];
    } else if (sql.includes("SET linker_refresh_pending = false")) {
      const note = notes.find((candidate) => candidate.path === bindings?.path);
      if (note?.tier2Done === true) note.pending = false;
      reply = [];
    } else {
      throw new Error(`unexpected query: ${sql}`);
    }
    return Object.assign(Promise.resolve(reply), {
      collect: () => Promise.resolve(reply),
    });
  };
  return { query } as unknown as Surreal;
}

function noteByPath(notes: NoteState[], path: string): NoteState {
  const note = notes.find((candidate) => candidate.path === path);
  if (note === undefined) throw new Error(`missing test note ${path}`);
  return note;
}

function createQueue(options: {
  notes: NoteState[];
  order: string[];
  failTier2?: ReadonlySet<string>;
  onExtractor: () => void;
}): IndexerQueue {
  return new IndexerQueue({
    bus: new EventBus(),
    debounceMs: 0,
    indexNote: async (path, context) => {
      options.order.push(`tier2:${path}`);
      expect(context.tierFilter).toEqual([2]);
      // Mirrors the production upper-bound contract: only a missing/wider
      // filter could reach Tier 3 and its extractor.
      if (context.tierFilter === undefined || Math.max(...context.tierFilter) >= 3) {
        options.onExtractor();
      }
      if (options.failTier2?.has(path) !== true) {
        noteByPath(options.notes, path).tier2Done = true;
      }
    },

    isExcluded: () => false,
  });
}

function runLinkerThat(
  execute: AgentRunCapability<"linker">["execute"],
): AgentRunCapability<"linker"> {
  return { agentName: "linker", execute };
}

describe("runEmbeddingRepair", () => {
  test("drains every Tier 2 rebuild before any linker-only refresh and never calls extractor", async () => {
    const notes: NoteState[] = [
      { path: "b.md", pending: true, tier2Done: false },
      { path: "a.md", pending: true, tier2Done: false },
    ];
    const order: string[] = [];
    let extractorCalls = 0;
    const queue = createQueue({
      notes,
      order,
      onExtractor: () => {
        extractorCalls += 1;
      },
    });
    const runLinker = runLinkerThat(async (request) => {
      expect(request.trigger).toBe("embedding-repair");
      order.push(`linker:${request.notePath}`);
      return { proposals: 0 };
    });

    const result = await runEmbeddingRepair({
      db: fakeDb(notes),
      indexer: queue,
      runLinker,
      log: () => {},
    });
    queue.dispose();

    expect(order).toEqual(["tier2:a.md", "tier2:b.md", "linker:a.md", "linker:b.md"]);
    expect(extractorCalls).toBe(0);
    expect(notes.map((note) => note.pending)).toEqual([false, false]);
    expect(result).toEqual({
      pendingAtStart: 2,
      tier2Incomplete: [],
      linkerRefreshed: 2,
      linkerFailed: [],
      aborted: false,
    });
  });

  test("keeps all flags durable and skips the entire linker phase when any Tier 2 rebuild fails", async () => {
    const notes: NoteState[] = [
      { path: "a.md", pending: true, tier2Done: false },
      { path: "b.md", pending: true, tier2Done: false },
    ];
    const order: string[] = [];
    let extractorCalls = 0;
    const queue = createQueue({
      notes,
      order,
      failTier2: new Set(["b.md"]),
      onExtractor: () => {
        extractorCalls += 1;
      },
    });
    let linkerCalls = 0;

    const result = await runEmbeddingRepair({
      db: fakeDb(notes),
      indexer: queue,
      runLinker: runLinkerThat(async () => {
        linkerCalls += 1;
        return { proposals: 0 };
      }),
      log: () => {},
    });
    queue.dispose();

    expect(order).toEqual(["tier2:a.md", "tier2:b.md"]);
    expect(result.tier2Incomplete).toEqual(["b.md"]);
    expect(linkerCalls).toBe(0);
    expect(extractorCalls).toBe(0);
    expect(notes.map((note) => note.pending)).toEqual([true, true]);
  });

  test("clears each flag only after linker success and resumes a failed note on the next boot", async () => {
    const notes: NoteState[] = [
      { path: "a.md", pending: true, tier2Done: true },
      { path: "b.md", pending: true, tier2Done: true },
    ];
    const firstOrder: string[] = [];
    const firstQueue = createQueue({
      notes,
      order: firstOrder,
      onExtractor: () => {
        throw new Error("extractor must not run during embedding repair");
      },
    });
    const firstResult = await runEmbeddingRepair({
      db: fakeDb(notes),
      indexer: firstQueue,
      runLinker: runLinkerThat(async (request) => {
        firstOrder.push(`linker:${request.notePath}`);
        if (request.notePath === "b.md") throw new Error("linker unavailable");
        return { proposals: 0 };
      }),
      log: () => {},
    });
    firstQueue.dispose();

    expect(firstOrder).toEqual(["tier2:a.md", "tier2:b.md", "linker:a.md", "linker:b.md"]);
    expect(firstResult.linkerFailed).toEqual(["b.md"]);
    expect(noteByPath(notes, "a.md").pending).toBe(false);
    expect(noteByPath(notes, "b.md").pending).toBe(true);

    const resumedOrder: string[] = [];
    const resumedQueue = createQueue({
      notes,
      order: resumedOrder,
      onExtractor: () => {
        throw new Error("extractor must not run during resumed embedding repair");
      },
    });
    const resumedResult = await runEmbeddingRepair({
      db: fakeDb(notes),
      indexer: resumedQueue,
      runLinker: runLinkerThat(async (request) => {
        resumedOrder.push(`linker:${request.notePath}`);
        return { proposals: 0 };
      }),
      log: () => {},
    });
    resumedQueue.dispose();

    expect(resumedOrder).toEqual(["tier2:b.md", "linker:b.md"]);
    expect(resumedResult.linkerRefreshed).toBe(1);
    expect(resumedResult.linkerFailed).toEqual([]);
    expect(noteByPath(notes, "b.md").pending).toBe(false);
  });

  test("shutdown abort leaves the current and remaining linker flags pending", async () => {
    const notes: NoteState[] = [
      { path: "a.md", pending: true, tier2Done: true },
      { path: "b.md", pending: true, tier2Done: true },
    ];
    const controller = new AbortController();
    const queue = createQueue({
      notes,
      order: [],
      onExtractor: () => {
        throw new Error("extractor must not run during embedding repair");
      },
    });

    const result: EmbeddingRepairResult = await runEmbeddingRepair({
      db: fakeDb(notes),
      indexer: queue,
      runLinker: runLinkerThat(async () => {
        controller.abort();
        throw new DOMException("daemon shutting down", "AbortError");
      }),
      signal: controller.signal,
      log: () => {},
    });
    queue.dispose();

    expect(result.aborted).toBe(true);
    expect(result.linkerRefreshed).toBe(0);
    expect(notes.map((note) => note.pending)).toEqual([true, true]);
  });
});
