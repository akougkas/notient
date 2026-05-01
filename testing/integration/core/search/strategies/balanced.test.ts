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
import { applySchema } from "../../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  replaceChunks,
  upsertNoteByPath,
} from "../../../../../src/core/db/surreal";
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
const EMBED_MODEL = "text-embedding-nomic-embed-text-v2-moe";

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
    const candidateChunkIds = await connection.db
      .query<[Array<{ id: string }>]>("SELECT id FROM chunk;")
      .collect<[Array<{ id: string }>]>();
    const ids = candidateChunkIds[0].map((row) => row.id.toString());

    const provider = fakeProvider({ ranking: ids });
    const reranker = new Reranker({ provider, model: "rerank" });
    const result = await balancedSearch({
      db: connection.db,
      embed: async () => queryVector,
      reranker,
      query: "graph",
      topK: 3,
      rerankTopN: 2,
      signal: new AbortController().signal,
    });
    expect(result).toHaveLength(2);
    expect(result.map((hit) => hit.notePath).sort()).not.toContain(undefined);
  });

  test("returns [] when no chunks match the kNN window", async () => {
    await connection.db.query("DELETE chunk; DELETE note;").collect();
    const provider = fakeProvider({ ranking: [] });
    const reranker = new Reranker({ provider, model: "rerank" });
    const result = await balancedSearch({
      db: connection.db,
      embed: async () => Float32Array.from(unitVector({ index: 0, value: 1 })),
      reranker,
      query: "anything",
      topK: 5,
      rerankTopN: 3,
      signal: new AbortController().signal,
    });
    expect(result).toEqual([]);
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
    const reranker = new Reranker({ provider, model: "rerank" });
    const result = await balancedSearch({
      db: connection.db,
      embed: async () => null,
      reranker,
      query: "graph reasoning",
      topK: 5,
      rerankTopN: 3,
      signal: new AbortController().signal,
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
    const provider = fakeProvider({ ranking: ["irrelevant"], capture: captured });
    const reranker = new Reranker({ provider, model: "rerank" });
    const controller = new AbortController();
    await balancedSearch({
      db: connection.db,
      embed: async () => Float32Array.from(unitVector({ index: 0, value: 1 })),
      reranker,
      query: "alpha",
      topK: 2,
      rerankTopN: 2,
      signal: controller.signal,
    });
    expect(captured.signal).toBe(controller.signal);
  });
});
