import { describe, expect, test } from "bun:test";
import { Database } from "../../db/database";
import { MemoryAdapter, loadWasm } from "../../db/database.test";
import { InMemoryVectorIndex } from "../../indexer/vectorIndex";
import type { ChatMessage, ChatOptions, JsonSchema, LLMProvider } from "../../llm/provider";
import { Reranker } from "../reranker";
import type { SearchEvent, SearchHit } from "../types";
import { type DeepSearchEvent, deepSearch } from "./deep";

interface ProviderStub {
  rerankRanking?: string[];
  synthesisTokens?: string[];
  failSynthesis?: () => Error;
}

function fakeProvider(stub: ProviderStub): LLMProvider {
  return {
    isAvailable: async () => true,
    chat: async () => "",
    chatStream: async function* (): AsyncIterable<string> {
      if (stub.failSynthesis) throw stub.failSynthesis();
      for (const token of stub.synthesisTokens ?? []) yield token;
    },
    embed: async () => [],
    chatJson: async <T>(
      _messages: ChatMessage[],
      _options: ChatOptions,
      _schema: JsonSchema,
    ): Promise<T> => ({ ranking: stub.rerankRanking ?? [] }) as T,
  };
}

interface Harness {
  db: Database;
  index: InMemoryVectorIndex;
  reranker: Reranker;
  provider: LLMProvider;
}

async function setupHarness(stub: ProviderStub = {}): Promise<Harness> {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
  await db.init();
  const index = new InMemoryVectorIndex();
  await index.init(2);
  const provider = fakeProvider(stub);
  const reranker = new Reranker({ provider, model: "rerank" });
  return { db, index, reranker, provider };
}

