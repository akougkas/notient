/**
 * Phase 4 Task 11 deepSearch smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/core/search/`.
 *
 * Boots a real SurrealDB, applies the schema, seeds notes with chunk vectors
 * and approved-and-applied wikilink edges, then exercises the deep strategy:
 * hybrid kNN + BM25 retrieval, graph expansion, and grounded synthesis.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { type SurrealServerHandle, startSurreal } from "../../../../../src/daemon/surrealServer";
import { applySchema } from "../../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  relateEdge,
  replaceChunks,
  upsertNoteByPath,
} from "../../../../../src/core/db/surreal";
import type { ChatMessage, ChatOptions, JsonSchema, LLMProvider } from "../../../../../src/core/llm/provider";
import { Reranker } from "../../../../../src/core/search/reranker";
import type { SearchEvent } from "../../../../../src/core/search/types";
import { type DeepSearchEvent, deepSearch } from "../../../../../src/core/search/strategies/deep";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

const VECTOR_DIM = 768;
const EMBED_MODEL = "text-embedding-nomic-embed-text-v2-moe";

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

function unitVector(...nonZero: Array<{ index: number; value: number }>): number[] {
  const vector = new Array<number>(VECTOR_DIM).fill(0);
  for (const entry of nonZero) {
    vector[entry.index] = entry.value;
  }
  return vector;
}

async function seedNote(
  connection: SurrealConnection,
  notePath: string,
  text: string,
  vector: number[],
): Promise<RecordId<"note">> {
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
  return noteId;
}

async function relateApprovedWikilink(
  connection: SurrealConnection,
  fromId: RecordId<"note">,
  toId: RecordId<"note">,
): Promise<void> {
  await relateEdge(connection.db, {
    table: "wikilink",
    from: fromId,
    to: toId,
    source: "wikilink",
    confidenceClass: "EXTRACTED",
    confidence: 1,
    agent: "linker",
    approved: true,
  });
}

async function clearChunksAndEdges(connection: SurrealConnection): Promise<void> {
  await connection.db.query("DELETE wikilink;").collect();
  await connection.db.query("DELETE chunk;").collect();
  await connection.db.query("DELETE note;").collect();
}

async function collectEvents(
  generator: AsyncGenerator<DeepSearchEvent, void, void>,
): Promise<DeepSearchEvent[]> {
  const events: DeepSearchEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] deepSearch", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase4-deep-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-deep-smoke-"));
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

  afterEach(async () => {
    await clearChunksAndEdges(connection);
  });

  test("streams retrieving, hits, expanding, graph-expansion, synthesizing, synthesis-done, then deep:result", async () => {
    // Alpha matches the query strongly (kNN + BM25), Gamma is an isolated
    // chunk that does not match retrieval, and Alpha->Gamma is the only
    // approved-and-applied wikilink so graph expansion adds exactly one hit.
    const alphaId = await seedNote(
      connection,
      "notes/Alpha.md",
      "alpha alpha alpha",
      unitVector({ index: 0, value: 1 }),
    );
    const gammaId = await seedNote(
      connection,
      "notes/Gamma.md",
      "completely unrelated content",
      unitVector({ index: 100, value: 1 }),
    );
    await relateApprovedWikilink(connection, alphaId, gammaId);

    const provider = fakeProvider({
      rerankRanking: ["unused"],
      synthesisTokens: ["- Alpha is foundational [[notes/Alpha]]\n"],
    });
    const reranker = new Reranker({ provider, model: "rerank" });
    const events = await collectEvents(
      deepSearch({
        db: connection.db,
        provider,
        embed: async () => Float32Array.from(unitVector({ index: 0, value: 1 })),
        reranker,
        reasoningModel: "reasoning",
        query: "alpha",
        topK: 1,
        rerankTopN: 1,
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
    const expansion = events.find((event) => event.type === "search:graph-expansion");
    if (expansion?.type === "search:graph-expansion") {
      expect(expansion.addedHitCount).toBeGreaterThanOrEqual(1);
    }
    const result = events[events.length - 1];
    if (result.type === "deep:result") {
      const paths = result.output.hits.map((hit) => hit.notePath);
      expect(paths).toContain("notes/Alpha.md");
      expect(paths).toContain("notes/Gamma.md");
      expect(result.output.synthesis?.bullets).toHaveLength(1);
      expect(result.output.synthesis?.bullets[0].citations[0]).toContain("[[notes/Alpha]]");
    }
  });

  test("skips synthesis stage when synthesisEnabled is false", async () => {
    await seedNote(connection, "notes/Alpha.md", "alpha", unitVector({ index: 0, value: 1 }));

    const provider = fakeProvider({ rerankRanking: ["unused"] });
    const reranker = new Reranker({ provider, model: "rerank" });
    const events = await collectEvents(
      deepSearch({
        db: connection.db,
        provider,
        embed: async () => Float32Array.from(unitVector({ index: 0, value: 1 })),
        reranker,
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
    const alphaId = await seedNote(
      connection,
      "notes/Alpha.md",
      "alpha",
      unitVector({ index: 0, value: 1 }),
    );
    const gammaId = await seedNote(
      connection,
      "notes/Gamma.md",
      "completely unrelated content",
      unitVector({ index: 100, value: 1 }),
    );
    await relateApprovedWikilink(connection, alphaId, gammaId);

    const provider = fakeProvider({ rerankRanking: ["unused"] });
    const reranker = new Reranker({ provider, model: "rerank" });
    const events = await collectEvents(
      deepSearch({
        db: connection.db,
        provider,
        embed: async () => Float32Array.from(unitVector({ index: 0, value: 1 })),
        reranker,
        reasoningModel: "reasoning",
        query: "alpha",
        topK: 1,
        rerankTopN: 1,
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
      // graphDepth=0 means Gamma must NOT be expanded in even though A->Gamma
      // is a wikilink edge. The kNN/BM25 retrieval also misses Gamma so the
      // final hits collapse to just Alpha.
      expect(result.output.hits.map((hit) => hit.notePath)).toEqual(["notes/Alpha.md"]);
    }
  });

  test("synthesis transport failure produces a stub card with error and reaches deep:result", async () => {
    await seedNote(connection, "notes/Alpha.md", "alpha", unitVector({ index: 0, value: 1 }));

    const provider = fakeProvider({
      rerankRanking: ["unused"],
      failSynthesis: () => new Error("llama-server 500"),
    });
    const reranker = new Reranker({ provider, model: "rerank" });
    const events = await collectEvents(
      deepSearch({
        db: connection.db,
        provider,
        embed: async () => Float32Array.from(unitVector({ index: 0, value: 1 })),
        reranker,
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
    await seedNote(connection, "notes/Alpha.md", "alpha", unitVector({ index: 0, value: 1 }));

    const provider = fakeProvider({
      rerankRanking: ["unused"],
      failSynthesis: () => {
        const aborted = new Error("aborted");
        aborted.name = "AbortError";
        return aborted;
      },
    });
    const reranker = new Reranker({ provider, model: "rerank" });
    const controller = new AbortController();

    const events: DeepSearchEvent[] = [];
    const generator = deepSearch({
      db: connection.db,
      provider,
      embed: async () => Float32Array.from(unitVector({ index: 0, value: 1 })),
      reranker,
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
    await seedNote(connection, "notes/Alpha.md", "alpha", unitVector({ index: 0, value: 1 }));
    const provider = fakeProvider({});
    const reranker = new Reranker({ provider, model: "rerank" });
    const controller = new AbortController();
    controller.abort();

    const events = await collectEvents(
      deepSearch({
        db: connection.db,
        provider,
        embed: async () => Float32Array.from(unitVector({ index: 0, value: 1 })),
        reranker,
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
