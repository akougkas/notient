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
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  relateEdge,
  upsertConcept,
} from "../../../../src/core/db/surreal";
import { EventBus } from "../../../../src/core/events/eventBus";
import { Embedder } from "../../../../src/core/indexer/embedder";
import { runTier1 } from "../../../../src/core/indexer/tier1";
import { persistLexicalChunks, runTier2 } from "../../../../src/core/indexer/tier2";
import type { EmbedOptions, LLMProvider } from "../../../../src/core/llm/provider";
import { extract } from "../../../../src/core/markdown/extractor";
import { processAst } from "../../../../src/core/markdown/pipeline";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

const VECTOR_DIM = 768;
const EMBEDDING_IDENTITY = {
  model: "tier2-integration-embedding",
  dimension: VECTOR_DIM,
} as const;

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

function makeEmbedder(): { embedder: Embedder; calls: { count: number; inputs: number } } {
  const calls = { count: 0, inputs: 0 };
  const provider = fakeProvider({
    embed: async (input: string[], _opts: EmbedOptions) => {
      calls.count += 1;
      calls.inputs += input.length;
      return input.map((text) => deterministicVector(text));
    },
  });
  const embedder = new Embedder(provider, { identity: EMBEDDING_IDENTITY, concurrency: 1 });
  return { embedder, calls };
}