function seedNote(db: Database, path: string, chunkId: string, text: string): void {
  db.run("INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?);", [
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

function seedApprovedEdge(
  db: Database,
  edgeId: string,
  sourcePath: string,
  targetPath: string,
): void {
  db.run(
    `INSERT INTO graph_edges (id, type, source_id, target_id, confidence, agent, evidence, approved, created_at)
     VALUES (?,?,?,?,?,?,?,?,?);`,
    [edgeId, "related", `note:${sourcePath}`, `note:${targetPath}`, 0.9, "linker", "[]", 1, 1],
  );
}

async function collect(
  generator: AsyncGenerator<DeepSearchEvent, void, void>,
): Promise<DeepSearchEvent[]> {
  const events: DeepSearchEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

const embedAlphaVector = async (): Promise<Float32Array> => Float32Array.from([1, 0]);

describe("deepSearch", () => {
  test("streams retrieving, hits, expanding, graph-expansion, synthesizing, synthesis-done, then deep:result", async () => {
    const harness = await setupHarness({
      rerankRanking: ["alpha-chunk"],
      synthesisTokens: ["- Alpha is foundational [[/notes/Alpha]]\n"],
    });
    seedNote(harness.db, "/notes/Alpha.md", "alpha-chunk", "alpha alpha alpha");
    seedNote(harness.db, "/notes/Beta.md", "beta-chunk", "beta beta beta");
    harness.index.add("alpha-chunk", Float32Array.from([1, 0]));
    seedApprovedEdge(harness.db, "edge-1", "/notes/Alpha.md", "/notes/Beta.md");

    const events = await collect(
      deepSearch({
        db: harness.db,
        provider: harness.provider,
        vectorIndex: harness.index,
        embed: embedAlphaVector,
        reranker: harness.reranker,
        reasoningModel: "reasoning",
        query: "alpha",
        topK: 5,
        rerankTopN: 5,
        graphDepth: 1,
        synthesisEnabled: true,
        signal: new AbortController().signal,
      }),
    );
    const order = events.map((event) => event.type);
    expect(order).toEqual([
      "search:retrieving",
      "search:hits",
      "search:expanding",
      "search:graph-expansion",
      "search:synthesizing",
      "search:synthesis-done",
      "deep:result",
    ]);
    const hitsEvent = events.find((event) => event.type === "search:hits");
    if (hitsEvent?.type === "search:hits") {
      expect(hitsEvent.hits[0].chunkId).toBe("alpha-chunk");
    }
    const expansion = events.find((event) => event.type === "search:graph-expansion");
    if (expansion?.type === "search:graph-expansion") {
      expect(expansion.addedHitCount).toBe(1);
    }
    const result = events[events.length - 1];
    if (result.type === "deep:result") {
      expect(result.output.hits.map((hit) => hit.notePath)).toEqual([
        "/notes/Alpha.md",
        "/notes/Beta.md",
      ]);
      expect(result.output.synthesis?.bullets).toHaveLength(1);
      expect(result.output.synthesis?.bullets[0].citations[0]).toContain("[[/notes/Alpha]]");
    }
  });

  test("skips synthesis stage when synthesisEnabled is false", async () => {
    const harness = await setupHarness({ rerankRanking: ["alpha-chunk"] });
    seedNote(harness.db, "/notes/Alpha.md", "alpha-chunk", "alpha");
    harness.index.add("alpha-chunk", Float32Array.from([1, 0]));

    const events = await collect(
      deepSearch({
        db: harness.db,
        provider: harness.provider,
        vectorIndex: harness.index,
        embed: embedAlphaVector,
        reranker: harness.reranker,
        reasoningModel: "reasoning",
        query: "alpha",
        topK: 5,
        rerankTopN: 5,
        graphDepth: 1,
        synthesisEnabled: false,
        signal: new AbortController().signal,
      }),
    );
    const types = events.map((event) => event.type);
    expect(types).not.toContain("search:synthesizing");
    expect(types).not.toContain("search:synthesis-done");
    const result = events[events.length - 1];
    if (result.type === "deep:result") {
      expect(result.output.synthesis).toBeNull();
    }
  });

  test("graphDepth=0 skips graph expansion but still emits the stage event", async () => {
    const harness = await setupHarness({ rerankRanking: ["alpha-chunk"] });
    seedNote(harness.db, "/notes/Alpha.md", "alpha-chunk", "alpha");
    seedNote(harness.db, "/notes/Beta.md", "beta-chunk", "beta");
    harness.index.add("alpha-chunk", Float32Array.from([1, 0]));
    seedApprovedEdge(harness.db, "edge-1", "/notes/Alpha.md", "/notes/Beta.md");

    const events = await collect(
      deepSearch({
        db: harness.db,
        provider: harness.provider,
        vectorIndex: harness.index,
        embed: embedAlphaVector,
        reranker: harness.reranker,
        reasoningModel: "reasoning",
        query: "alpha",
        topK: 5,
        rerankTopN: 5,
        graphDepth: 0,
        synthesisEnabled: false,
        signal: new AbortController().signal,
      }),
    );
    const expansion = events.find((event) => event.type === "search:graph-expansion");
    if (expansion?.type === "search:graph-expansion") {
      expect(expansion.addedHitCount).toBe(0);
    }
    const result = events[events.length - 1];
    if (result.type === "deep:result") {
      expect(result.output.hits.map((hit) => hit.notePath)).toEqual(["/notes/Alpha.md"]);
    }
  });

  test("synthesis transport failure produces a stub card with error and reaches deep:result", async () => {
    const harness = await setupHarness({
      rerankRanking: ["alpha-chunk"],
      failSynthesis: () => new Error("llama-server 500"),
    });
    seedNote(harness.db, "/notes/Alpha.md", "alpha-chunk", "alpha");
    harness.index.add("alpha-chunk", Float32Array.from([1, 0]));

    const events = await collect(
      deepSearch({
        db: harness.db,
        provider: harness.provider,
        vectorIndex: harness.index,
        embed: embedAlphaVector,
        reranker: harness.reranker,
        reasoningModel: "reasoning",
        query: "alpha",
        topK: 5,
        rerankTopN: 5,
        graphDepth: 1,
        synthesisEnabled: true,
        signal: new AbortController().signal,
      }),
    );
    const synthesisDone = events.find((event) => event.type === "search:synthesis-done");
    if (synthesisDone?.type === "search:synthesis-done") {
      expect(synthesisDone.card.error).toBe("llama-server 500");
      expect(synthesisDone.card.bullets).toEqual([]);
    }
    const result = events[events.length - 1];
    if (result.type === "deep:result") {
      expect(result.output.synthesis?.error).toBe("llama-server 500");
    }
  });

  test("aborted signal during synthesis emits search:error and stops", async () => {
    const harness = await setupHarness({
      rerankRanking: ["alpha-chunk"],
      failSynthesis: () => {
        const aborted = new Error("aborted");
        aborted.name = "AbortError";
        return aborted;
      },
    });
    seedNote(harness.db, "/notes/Alpha.md", "alpha-chunk", "alpha");
    harness.index.add("alpha-chunk", Float32Array.from([1, 0]));
    const controller = new AbortController();

    const events: DeepSearchEvent[] = [];
    const generator = deepSearch({
      db: harness.db,
      provider: harness.provider,
      vectorIndex: harness.index,
      embed: embedAlphaVector,
      reranker: harness.reranker,
      reasoningModel: "reasoning",
      query: "alpha",
      topK: 5,
      rerankTopN: 5,
      graphDepth: 1,
      synthesisEnabled: true,
      signal: controller.signal,
    });
    for await (const event of generator) {
      events.push(event);
      if (event.type === "search:synthesizing") controller.abort();
    }
    const errorEvent = events.find((event) => event.type === "search:error");
    expect(errorEvent?.type).toBe("search:error");
    if (errorEvent?.type === "search:error") {
      expect(errorEvent.message).toBe("aborted");
    }
    expect(events.find((event) => event.type === "deep:result")).toBeUndefined();
  });

  test("aborted signal before retrieval short-circuits with search:error", async () => {
    const harness = await setupHarness();
    seedNote(harness.db, "/notes/Alpha.md", "alpha-chunk", "alpha");
    harness.index.add("alpha-chunk", Float32Array.from([1, 0]));
    const controller = new AbortController();
    controller.abort();

    const events = await collect(
      deepSearch({
        db: harness.db,
        provider: harness.provider,
        vectorIndex: harness.index,
        embed: embedAlphaVector,
        reranker: harness.reranker,
        reasoningModel: "reasoning",
        query: "alpha",
        topK: 5,
        rerankTopN: 5,
        graphDepth: 1,
        synthesisEnabled: true,
        signal: controller.signal,
      }),
    );
    const types = events.map((event) => (event as SearchEvent).type);
    expect(types).toEqual(["search:retrieving", "search:error"]);
  });
});
