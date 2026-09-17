/**
 * Phase 4 Task 11 quickSearch smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/core/search/`.
 *
 * Boots a real SurrealDB, applies the schema, seeds a few notes with chunks
 * carrying deterministic vectors, then exercises the SurrealDB BM25 path
 * powered by the `chunk_text` full-text index.
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
import { quickSearch } from "../../../../../src/core/search/strategies/quick";
import { type SurrealServerHandle, startSurreal } from "../../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

const VECTOR_DIM = 768;
const EMBEDDING_IDENTITY = { model: "quick-search-fixture", dimension: VECTOR_DIM } as const;

function vectorOf(seed: number): number[] {
  const vector = new Array<number>(VECTOR_DIM);
  vector[0] = seed;
  for (let index = 1; index < VECTOR_DIM; index += 1) {
    vector[index] = 0.1;
  }
  return vector;
}

async function seedChunks(
  connection: SurrealConnection,
  notePath: string,
  texts: string[],
  vectorSeed: number,
): Promise<void> {
  const noteId = await upsertNoteByPath(connection.db, {
    path: notePath,
    sha: `sha-${notePath}`,
    wordCount: 10,
  });
  await replaceChunks(
    connection.db,
    noteId,
    EMBEDDING_IDENTITY,
    texts.map((text, index) => ({
      ord: index,
      text,
      tokenEstimate: 4,
      vector: vectorOf(vectorSeed + index),
    })),
  );
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] quickSearch", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase4-quick-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-quick-smoke-"));
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

  test("returns [] when there are no documents", async () => {
    const hits = await quickSearch({ db: connection.db, query: "anything", limit: 5 });
    expect(hits).toEqual([]);
  });

  test("returns [] for an empty query", async () => {
    await seedChunks(connection, "notes/empty.md", ["graph reasoning"], 1);
    const hits = await quickSearch({ db: connection.db, query: "   ", limit: 5 });
    expect(hits).toEqual([]);
  });

  test("rejects a zero limit", async () => {
    await expect(quickSearch({ db: connection.db, query: "graph", limit: 0 })).rejects.toThrow(
      "positive safe integer",
    );
  });

  test("BM25 search surfaces matching notes", async () => {
    // SurrealDB's BM25 IDF returns 0 for tiny corpora; we seed three docs so
    // the scorer has enough mass to differentiate the matched chunk.
    await connection.db.query("DELETE chunk; DELETE note;").collect();
    await seedChunks(connection, "notes/graph.md", ["graph reasoning intro"], 10);
    await seedChunks(connection, "notes/synthesis.md", ["synthesis is hard"], 20);
    await seedChunks(connection, "notes/other.md", ["completely different topic"], 30);
    const hits = await quickSearch({ db: connection.db, query: "graph", limit: 5 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].notePath).toBe("notes/graph.md");
    expect(hits[0].snippet.toLowerCase()).toContain("graph");
    expect(hits[0].matchedText).toBe("graph");
    expect(hits[0].score).toBeGreaterThan(0);
  });

  test("falls back to significant terms for a multi-word natural-language query", async () => {
    await connection.db.query("DELETE chunk; DELETE note;").collect();
    await seedChunks(
      connection,
      "research/parallel-hdf5.md",
      ["Parallel HDF5 supports multi threaded IO through a collective metadata path."],
      40,
    );
    await seedChunks(
      connection,
      "research/thread-pools.md",
      ["Thread pools schedule independent compute work."],
      50,
    );
    await seedChunks(connection, "notes/unrelated.md", ["Garden planning and soil."], 60);

    const hits = await quickSearch({
      db: connection.db,
      query: "Find my notes about multi threaded HDF5",
      limit: 5,
    });

    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].notePath).toBe("research/parallel-hdf5.md");
    expect(hits[0].matchedText.split(" ")).toEqual(
      expect.arrayContaining(["multi", "threaded", "hdf5"]),
    );
    expect(hits[0].snippet.toLowerCase()).toContain("hdf5");
    expect(new Set(hits.map((hit) => hit.notePath)).size).toBe(hits.length);
  });

  test("quoted subjects stay binding when keyword fallback broadens other terms", async () => {
    await connection.db.query("DELETE chunk; DELETE note;").collect();
    await seedChunks(
      connection,
      "research/hdf5.md",
      ["Parallel HDF5 supports collective metadata operations."],
      40,
    );
    await seedChunks(
      connection,
      "agents.md",
      ["Parallel independent agents share a collective data view."],
      50,
    );
    const hits = await quickSearch({
      db: connection.db,
      query: '"Parallel HDF5" collective independent data view',
      limit: 5,
    });
    expect(hits.map((hit) => hit.notePath)).toEqual(["research/hdf5.md"]);
    const missing = await quickSearch({
      db: connection.db,
      query: '"Nonexistent subject" parallel collective',
      limit: 5,
    });
    expect(missing).toEqual([]);
    const scoped = await quickSearch({
      db: connection.db,
      query: '"Parallel HDF5" collective',
      filters: { folders: ["elsewhere"] },
      limit: 5,
    });
    expect(scoped).toEqual([]);
  });

  test("respects limit", async () => {
    await connection.db.query("DELETE chunk; DELETE note;").collect();
    for (let index = 0; index < 5; index += 1) {
      await seedChunks(
        connection,
        `notes/hit-${index}.md`,
        ["graph reasoning everywhere"],
        100 + index,
      );
    }
    const hits = await quickSearch({ db: connection.db, query: "graph", limit: 2 });
    expect(hits.length).toBe(2);
  });

  test("dedupes by note path so each note appears at most once", async () => {
    await connection.db.query("DELETE chunk; DELETE note;").collect();
    await seedChunks(
      connection,
      "notes/dup.md",
      ["graph reasoning intro", "graph reasoning continues"],
      30,
    );
    const hits = await quickSearch({ db: connection.db, query: "graph", limit: 5 });
    expect(hits.length).toBe(1);
    expect(hits[0].notePath).toBe("notes/dup.md");
  });
});
