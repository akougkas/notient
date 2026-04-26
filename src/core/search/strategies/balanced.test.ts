import { describe, expect, test } from "bun:test";
import { Database } from "../../db/database";
import { MemoryAdapter, loadWasm } from "../../db/database.test";
import { InMemoryVectorIndex } from "../../indexer/vectorIndex";
import type { ChatMessage, ChatOptions, JsonSchema, LLMProvider } from "../../llm/provider";
import { Reranker } from "../reranker";
import { balancedSearch } from "./balanced";

interface FakeProviderOptions {
  ranking?: string[];
  fail?: () => Error;
  capture?: { signal: AbortSignal | null };
}

function fakeProvider(stub: FakeProviderOptions): LLMProvider {
  return {
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
      if (stub.capture) stub.capture.signal = options.signal ?? null;
      if (stub.fail) throw stub.fail();
      return { ranking: stub.ranking ?? [] } as T;
    },
  };
}

async function makeFixture(): Promise<{ db: Database; index: InMemoryVectorIndex }> {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
  await db.init();
  const index = new InMemoryVectorIndex();
  await index.init(2);
  return { db, index };
}

function seedChunk(
  db: Database,
  notePath: string,
  chunkId: string,
  text: string,
  updatedAt = 1,
): void {
  const exists = db.query<{ path: string }>("SELECT path FROM notes WHERE path = ?", [notePath]);
  if (exists.length === 0) {
    db.run("INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)", [
      notePath,
      "sha",
      100,
      1,
      updatedAt,
    ]);
  }
  const ord =
    db.query<{ count: number }>("SELECT COUNT(*) AS count FROM chunks WHERE note_path = ?", [
      notePath,
    ])[0]?.count ?? 0;
  db.run("INSERT INTO chunks (id, note_path, ord, text, sha) VALUES (?,?,?,?,?);", [
    chunkId,
    notePath,
    ord,
    text,
    `sha-${chunkId}`,
  ]);
}

describe("balancedSearch", () => {
  test("vector index returns top-K candidates which are reranked to top-N", async () => {
    const { db, index } = await makeFixture();
    seedChunk(db, "/a.md", "a1", "alpha snippet about graph reasoning");
    seedChunk(db, "/b.md", "b1", "beta snippet about something else");
    seedChunk(db, "/c.md", "c1", "gamma snippet referencing graphs");
    index.add("a1", Float32Array.from([1, 0]));
    index.add("b1", Float32Array.from([0.9, 0.1]));
    index.add("c1", Float32Array.from([0.8, 0.2]));

    const provider = fakeProvider({ ranking: ["c1", "a1", "b1"] });
    const reranker = new Reranker({ provider, model: "rerank" });
    const result = await balancedSearch({
      db,
      vectorIndex: index,
      embed: async () => Float32Array.from([1, 0]),
      reranker,
      query: "graph",
      topK: 3,
      rerankTopN: 2,
      signal: new AbortController().signal,
    });
    expect(result).toHaveLength(2);
    expect(result[0].chunkId).toBe("c1");
    expect(result[1].chunkId).toBe("a1");
  });

  test("returns [] when the vector index has no candidates", async () => {
    const { db, index } = await makeFixture();
    const provider = fakeProvider({ ranking: [] });
    const reranker = new Reranker({ provider, model: "rerank" });
    const result = await balancedSearch({
      db,
      vectorIndex: index,
      embed: async () => Float32Array.from([1, 0]),
      reranker,
      query: "anything",
      topK: 5,
      rerankTopN: 3,
      signal: new AbortController().signal,
    });
    expect(result).toEqual([]);
  });

  test("falls back to quick search when no embedding is produced", async () => {
    const { db, index } = await makeFixture();
    seedChunk(db, "/notes/Graph Reasoning.md", "c1", "deep dive into graph reasoning");
    const provider = fakeProvider({ ranking: [] });
    const reranker = new Reranker({ provider, model: "rerank" });
    const result = await balancedSearch({
      db,
      vectorIndex: index,
      embed: async () => null,
      reranker,
      query: "graph reasoning",
      topK: 5,
      rerankTopN: 3,
      signal: new AbortController().signal,
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].notePath).toBe("/notes/Graph Reasoning.md");
  });

  test("propagates the abort signal into the reranker call", async () => {
    const { db, index } = await makeFixture();
    seedChunk(db, "/a.md", "a1", "alpha");
    seedChunk(db, "/b.md", "b1", "beta");
    index.add("a1", Float32Array.from([1, 0]));
    index.add("b1", Float32Array.from([0.5, 0.5]));

    const captured: { signal: AbortSignal | null } = { signal: null };
    const provider = fakeProvider({ ranking: ["a1", "b1"], capture: captured });
    const reranker = new Reranker({ provider, model: "rerank" });
    const controller = new AbortController();
    await balancedSearch({
      db,
      vectorIndex: index,
      embed: async () => Float32Array.from([1, 0]),
      reranker,
      query: "alpha",
      topK: 2,
      rerankTopN: 2,
      signal: controller.signal,
    });
    expect(captured.signal).toBe(controller.signal);
  });
});
