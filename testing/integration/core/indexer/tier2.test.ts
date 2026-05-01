/**
 * Phase 3 Tier 2 smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/core/indexer/tier2.test.ts`.
 *
 * Boots a real SurrealDB, applies the Phase 1 schema, seeds a note via
 * Tier 1, runs `runTier2` with a deterministic embedder mock, and asserts
 * the chunk rows, the `tier2_at` advance, and the replace-not-duplicate
 * invariant on a second run.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../../src/core/db/surreal";
import type { EmbedOptions, LLMProvider } from "../../../../src/core/llm/provider";
import { extract } from "../../../../src/core/markdown/extractor";
import { processAst } from "../../../../src/core/markdown/pipeline";
import { Embedder } from "../../../../src/core/indexer/embedder";
import { runTier1 } from "../../../../src/core/indexer/tier1";
import { EMBED_MODEL, runTier2 } from "../../../../src/core/indexer/tier2";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

const VECTOR_DIM = 768;

const noteSource = `# Heading

A first paragraph that exists to populate Tier 1 blocks and feed the chunker.

## Subheading

A second paragraph under a deeper heading so the chunker emits more than one section.
`;

function fakeProvider(impl: Partial<LLMProvider>): LLMProvider {
  return {
    isAvailable: async () => true,
    chat: async () => "",
    chatStream: async function* () {
      yield "";
    },
    chatJson: async <T>() => ({}) as T,
    embed: async () => [],
    ...impl,
  };
}

function deterministicVector(text: string): number[] {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  const seed = (hash & 0xffff) / 0xffff;
  const vector = new Array<number>(VECTOR_DIM);
  vector[0] = seed;
  for (let index = 1; index < VECTOR_DIM; index += 1) {
    vector[index] = 0.1;
  }
  return vector;
}

function makeEmbedder(): { embedder: Embedder; calls: { count: number } } {
  const calls = { count: 0 };
  const provider = fakeProvider({
    embed: async (input: string[], _opts: EmbedOptions) => {
      calls.count += 1;
      return input.map((text) => deterministicVector(text));
    },
  });
  const embedder = new Embedder(provider, { model: EMBED_MODEL });
  return { embedder, calls };
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] runTier2", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase3-tier2-smoke-secret";
  const notePath = "alpha.md";
  const vaultPaths = [notePath];

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-tier2-smoke-"));
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

    await runTier1(connection.db, {
      notePath,
      source: noteSource,
      vaultPaths,
    });
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

  test("[smoke] throws when the note is not in SurrealDB", async () => {
    const { embedder } = makeEmbedder();
    await expect(
      runTier2(connection.db, {
        notePath: "missing.md",
        blocks: [],
        embedder,
      }),
    ).rejects.toThrow("runTier2: note not found by path 'missing.md'");
  });

  test("[smoke] inserts chunk rows, advances tier2_at, returns chunkCount", async () => {
    const extraction = extract(processAst(noteSource), notePath, noteSource);
    const { embedder, calls } = makeEmbedder();

    const result = await runTier2(connection.db, {
      notePath,
      blocks: extraction.blocks,
      embedder,
    });

    expect(result.chunkCount).toBeGreaterThan(0);
    expect(calls.count).toBe(result.chunkCount);

    const [chunkRows] = await connection.db
      .query<
        [
          Array<{
            ord: number;
            text: string;
            vector: number[];
            embed_model: string;
            note: RecordId<"note">;
          }>,
        ]
      >("SELECT ord, text, vector, embed_model, note FROM chunk WHERE note = $note ORDER BY ord;", {
        note: result.noteId,
      })
      .collect<
        [
          Array<{
            ord: number;
            text: string;
            vector: number[];
            embed_model: string;
            note: RecordId<"note">;
          }>,
        ]
      >();

    expect(chunkRows.length).toBe(result.chunkCount);
    for (let index = 0; index < chunkRows.length; index += 1) {
      const row = chunkRows[index];
      expect(row.ord).toBe(index);
      expect(row.text.length).toBeGreaterThan(0);
      expect(row.vector.length).toBe(VECTOR_DIM);
      expect(row.embed_model).toBe(EMBED_MODEL);
    }

    const distinctFirstElements = new Set(chunkRows.map((row) => row.vector[0]));
    expect(distinctFirstElements.size).toBe(chunkRows.length);

    const [noteRows] = await connection.db
      .query<[Array<{ tier2_at: string | null }>]>("SELECT tier2_at FROM note WHERE id = $note;", {
        note: result.noteId,
      })
      .collect<[Array<{ tier2_at: string | null }>]>();
    expect(noteRows.length).toBe(1);
    expect(noteRows[0].tier2_at).not.toBeNull();
  });

  test("[smoke] re-running runTier2 replaces (does not duplicate) chunks", async () => {
    const extraction = extract(processAst(noteSource), notePath, noteSource);
    const { embedder } = makeEmbedder();

    const firstResult = await runTier2(connection.db, {
      notePath,
      blocks: extraction.blocks,
      embedder,
    });
    const secondResult = await runTier2(connection.db, {
      notePath,
      blocks: extraction.blocks,
      embedder,
    });

    expect(secondResult.chunkCount).toBe(firstResult.chunkCount);

    const [countRows] = await connection.db
      .query<[Array<{ count: number }>]>(
        "SELECT count() AS count FROM chunk WHERE note = $note GROUP ALL;",
        { note: secondResult.noteId },
      )
      .collect<[Array<{ count: number }>]>();
    expect(countRows[0]?.count ?? 0).toBe(secondResult.chunkCount);
  });

  test("[smoke] empty block list short-circuits embed call and still advances tier2_at", async () => {
    const emptyPath = "empty.md";
    await runTier1(connection.db, {
      notePath: emptyPath,
      source: "",
      vaultPaths: [emptyPath],
    });

    const { embedder, calls } = makeEmbedder();
    const result = await runTier2(connection.db, {
      notePath: emptyPath,
      blocks: [],
      embedder,
    });

    expect(result.chunkCount).toBe(0);
    expect(calls.count).toBe(0);

    const [noteRows] = await connection.db
      .query<[Array<{ tier2_at: string | null }>]>("SELECT tier2_at FROM note WHERE id = $note;", {
        note: result.noteId,
      })
      .collect<[Array<{ tier2_at: string | null }>]>();
    expect(noteRows.length).toBe(1);
    expect(noteRows[0].tier2_at).not.toBeNull();
  });

  test("[smoke] empty block list clears stale chunks from an earlier non-empty pass", async () => {
    const extraction = extract(processAst(noteSource), notePath, noteSource);
    const { embedder } = makeEmbedder();

    const seeded = await runTier2(connection.db, {
      notePath,
      blocks: extraction.blocks,
      embedder,
    });
    const [beforeRows] = await connection.db
      .query<[Array<{ count: number }>]>(
        "SELECT count() AS count FROM chunk WHERE note = $note GROUP ALL;",
        { note: seeded.noteId },
      )
      .collect<[Array<{ count: number }>]>();
    expect(beforeRows[0]?.count ?? 0).toBeGreaterThan(0);

    const result = await runTier2(connection.db, {
      notePath,
      blocks: [],
      embedder,
    });
    expect(result.chunkCount).toBe(0);

    const [afterRows] = await connection.db
      .query<[Array<{ count: number }>]>(
        "SELECT count() AS count FROM chunk WHERE note = $note GROUP ALL;",
        { note: seeded.noteId },
      )
      .collect<[Array<{ count: number }>]>();
    expect(afterRows[0]?.count ?? 0).toBe(0);
  });
});
