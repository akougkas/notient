/**
 * Phase 4 Task 11 SearchPipeline smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/core/search/`.
 *
 * Boots a real SurrealDB, applies the schema, and exercises the pipeline's
 * Quick / Balanced / Deep modes against actual SurrealDB-backed strategies.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect, replaceChunks, upsertNoteByPath } from "../../../../src/core/db/surreal";
import type { ChatMessage, ChatOptions, JsonSchema, LLMProvider } from "../../../../src/core/llm/provider";
import { Reranker } from "../../../../src/core/search/reranker";
import { SearchPipeline } from "../../../../src/core/search/searchPipeline";
import type { SearchEvent } from "../../../../src/core/search/types";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

const VECTOR_DIM = 768;
const EMBED_MODEL = "text-embedding-nomic-embed-text-v2-moe";

function unitVector(...nonZero: Array<{ index: number; value: number }>): number[] {
  const vector = new Array<number>(VECTOR_DIM).fill(0);
  for (const entry of nonZero) {
    vector[entry.index] = entry.value;
  }
  return vector;
}

function fakeProvider(ranking: string[]): LLMProvider {
  return {
    isAvailable: async () => true,
    chat: async () => "",
    chatStream: async function* () {
      yield "";
    },
    embed: async () => [],
    chatJson: async <T>(
      _messages: ChatMessage[],
      _options: ChatOptions,
      _schema: JsonSchema,
    ): Promise<T> => ({ ranking }) as T,
  };
}

async function seedNote(
  connection: SurrealConnection,
  notePath: string,
  text: string,
  vector: number[],
): Promise<void> {
  const noteId = await upsertNoteByPath(connection.db, {
    path: notePath,
    sha: `sha-${notePath}`,
    wordCount: 1,
  });
  await replaceChunks(connection.db, noteId, [
    {
      ord: 0,
      text,
      tokenEstimate: 4,
      vector,
      embedModel: EMBED_MODEL,
    },
  ]);
}

async function clearGraph(connection: SurrealConnection): Promise<void> {
  await connection.db.query("DELETE chunk;").collect();
  await connection.db.query("DELETE note;").collect();
}

async function collect(iterable: AsyncIterable<SearchEvent>): Promise<SearchEvent[]> {
  const events: SearchEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function buildPipeline(connection: SurrealConnection, ranking: string[]): SearchPipeline {
  const provider = fakeProvider(ranking);
  const reranker = new Reranker({ provider, model: "rerank" });
  return new SearchPipeline({
    db: connection.db,
    reranker,
    embed: async () => Float32Array.from(unitVector({ index: 0, value: 1 })),
    provider,
    reasoningModel: "reasoning",
    settings: () => ({
      balanced: { topK: 10, rerankTopN: 5 },
      deep: { graphExpansionDepth: 1, synthesisEnabled: false },
    }),
    now: () => 100,
  });
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] SearchPipeline", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase4-pipeline-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-pipeline-smoke-"));
    handle = await startSurreal({
      dataDir: path.join(tempDir, "data"),
      secret,
      portFile: path.join(tempDir, "port"),
      pidFile: path.join(tempDir, "pid"),
      logLevel: "warn",
    });
    connection = await connect({
      url: handle.url,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    await applySchema(connection.db, secret);
  });

  afterAll(async () => {
    if (connection !== undefined) {
      await connection.close().catch(() => {});
    }
    if (handle !== undefined) {
      await handle.stop().catch(() => {});
    }
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("Quick mode emits retrieving, hits, then done", async () => {
    await clearGraph(connection);
    await seedNote(
      connection,
      "notes/Graph.md",
      "Graph reasoning is interesting.",
      unitVector({ index: 0, value: 1 }),
    );
    const pipeline = buildPipeline(connection, ["a1"]);
    const events = await collect(
      pipeline.run({ query: "graph", mode: "quick" }, new AbortController().signal),
    );
    expect(events[0]).toEqual({ type: "search:retrieving", mode: "quick" });
    expect(events[1].type).toBe("search:hits");
    expect(events[events.length - 1].type).toBe("search:done");
    if (events[events.length - 1].type === "search:done") {
      const done = events[events.length - 1] as Extract<SearchEvent, { type: "search:done" }>;
      expect(done.result.mode).toBe("quick");
      expect(done.result.hits.length).toBeGreaterThan(0);
    }
  });

  test("Balanced mode dispatches through the SurrealDB kNN reader", async () => {
    await clearGraph(connection);
    await seedNote(connection, "notes/a.md", "alpha snippet", unitVector({ index: 0, value: 1 }));
    await seedNote(connection, "notes/b.md", "beta snippet", unitVector({ index: 1, value: 1 }));
    const pipeline = buildPipeline(connection, ["unused"]);
    const events = await collect(
      pipeline.run({ query: "alpha", mode: "balanced" }, new AbortController().signal),
    );
    const hits = events.find((event) => event.type === "search:hits");
    expect(hits?.type).toBe("search:hits");
    if (hits?.type === "search:hits") {
      expect(hits.hits.length).toBeGreaterThan(0);
      expect(hits.hits.map((hit) => hit.notePath)).toContain("notes/a.md");
    }
  });

  test("Deep mode reaches search:done with synthesis disabled", async () => {
    await clearGraph(connection);
    await seedNote(connection, "notes/a.md", "alpha snippet", unitVector({ index: 0, value: 1 }));
    const pipeline = buildPipeline(connection, ["unused"]);
    const events = await collect(
      pipeline.run({ query: "alpha", mode: "deep" }, new AbortController().signal),
    );
    expect(events[0]).toEqual({ type: "search:retrieving", mode: "deep" });
    const done = events.find((event) => event.type === "search:done");
    expect(done?.type).toBe("search:done");
    if (done?.type === "search:done") {
      expect(done.result.mode).toBe("deep");
      expect(done.result.synthesis).toBeNull();
    }
  });

  test("aborted signal short-circuits to search:error", async () => {
    const pipeline = buildPipeline(connection, []);
    const controller = new AbortController();
    controller.abort();
    const events = await collect(pipeline.run({ query: "x", mode: "quick" }, controller.signal));
    expect(events[0].type).toBe("search:retrieving");
    expect(events[1].type).toBe("search:error");
  });

  test("balanced mode aborted during reranker propagates to chatJson and ends with error", async () => {
    await clearGraph(connection);
    await seedNote(connection, "notes/a.md", "alpha snippet", unitVector({ index: 0, value: 1 }));
    await seedNote(connection, "notes/b.md", "beta snippet", unitVector({ index: 1, value: 1 }));

    const controller = new AbortController();
    let observedSignalAborted = false;
    const slowProvider: LLMProvider = {
      isAvailable: async () => true,
      chat: async () => "",
      chatStream: async function* () {
        yield "";
      },
      embed: async () => [],
      chatJson: async <T>(
        _messages: ChatMessage[],
        options: ChatOptions,
        _schema: JsonSchema,
      ): Promise<T> => {
        return await new Promise<T>((_resolve, reject) => {
          const signal = options.signal;
          if (!signal) {
            reject(new Error("missing signal in chatJson options"));
            return;
          }
          const onAbort = (): void => {
            observedSignalAborted = true;
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
          setTimeout(() => reject(new Error("never reached")), 1000);
        });
      },
    };
    const reranker = new Reranker({ provider: slowProvider, model: "rerank" });
    const pipeline = new SearchPipeline({
      db: connection.db,
      reranker,
      embed: async () => Float32Array.from(unitVector({ index: 0, value: 1 })),
      provider: slowProvider,
      reasoningModel: "reasoning",
      settings: () => ({
        balanced: { topK: 10, rerankTopN: 5 },
        deep: { graphExpansionDepth: 1, synthesisEnabled: false },
      }),
      now: () => 100,
    });

    const iterator = pipeline
      .run({ query: "alpha", mode: "balanced" }, controller.signal)
      [Symbol.asyncIterator]();
    const collected: SearchEvent[] = [];
    const first = await iterator.next();
    if (!first.done) collected.push(first.value);
    queueMicrotask(() => controller.abort());
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      collected.push(next.value);
    }
    expect(observedSignalAborted).toBe(true);
    const error = collected.find((event) => event.type === "search:error");
    expect(error).toBeDefined();
    if (error && error.type === "search:error") {
      expect(error.message.toLowerCase()).toContain("abort");
    }
    expect(collected.find((event) => event.type === "search:done")).toBeUndefined();
  });

  test("durationMs uses the injected clock", async () => {
    await clearGraph(connection);
    await seedNote(
      connection,
      "notes/Graph.md",
      "graph reasoning",
      unitVector({ index: 0, value: 1 }),
    );
    const pipeline = buildPipeline(connection, []);
    const events = await collect(
      pipeline.run({ query: "graph", mode: "quick" }, new AbortController().signal),
    );
    const done = events.find((event) => event.type === "search:done");
    expect(done?.type).toBe("search:done");
    if (done?.type === "search:done") {
      expect(done.result.durationMs).toBe(0);
    }
  });
});