function makeLengthLimitedEmbedder(maxChars: number): Embedder {
  return new Embedder(
    fakeProvider({
      embed: async (input: string[]) => {
        if (input.some((text) => text.length > maxChars)) {
          throw new Error("the input length exceeds the context length");
        }
        return input.map((text) => deterministicVector(text));
      },
    }),
    { identity: EMBEDDING_IDENTITY, retryDelayMs: 0, concurrency: 1 },
  );
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

    await runTier1(connection.db, {
      notePath,
      source: noteSource,
      vaultPaths,
      bus: new EventBus(),
    });
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

  test("a structural refresh retains identical-text vectors and drops them for changed chunks", async () => {
    const path = "structural-refresh.md";
    const body = "# Stable\n\nEvidence already embedded.\n\n# Changed\n\nOriginal wording.\n";
    const bus = new EventBus();
    const first = await runTier1(connection.db, {
      notePath: path,
      source: body,
      vaultPaths: [path],
      bus,
    });
    const { embedder, calls } = makeEmbedder();
    await runTier2(connection.db, {
      notePath: path,
      sourceRevision: first.extraction.bodySha,
      blocks: first.extraction.blocks,
      embedder,
      bus,
      chunkSizes: { targetTokens: 320, maxTokens: 480 },
    });
    const readChunks = async () => {
      const [rows] = await connection.db
        .query<
          [
            Array<{
              id: RecordId<"chunk">;
              text: string;
              vector?: number[];
              embed_model?: string;
              embedded_at?: unknown;
            }>,
          ]
        >(
          "SELECT id, ord, text, vector, embed_model, embedded_at FROM chunk WHERE note = $note ORDER BY ord;",
          { note: first.noteId },
        )
        .collect<
          [
            Array<{
              id: RecordId<"chunk">;
              text: string;
              vector?: number[];
              embed_model?: string;
              embedded_at?: unknown;
            }>,
          ]
        >();
      return rows;
    };
    const before = await readChunks();
    const count = calls.count;
    const refresh = await runTier1(connection.db, {
      notePath: path,
      source: body,
      vaultPaths: [path],
      bus,
    });
    await persistLexicalChunks(connection.db, {
      noteId: refresh.noteId,
      sourceRevision: refresh.extraction.bodySha,
      blocks: refresh.extraction.blocks,
      chunkSizes: { targetTokens: 320, maxTokens: 480 },
    });
    expect(await readChunks()).toEqual(before);
    const changed = await runTier1(connection.db, {
      notePath: path,
      source: body.replace("Original wording.", "Revised wording."),
      vaultPaths: [path],
      bus,
    });
    await persistLexicalChunks(connection.db, {
      noteId: changed.noteId,
      sourceRevision: changed.extraction.bodySha,
      blocks: changed.extraction.blocks,
      chunkSizes: { targetTokens: 320, maxTokens: 480 },
    });
    const after = await readChunks();
    expect(after.find((row) => row.text.includes("Revised wording"))?.vector).toBeUndefined();
    const stable = after.find((row) => row.text.includes("Evidence already embedded"));
    expect(stable).toEqual(before.find((row) => row.text === stable?.text));
    expect(stable?.vector?.length).toBe(VECTOR_DIM);
    expect(calls.count).toBe(count);
  });

  test("[smoke] throws when the note is not in SurrealDB", async () => {
    const { embedder } = makeEmbedder();
    await expect(
      runTier2(connection.db, {
        notePath: "missing.md",
        blocks: [],
        embedder,

        bus: new EventBus(),
        chunkSizes: { targetTokens: 320, maxTokens: 480 },
      }),
    ).rejects.toThrow("runTier2: note not found by path 'missing.md'");
  });

  test("[smoke] inserts chunk rows, advances tier2_at, returns chunkCount", async () => {
    const extraction = extract(processAst(noteSource), notePath, noteSource);
    const { embedder, calls } = makeEmbedder();

    const result = await runTier2(connection.db, {
      notePath,
      sourceRevision: extraction.bodySha,
      blocks: extraction.blocks,
      embedder,

      bus: new EventBus(),
      chunkSizes: { targetTokens: 320, maxTokens: 480 },
    });

    expect(result.chunkCount).toBeGreaterThan(0);
    // The embedder batches; every chunk is embedded exactly once, but the
    // number of provider requests is ceil(chunks / batchSize), not one per
    // chunk.
    expect(calls.inputs).toBe(result.chunkCount);
    expect(calls.count).toBe(Math.ceil(result.chunkCount / embedder.getBatchSize()));

    const [chunkRows] = await connection.db
      .query<
        [
          Array<{
            ord: number;
            text: string;
            sha: string;
            vector: number[];
            embed_model: string;
            note: RecordId<"note">;
          }>,
        ]
      >(
        "SELECT ord, text, sha, vector, embed_model, note FROM chunk WHERE note = $note ORDER BY ord;",
        { note: result.noteId },
      )
      .collect<
        [
          Array<{
            ord: number;
            text: string;
            sha: string;
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
      expect(row.sha).toBe(createHash("sha256").update(row.text).digest("hex"));
      expect(row.vector.length).toBe(VECTOR_DIM);
      expect(row.embed_model).toBe(EMBEDDING_IDENTITY.model);
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

      bus: new EventBus(),
      chunkSizes: { targetTokens: 320, maxTokens: 480 },
    });
    const [firstRows] = await connection.db
      .query<[Array<{ id: RecordId<"chunk">; ord: number; text: string }>]>(
        "SELECT id, ord, text FROM chunk WHERE note = $note ORDER BY ord;",
        { note: firstResult.noteId },
      )
      .collect<[Array<{ id: RecordId<"chunk">; ord: number; text: string }>]>();
    await connection.db
      .query("UPDATE chunk SET sha = NONE WHERE note = $note;", { note: firstResult.noteId })
      .collect();
    const secondResult = await runTier2(connection.db, {
      notePath,
      blocks: extraction.blocks,
      embedder,

      bus: new EventBus(),
      chunkSizes: { targetTokens: 320, maxTokens: 480 },
    });

    expect(secondResult.chunkCount).toBe(firstResult.chunkCount);

    const [countRows] = await connection.db
      .query<[Array<{ count: number }>]>(
        "SELECT count() AS count FROM chunk WHERE note = $note GROUP ALL;",
        { note: secondResult.noteId },
      )
      .collect<[Array<{ count: number }>]>();
    expect(countRows[0]?.count ?? 0).toBe(secondResult.chunkCount);

    const [secondRows] = await connection.db
      .query<[Array<{ id: RecordId<"chunk">; ord: number; text: string; sha: string }>]>(
        "SELECT id, ord, text, sha FROM chunk WHERE note = $note ORDER BY ord;",
        { note: secondResult.noteId },
      )
      .collect<[Array<{ id: RecordId<"chunk">; ord: number; text: string; sha: string }>]>();
    expect(secondRows.map((row) => row.id.toString())).toEqual(
      firstRows.map((row) => row.id.toString()),
    );
    for (const row of secondRows) {
      expect(row.sha).toBe(createHash("sha256").update(row.text).digest("hex"));
    }
  });

  test("[smoke] inserting content near the top preserves chunk ids and their evidence text", async () => {
    const stablePath = "stable-content.md";
    const original = `# Alpha

Alpha body stays byte-for-byte stable.

# Bravo

Bravo body is the evidence-bearing section.

# Charlie

Charlie body also remains stable.
`;
    const inserted = `# New

New content shifts every following ordinal.

${original}`;
    const { embedder } = makeEmbedder();

    await runTier1(connection.db, {
      notePath: stablePath,
      source: original,
      vaultPaths: [stablePath],
      bus: new EventBus(),
    });
    const firstExtraction = extract(processAst(original), stablePath, original);
    const first = await runTier2(connection.db, {
      notePath: stablePath,
      blocks: firstExtraction.blocks,
      embedder,

      bus: new EventBus(),
      chunkSizes: { targetTokens: 320, maxTokens: 480 },
    });
    const [beforeRows] = await connection.db
      .query<[Array<{ id: RecordId<"chunk">; ord: number; text: string; sha: string }>]>(
        "SELECT id, ord, text, sha FROM chunk WHERE note = $note ORDER BY ord;",
        {
          note: first.noteId,
        },
      )
      .collect<[Array<{ id: RecordId<"chunk">; ord: number; text: string; sha: string }>]>();
    expect(beforeRows).toHaveLength(3);
    const bravo = beforeRows.find((row) => row.text.includes("Bravo body"));
    expect(bravo).toBeDefined();
    if (bravo === undefined) throw new Error("expected Bravo chunk");

    const conceptId = await upsertConcept(connection.db, "Stable evidence probe");
    await relateEdge(connection.db, {
      table: "mentions",
      from: first.noteId,
      to: conceptId,
      source: "extractor",
      confidenceClass: "INFERRED",
      confidence: 0.7,
      agent: "extractor",
      approved: true,
      evidence: [bravo.id],
    });

    await runTier1(connection.db, {
      notePath: stablePath,
      source: inserted,
      vaultPaths: [stablePath],
      bus: new EventBus(),
    });
    const secondExtraction = extract(processAst(inserted), stablePath, inserted);
    await runTier2(connection.db, {
      notePath: stablePath,
      blocks: secondExtraction.blocks,
      embedder,

      bus: new EventBus(),
      chunkSizes: { targetTokens: 320, maxTokens: 480 },
    });

    const [afterRows, evidenceRows] = await connection.db
      .query<
        [
          Array<{ id: RecordId<"chunk">; ord: number; text: string; sha: string }>,
          Array<{ evidence: Array<RecordId<"chunk">> }>,
        ]
      >(
        "SELECT id, ord, text, sha FROM chunk WHERE note = $note ORDER BY ord;\nSELECT evidence FROM mentions WHERE in = $note AND out = $concept;",
        { note: first.noteId, concept: conceptId },
      )
      .collect<
        [
          Array<{ id: RecordId<"chunk">; ord: number; text: string; sha: string }>,
          Array<{ evidence: Array<RecordId<"chunk">> }>,
        ]
      >();

    expect(afterRows).toHaveLength(4);
    for (const previous of beforeRows) {
      const current = afterRows.find((row) => row.text === previous.text);
      expect(current?.id.toString()).toBe(previous.id.toString());
      expect(current?.sha).toBe(previous.sha);
      expect(current?.ord).toBe(previous.ord + 1);
    }
    expect(evidenceRows).toHaveLength(1);
    expect(evidenceRows[0].evidence.map((id) => id.toString())).toEqual([bravo.id.toString()]);
    const evidenceChunk = afterRows.find(
      (row) => row.id.toString() === evidenceRows[0].evidence[0]?.toString(),
    );
    expect(evidenceChunk?.text).toBe(bravo.text);
  });

  test("[smoke] context overflow rechunks full text instead of embedding a prefix", async () => {
    const overflowPath = "adaptive-overflow.md";
    const source = `# Adaptive

${"overflow-safe ".repeat(40).trim()}
`;
    await runTier1(connection.db, {
      notePath: overflowPath,
      source,
      vaultPaths: [overflowPath],
      bus: new EventBus(),
    });
    const extraction = extract(processAst(source), overflowPath, source);
    const result = await runTier2(connection.db, {
      notePath: overflowPath,
      blocks: extraction.blocks,
      embedder: makeLengthLimitedEmbedder(180),

      bus: new EventBus(),
      chunkSizes: { targetTokens: 320, maxTokens: 480 },
    });

    expect(result.chunkCount).toBeGreaterThan(1);
    expect(result.quarantinedCount).toBe(0);
    const [rows] = await connection.db
      .query<[Array<{ ord: number; text: string; vector: number[]; embed_error?: string }>]>(
        "SELECT ord, text, vector, embed_error FROM chunk WHERE note = $note ORDER BY ord;",
        {
          note: result.noteId,
        },
      )
      .collect<[Array<{ ord: number; text: string; vector: number[]; embed_error?: string }>]>();
    expect(rows).toHaveLength(result.chunkCount);
    expect(rows.every((row) => row.text.length <= 180)).toBe(true);
    expect(rows.every((row) => row.vector.length === VECTOR_DIM)).toBe(true);
    expect(rows.every((row) => row.embed_error === undefined)).toBe(true);
  });

  test("[smoke] a sub-200-character overflow quarantines only its chunk", async () => {
    const quarantinePath = "quarantine-overflow.md";
    const source = "# Quarantine\n\nThis short chunk is rejected by the synthetic context limit.\n";
    await runTier1(connection.db, {
      notePath: quarantinePath,
      source,
      vaultPaths: [quarantinePath],
      bus: new EventBus(),
    });
    const extraction = extract(processAst(source), quarantinePath, source);
    const bus = new EventBus();
    const warnings: string[] = [];
    bus.on("indexer:warn", (event) => warnings.push(event.message));

    const result = await runTier2(connection.db, {
      notePath: quarantinePath,
      blocks: extraction.blocks,
      embedder: makeLengthLimitedEmbedder(1),
      bus,

      chunkSizes: { targetTokens: 320, maxTokens: 480 },
    });

    expect(result).toMatchObject({ chunkCount: 1, quarantinedCount: 1 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`note='${quarantinePath}'`);
    const [chunkRows, noteRows] = await connection.db
      .query<
        [
          Array<{ vector?: number[]; embedded_at?: string; embed_error: string }>,
          Array<{ tier2_at?: string }>,
        ]
      >(
        "SELECT vector, embedded_at, embed_error FROM chunk WHERE note = $note;\nSELECT tier2_at FROM $note;",
        { note: result.noteId },
      )
      .collect<
        [
          Array<{ vector?: number[]; embedded_at?: string; embed_error: string }>,
          Array<{ tier2_at?: string }>,
        ]
      >();
    expect(chunkRows).toHaveLength(1);
    expect(chunkRows[0].vector).toBeUndefined();
    expect(chunkRows[0].embedded_at).toBeUndefined();
    expect(chunkRows[0].embed_error).toMatch(/^context_overflow:/);
    expect(noteRows[0].tier2_at).toBeDefined();
  });

  test("[smoke] empty block list short-circuits embed call and still advances tier2_at", async () => {
    const emptyPath = "empty.md";
    await runTier1(connection.db, {
      notePath: emptyPath,
      source: "",
      vaultPaths: [emptyPath],
      bus: new EventBus(),
    });

    const { embedder, calls } = makeEmbedder();
    const result = await runTier2(connection.db, {
      notePath: emptyPath,
      blocks: [],
      embedder,

      bus: new EventBus(),
      chunkSizes: { targetTokens: 320, maxTokens: 480 },
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

      bus: new EventBus(),
      chunkSizes: { targetTokens: 320, maxTokens: 480 },
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

      bus: new EventBus(),
      chunkSizes: { targetTokens: 320, maxTokens: 480 },
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
