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

  const reranker = new Reranker({ provider: fakeProvider(["a1"]), model: "rerank" });
  const pipeline = new SearchPipeline({
    db,
    vectorIndex: index,
    reranker,
    embed: async () => Float32Array.from([1, 0]),
    settings: () => ({ balanced: { topK: 10, rerankTopN: 5 } }),
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

  test("emits search:error when the underlying strategy throws", async () => {
    const { pipeline } = await setup();
    const events = await collect(
      pipeline.run({ query: "x", mode: "deep" }, new AbortController().signal),
    );
    const error = events.find((event) => event.type === "search:error");
    expect(error?.type).toBe("search:error");
    if (error?.type === "search:error") {
      expect(error.message).toMatch(/Deep/);
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
