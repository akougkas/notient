/**
 * Phase 4 Task 11 balancedSearch smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/core/search/`.
 *
 * Boots a real SurrealDB, applies the schema, seeds notes with chunk vectors,
 * and exercises the balanced strategy: SurrealDB HNSW kNN retrieval followed
 * by an LLM rerank stub.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ReasoningScheduler } from "../../../../../src/core/coordinator/reasoningScheduler";
import { applySchema } from "../../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  replaceChunks,
  upsertNoteByPath,
} from "../../../../../src/core/db/surreal";
import { EventBus } from "../../../../../src/core/events/eventBus";
import type {
  ChatMessage,
  ChatOptions,
  JsonSchema,
  LLMProvider,
} from "../../../../../src/core/llm/provider";
import { Reranker } from "../../../../../src/core/search/reranker";
import { balancedSearch } from "../../../../../src/core/search/strategies/balanced";
import { type SurrealServerHandle, startSurreal } from "../../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

const VECTOR_DIM = 768;
const EMBEDDING_IDENTITY = { model: "balanced-search-fixture", dimension: VECTOR_DIM } as const;
const REASONING_SCHEDULER = new ReasoningScheduler({ maxConcurrent: 1 });

interface FakeProviderOptions {
  ranking?: number[];
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

function unitVector(...nonZero: Array<{ index: number; value: number }>): number[] {
  const vector = new Array<number>(VECTOR_DIM).fill(0);
  for (const entry of nonZero) {
    vector[entry.index] = entry.value;
  }
  return vector;
}

async function seedChunk(
  connection: SurrealConnection,
  notePath: string,
  text: string,
  vector: number[],
): Promise<void> {
  const noteId = await upsertNoteByPath(connection.db, {
    path: notePath,
    sha: `sha-${notePath}`,
    wordCount: 10,
  });
  await replaceChunks(connection.db, noteId, EMBEDDING_IDENTITY, [
    {
      ord: 0,
      text,
      tokenEstimate: 4,
      vector,
    },
  ]);
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] balancedSearch", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase4-balanced-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-balanced-smoke-"));
    handle = await startSurreal({
      dataDir: path.join(tempDir, "data"),
      secret,
      portFile: path.join(tempDir, "port"),
      pidFile: path.join(tempDir, "pid"),
      logLevel: "warn",
      hnswCacheMib: 64,
    });
    connection = await connect({
      url: handle.url,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    await applySchema(connection.db, secret, { embedDim: 768, embedModel: "fixture-embedding" });
  }, 30_000);

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
  }, 30_000);

  test("kNN returns top-K candidates which are reranked to top-N", async () => {
    await connection.db.query("DELETE chunk; DELETE note;").collect();
    await seedChunk(
      connection,
      "notes/a.md",
      "alpha snippet about graph reasoning",
      unitVector({ index: 0, value: 1 }),
    );
    await seedChunk(
      connection,
      "notes/b.md",
      "beta snippet about something else",
      unitVector({ index: 0, value: 0.9 }, { index: 1, value: 0.1 }),
    );
    await seedChunk(
      connection,
      "notes/c.md",
      "gamma snippet referencing graphs",
      unitVector({ index: 0, value: 0.8 }, { index: 1, value: 0.2 }),
    );

    const queryVector = Float32Array.from(unitVector({ index: 0, value: 1 }));
    const provider = fakeProvider({ ranking: [1, 2, 3] });
    const reranker = new Reranker({ provider, model: "rerank", bus: new EventBus() });
    const result = await balancedSearch({
      db: connection.db,
      embed: async () => queryVector,
      reranker,
      query: "graph",
      topK: 3,
      rerankTopN: 2,
      signal: new AbortController().signal,
      scheduler: REASONING_SCHEDULER,
    });
    expect(result).toHaveLength(2);
    expect(result.map((hit) => hit.notePath).sort()).not.toContain(undefined);
  });

  test("reranks only the closest chunk from each note", async () => {
    await connection.db.query("DELETE chunk; DELETE note;").collect();
    const longNoteId = await upsertNoteByPath(connection.db, {
      path: "notes/long.md",
      sha: "sha-notes/long.md",
      wordCount: 20,
    });
    const [, closestChunkId] = await replaceChunks(connection.db, longNoteId, EMBEDDING_IDENTITY, [
      {
        ord: 0,
        text: "a weaker paragraph from the long note",
        tokenEstimate: 8,
        vector: unitVector({ index: 0, value: 0.5 }, { index: 1, value: 0.5 }),
      },
      {
        ord: 1,
        text: "the strongest paragraph from the long note",
        tokenEstimate: 8,
        vector: unitVector({ index: 0, value: 1 }),
      },
    ]);
    await seedChunk(
      connection,
      "notes/other.md",
      "another relevant note",
      unitVector({ index: 0, value: 0.8 }, { index: 1, value: 0.2 }),
    );

    const provider = fakeProvider({ ranking: [1, 2] });
    const reranker = new Reranker({ provider, model: "rerank", bus: new EventBus() });
    const result = await balancedSearch({
      db: connection.db,
      embed: async () => Float32Array.from(unitVector({ index: 0, value: 1 })),
      reranker,
      query: "semantic retrieval",
      topK: 3,
      rerankTopN: 3,
      signal: new AbortController().signal,
      scheduler: REASONING_SCHEDULER,
    });

    expect(result.map((hit) => hit.notePath)).toEqual(["notes/long.md", "notes/other.md"]);
    expect(result.find((hit) => hit.notePath === "notes/long.md")?.chunkId).toBe(
      closestChunkId.toString(),
    );
  });

  test("returns [] when no chunks match the kNN window", async () => {
    await connection.db.query("DELETE chunk; DELETE note;").collect();
    const provider = fakeProvider({ ranking: [] });
    const reranker = new Reranker({ provider, model: "rerank", bus: new EventBus() });
    const result = await balancedSearch({
      db: connection.db,
      embed: async () => Float32Array.from(unitVector({ index: 0, value: 1 })),
      reranker,
      query: "anything",
      topK: 5,
      rerankTopN: 3,
      signal: new AbortController().signal,
      scheduler: REASONING_SCHEDULER,
    });
    expect(result).toEqual([]);
  });

  test("an empty semantic window still finds structurally indexed notes without reranking", async () => {
    await connection.db.query("DELETE chunk; DELETE note;").collect();
    const note = await upsertNoteByPath(connection.db, {
      path: "notes/SWMR.md",
      sha: "lexical",
      wordCount: 10,
    });
    await connection.db
      .query(
        "CREATE chunk CONTENT { note: $note, ord: 0, text: 'SWMR supports a single writer with multiple readers.', sha: 'lexical', token_estimate: 12 };",
        { note },
      )
      .collect();
    const reranker = new Reranker({
      provider: fakeProvider({ fail: () => new Error("lexical fallback must not call the model") }),
      model: "rerank",
      bus: new EventBus(),
    });
    const input = {
      db: connection.db,
      embed: async () => Float32Array.from(unitVector({ index: 0, value: 1 })),
      reranker,
      query: "SWMR",
      topK: 5,
      rerankTopN: 3,
      signal: new AbortController().signal,
      scheduler: REASONING_SCHEDULER,
    };
    expect((await balancedSearch(input)).map((hit) => hit.notePath)).toEqual(["notes/SWMR.md"]);
    expect(await balancedSearch({ ...input, filters: { folders: ["elsewhere"] } })).toEqual([]);
    expect(await balancedSearch({ ...input, query: '"Parallel HDF5" SWMR' })).toEqual([]);
  });

  test("excludes a preexisting blank vector chunk from citation candidates", async () => {
    await connection.db.query("DELETE chunk; DELETE note;").collect();
    const blankNoteId = await upsertNoteByPath(connection.db, {
      path: "notes/blank.md",
      sha: "sha-notes/blank.md",
      wordCount: 0,
    });
    await connection.db
      .query(
        "CREATE chunk CONTENT { note: $note, ord: 0, text: '   ', sha: 'blank', token_estimate: 0, vector: $vector, embed_model: $model, embedded_at: time::now() };",
        {
          note: blankNoteId,
          vector: unitVector({ index: 0, value: 1 }),
          model: EMBEDDING_IDENTITY.model,
        },
      )
      .collect();
    await seedChunk(
      connection,
      "notes/evidence.md",
      "searchable evidence survives retrieval",
      unitVector({ index: 0, value: 0.9 }, { index: 1, value: 0.1 }),
    );

    const provider = fakeProvider({ ranking: [1] });
    const reranker = new Reranker({ provider, model: "rerank", bus: new EventBus() });
    const result = await balancedSearch({
      db: connection.db,
      embed: async () => Float32Array.from(unitVector({ index: 0, value: 1 })),
      reranker,
      query: "evidence",
      topK: 2,
      rerankTopN: 2,
      signal: new AbortController().signal,
      scheduler: REASONING_SCHEDULER,
    });

    expect(result.map((hit) => hit.notePath)).toEqual(["notes/evidence.md"]);
    expect(result[0]?.snippet.trim().length).toBeGreaterThan(0);
  });

  test("falls back to quick search when no embedding is produced", async () => {
    await connection.db.query("DELETE chunk; DELETE note;").collect();
    await seedChunk(
      connection,
      "notes/Graph Reasoning.md",
      "deep dive into graph reasoning",
      unitVector({ index: 0, value: 1 }),
    );
    const provider = fakeProvider({ ranking: [] });
    const reranker = new Reranker({ provider, model: "rerank", bus: new EventBus() });
    const result = await balancedSearch({
      db: connection.db,
      embed: async () => null,
      reranker,
      query: "graph reasoning",
      topK: 5,
      rerankTopN: 3,
      signal: new AbortController().signal,
      scheduler: REASONING_SCHEDULER,
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].notePath).toBe("notes/Graph Reasoning.md");
  });

  test("propagates the abort signal into the reranker call", async () => {
    await connection.db.query("DELETE chunk; DELETE note;").collect();
    await seedChunk(connection, "notes/a.md", "alpha", unitVector({ index: 0, value: 1 }));
    await seedChunk(
      connection,
      "notes/b.md",
      "beta",
      unitVector({ index: 0, value: 0.5 }, { index: 1, value: 0.5 }),
    );

    const captured: { signal: AbortSignal | null } = { signal: null };
    const provider = fakeProvider({ ranking: [1, 2], capture: captured });
    const reranker = new Reranker({ provider, model: "rerank", bus: new EventBus() });
    const controller = new AbortController();
    await balancedSearch({
      db: connection.db,
      embed: async () => Float32Array.from(unitVector({ index: 0, value: 1 })),
      reranker,
      query: "alpha",
      topK: 2,
      rerankTopN: 2,
      signal: controller.signal,
      scheduler: REASONING_SCHEDULER,
    });
    expect(captured.signal).toBeInstanceOf(AbortSignal);
    expect(captured.signal).not.toBe(controller.signal);
  });
});
