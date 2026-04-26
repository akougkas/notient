import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import { InMemoryVectorIndex } from "../indexer/vectorIndex";
import type { ChatMessage, ChatOptions, JsonSchema, LLMProvider } from "../llm/provider";
import { Reranker } from "./reranker";
import { SearchPipeline } from "./searchPipeline";
import type { SearchEvent } from "./types";

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

async function setup(): Promise<{
  db: Database;
  index: InMemoryVectorIndex;
  pipeline: SearchPipeline;
}> {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
  await db.init();
  const index = new InMemoryVectorIndex();
  await index.init(2);

  const provider = fakeProvider(["a1"]);
  const reranker = new Reranker({ provider, model: "rerank" });
  const pipeline = new SearchPipeline({
    db,
    vectorIndex: index,
    reranker,
    embed: async () => Float32Array.from([1, 0]),
    provider,
    reasoningModel: "reasoning",
    settings: () => ({
      balanced: { topK: 10, rerankTopN: 5 },
      deep: { graphExpansionDepth: 1, synthesisEnabled: false },
    }),
    now: () => 100,
  });
  return { db, index, pipeline };
}

function seed(db: Database, path: string, chunkId: string, text: string): void {
  db.run("INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)", [
    path,
    "sha",
    100,
    1,
    1,
  ]);
  db.run("INSERT INTO chunks (id, note_path, ord, text, sha) VALUES (?,?,?,?,?);", [
    chunkId,
    path,
    0,
    text,
    `sha-${chunkId}`,
  ]);
}

async function collect(iterable: AsyncIterable<SearchEvent>): Promise<SearchEvent[]> {
  const events: SearchEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("SearchPipeline", () => {
  test("Quick mode emits retrieving, hits, then done", async () => {
    const { db, pipeline } = await setup();
    seed(db, "/notes/Graph.md", "c1", "Graph reasoning is interesting.");
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

  test("Balanced mode dispatches through the vector index", async () => {
    const { db, index, pipeline } = await setup();
    seed(db, "/a.md", "a1", "alpha snippet");
    seed(db, "/b.md", "b1", "beta snippet");
    index.add("a1", Float32Array.from([1, 0]));
    index.add("b1", Float32Array.from([0, 1]));
    const events = await collect(
      pipeline.run({ query: "alpha", mode: "balanced" }, new AbortController().signal),
    );
    const hits = events.find((event) => event.type === "search:hits");
    expect(hits?.type).toBe("search:hits");
    if (hits?.type === "search:hits") {
      expect(hits.hits[0].chunkId).toBe("a1");
    }
  });

  test("Deep mode reaches search:done with synthesis disabled", async () => {
    const { db, index, pipeline } = await setup();
    seed(db, "/a.md", "a1", "alpha snippet");
    index.add("a1", Float32Array.from([1, 0]));
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
    const { pipeline } = await setup();
    const controller = new AbortController();
    controller.abort();
    const events = await collect(pipeline.run({ query: "x", mode: "quick" }, controller.signal));
    expect(events[0].type).toBe("search:retrieving");
    expect(events[1].type).toBe("search:error");
  });

  test("balanced mode aborted during reranker propagates to chatJson and ends with error", async () => {
    // Hardening: when the user retypes mid-search the controller is aborted.
    // The reranker's underlying chatJson must observe the abort signal and
    // reject; the pipeline must yield a search:error reason "aborted" and
    // not yield any search:done event.
    const db = new Database(new MemoryAdapter({ "/wasm": loadWasm() }), {
      dbPath: "/db",
      wasmPath: "/wasm",
    });
    await db.init();
    const index = new InMemoryVectorIndex();
    await index.init(2);
    seed(db, "/a.md", "a1", "alpha snippet");
    seed(db, "/b.md", "b1", "beta snippet");
    index.add("a1", Float32Array.from([1, 0]));
    index.add("b1", Float32Array.from([0, 1]));

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
        // Observe the signal we were handed — abort fires before resolving.
        return await new Promise<T>((_resolve, reject) => {
          const signal = options.signal;
          if (!signal) {
            reject(new Error("missing signal in chatJson options"));
            return;
          }
          const onAbort = (): void => {
            observedSignalAborted = true;
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
          // The caller will abort before this resolves.
          setTimeout(() => reject(new Error("never reached")), 1000);
        });
      },
    };
    const reranker = new Reranker({ provider: slowProvider, model: "rerank" });
    const pipeline = new SearchPipeline({
      db,
      vectorIndex: index,
      reranker,
      embed: async () => Float32Array.from([1, 0]),
      provider: slowProvider,
      reasoningModel: "reasoning",
      settings: () => ({
        balanced: { topK: 10, rerankTopN: 5 },
        deep: { graphExpansionDepth: 1, synthesisEnabled: false },
      }),
      now: () => 100,
    });

    // Start the run, then abort while the reranker is parked on chatJson.
    const iterator = pipeline
      .run({ query: "alpha", mode: "balanced" }, controller.signal)
      [Symbol.asyncIterator]();
    const collected: SearchEvent[] = [];
    // Pull the first event (search:retrieving) synchronously.
    const first = await iterator.next();
    if (!first.done) collected.push(first.value);
    // Schedule the abort on the next microtask so the reranker is mid-flight.
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
    const { pipeline } = await setup();
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
