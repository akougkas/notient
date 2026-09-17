import { describe, expect, test } from "bun:test";
import { RecordId, type Surreal } from "surrealdb";
import { ReasoningScheduler } from "../../../../src/core/coordinator/reasoningScheduler";
import type { AgentRunCapability } from "../../../../src/core/coordinator/types";
import { Extractor } from "../../../../src/core/indexer/extractor";
import { runTier3 } from "../../../../src/core/indexer/tier3";
import type { LLMProvider } from "../../../../src/core/llm/provider";

function partialProvider(): { provider: LLMProvider; calls: () => number } {
  let callCount = 0;
  return {
    provider: {
      isAvailable: async () => true,
      chat: async () => "",
      chatStream: async function* () {
        yield "";
      },
      chatJson: async <T>() => {
        callCount += 1;
        if (callCount === 2) throw new Error("second window failed");
        return { entities: [], claims: [], questions: [] } as T;
      },
      embed: async () => [],
    },
    calls: () => callCount,
  };
}

describe("runTier3 partial extraction", () => {
  test("passes exact successful-window coverage to relation persistence", async () => {
    const noteId = new RecordId("note", "partial-tier3");
    const chunk0 = new RecordId("chunk", "c0");
    const chunk1 = new RecordId("chunk", "c1");
    const conceptA = new RecordId("concept", "a");
    const conceptB = new RecordId("concept", "b");
    const edgeA = new RecordId("mentions", "edge-a");
    const edgeB = new RecordId("mentions", "edge-b");
    const queries: Array<{ sql: string; bindings?: Record<string, unknown> }> = [];
    const db = {
      query: (sql: string, bindings?: Record<string, unknown>) => ({
        collect: async () => {
          queries.push({ sql, bindings });
          if (sql === "SELECT id FROM note WHERE path = $path LIMIT 1;") {
            return [[{ id: noteId }]];
          }
          if (sql.startsWith("SELECT id, out, evidence FROM mentions")) {
            return [
              [
                { id: edgeA, out: conceptA, evidence: [chunk0] },
                { id: edgeB, out: conceptB, evidence: [chunk1] },
              ],
              [],
              [],
            ];
          }
          return [[]];
        },
      }),
    } as unknown as Surreal;
    const runLinker: AgentRunCapability<"linker"> = {
      agentName: "linker",
      execute: async () => ({ proposals: 0 }),
    };
    const partial = partialProvider();
    const extractor = new Extractor(partial.provider, {
      model: "test",
      scheduler: new ReasoningScheduler({ maxConcurrent: 1 }),
      concurrency: 1,
      windowTokens: 1,
    });

    await expect(
      runTier3(db, {
        notePath: "partial.md",
        chunks: [
          { id: chunk0, ord: 0, text: "first", vector: [] },
          { id: chunk1, ord: 1, text: "second", vector: [] },
        ],
        extractor,
        runLinker,
      }),
    ).rejects.toThrow("1 of 2 window extractions failed");
    expect(partial.calls()).toBe(2);

    const transaction = queries.find((query) => query.sql.startsWith("BEGIN TRANSACTION;"));
    expect(transaction).toBeDefined();
    const transactionBindings = Object.entries(transaction?.bindings ?? {});
    const isBoundAs = (suffix: string, id: RecordId): boolean =>
      transactionBindings.some(
        ([name, value]) => name.endsWith(suffix) && String(value) === id.toString(),
      );

    // The empty successful c0 window removes A; c1's failed-window evidence
    // keeps B. This can happen only if Tier3 forwards c0—not merely evidence
    // emitted by the successful extraction—to the writer's partial coverage.
    expect(isBoundAs("_deleteId", edgeA)).toBe(true);
    expect(isBoundAs("_deleteId", edgeB)).toBe(false);
    expect(isBoundAs("_keeperId", edgeB)).toBe(true);
    expect(queries.some((query) => query.sql.includes("SET tier3_at"))).toBe(false);
  });

  test("rejects an extractor result without canonical execution statistics", async () => {
    const noteId = new RecordId("note", "invalid-stats");
    const db = {
      query: (sql: string) => ({
        collect: async () => {
          if (sql === "SELECT id FROM note WHERE path = $path LIMIT 1;") {
            return [[{ id: noteId }]];
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      }),
    } as unknown as Surreal;
    const extractor = {
      extract: async () => ({ entities: [], claims: [], questions: [] }),
    } as unknown as Extractor;
    const runLinker: AgentRunCapability<"linker"> = {
      agentName: "linker",
      execute: async () => ({ proposals: 0 }),
    };

    await expect(
      runTier3(db, {
        notePath: "invalid-stats.md",
        chunks: [],
        extractor,
        runLinker,
      }),
    ).rejects.toThrow("extractor returned invalid execution statistics");
  });
});
