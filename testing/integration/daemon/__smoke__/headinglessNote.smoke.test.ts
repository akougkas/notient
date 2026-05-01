/**
 * Heading-less note end-to-end smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1).
 *
 * Regression guard for the extractor preamble fix: a note whose body has
 * no H1/H2/H3 must still produce a block, get chunked, and be embedded.
 * Pre-fix the extractor dropped every paragraph because `appendText` was
 * a no-op when `openHeadingBlock` was null, so chunkCount was zero and
 * the note was unreachable via vector search.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect, lookupNoteByPath } from "../../../../src/core/db/surreal";
import { Embedder } from "../../../../src/core/indexer/embedder";
import { runTier1 } from "../../../../src/core/indexer/tier1";
import { EMBED_MODEL, runTier2 } from "../../../../src/core/indexer/tier2";
import type { EmbedOptions, LLMProvider } from "../../../../src/core/llm/provider";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

const VECTOR_DIM = 768;

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

function vectorOf(seed: number): number[] {
  const out = new Array<number>(VECTOR_DIM);
  for (let index = 0; index < VECTOR_DIM; index += 1) {
    out[index] = Math.sin((index + 1) * seed) * 0.5 + 0.5;
  }
  return out;
}

const letterSource = "Dear Sir or Madam,\n\nThis letter recommends Dr Acme.\n";

describe.skipIf(!SMOKE_ENABLED)("[smoke] heading-less note indexing", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "headingless-smoke-secret";
  const letterPath = "letter.md";

  let letterId: RecordId<"note">;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-headingless-smoke-"));
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

    const { extraction } = await runTier1(connection.db, {
      notePath: letterPath,
      source: letterSource,
      vaultPaths: [letterPath],
    });

    const provider = fakeProvider({
      embed: async (input: string[], _opts: EmbedOptions) => input.map(() => vectorOf(0.42)),
    });
    const embedder = new Embedder(provider, { model: EMBED_MODEL });
    await runTier2(connection.db, {
      notePath: letterPath,
      blocks: extraction.blocks,
      embedder,
    });

    const id = await lookupNoteByPath(connection.db, letterPath);
    if (id === null) {
      throw new Error("setup: failed to look up the seeded heading-less note");
    }
    letterId = id;
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
  });

  test("[smoke] heading-less note yields >=1 chunk row with a 768-dim vector and EMBED_MODEL", async () => {
    interface ChunkRow {
      ord: number;
      vector: number[];
      embed_model: string;
    }
    const [rows] = await connection.db
      .query<[ChunkRow[]]>(
        "SELECT ord, vector, embed_model FROM chunk WHERE note = $note ORDER BY ord;",
        { note: letterId },
      )
      .collect<[ChunkRow[]]>();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(row.vector.length).toBe(VECTOR_DIM);
      expect(row.embed_model).toBe(EMBED_MODEL);
    }
  });
});
