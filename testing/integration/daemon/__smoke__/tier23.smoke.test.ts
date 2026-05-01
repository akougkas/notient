/**
 * Phase 3 Tier 2 + Tier 3 end-to-end smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1).
 *
 * Boots a real SurrealDB, applies the Phase 1 schema, seeds three notes
 * via `runTier1`, embeds each via `runTier2` with a deterministic mock
 * embedder, then runs `runTier3` on the active note with a mock LLM that
 * returns one extractor finding per kind and one linker proposal. Asserts:
 *   - Chunk rows exist for every note with the expected vectors and the
 *     locked `EMBED_MODEL` literal.
 *   - kNN against `chunk.vector` finds the seeded chunks.
 *   - `mentions`, `asserts`, `asks` rows exist with `approved = true`.
 *   - The linker `supports` row exists with `approved = false`.
 *   - `linkerNeighbors` excludes the active note from its results.
 *   - `linkerNeighbors` excludes notes that already share a `wikilink`
 *     edge with the active note (the seeded A->B wikilink keeps B out).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { Linker } from "../../../../src/core/agents/linker";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  linkerNeighbors,
  lookupNoteByPath,
  markTier3Done,
  relateEdge,
  searchVector,
} from "../../../../src/core/db/surreal";
import { Embedder } from "../../../../src/core/indexer/embedder";
import { Extractor } from "../../../../src/core/indexer/extractor";
import { runTier1 } from "../../../../src/core/indexer/tier1";
import { EMBED_MODEL, runTier2 } from "../../../../src/core/indexer/tier2";
import { type Tier3Chunk, runTier3 } from "../../../../src/core/indexer/tier3";
import type {
  ChatMessage,
  ChatOptions,
  EmbedOptions,
  JsonSchema,
  LLMProvider,
} from "../../../../src/core/llm/provider";
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

const SEED_A = 0.42;
const SEED_B = 2.7;
const SEED_C = 0.43;

function makeEmbedder(seedFor: (text: string) => number): {
  embedder: Embedder;
} {
  const provider = fakeProvider({
    embed: async (input: string[], _opts: EmbedOptions) =>
      input.map((text) => vectorOf(seedFor(text))),
  });
  const embedder = new Embedder(provider, { model: EMBED_MODEL });
  return { embedder };
}

const noteASource = `# Active Note

A paragraph about POSIX limits in distributed file systems and how they are leaky.

This note links to [[noteB]].
`;

const noteBSource = `# Note B

A short paragraph about an unrelated topic, gardening seasons in temperate climates.
`;

const noteCSource = `# Note C

A paragraph about POSIX limits in distributed file systems with similar wording.
`;

describe.skipIf(!SMOKE_ENABLED)("[smoke] Phase 3 Tier 2/3 end-to-end", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase3-tier23-smoke-secret";
  const pathA = "noteA.md";
  const pathB = "noteB.md";
  const pathC = "noteC.md";
  const vaultPaths = [pathA, pathB, pathC];

  let noteAId: RecordId<"note">;
  let noteBId: RecordId<"note">;
  let noteCId: RecordId<"note">;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-tier23-smoke-"));
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

    const seedFor = (text: string): number => {
      if (text.includes("gardening")) return SEED_B;
      if (text.includes("similar wording")) return SEED_C;
      return SEED_A;
    };

    const sourcesByPath: Record<string, string> = {
      [pathB]: noteBSource,
      [pathC]: noteCSource,
      [pathA]: noteASource,
    };
    for (const notePath of [pathB, pathC, pathA]) {
      const { extraction } = await runTier1(connection.db, {
        notePath,
        source: sourcesByPath[notePath],
        vaultPaths,
      });
      const { embedder } = makeEmbedder(seedFor);
      await runTier2(connection.db, {
        notePath,
        blocks: extraction.blocks,
        embedder,
      });
    }

    const idA = await lookupNoteByPath(connection.db, pathA);
    const idB = await lookupNoteByPath(connection.db, pathB);
    const idC = await lookupNoteByPath(connection.db, pathC);
    if (idA === null || idB === null || idC === null) {
      throw new Error("setup: failed to look up one of the seeded notes after Tier 1");
    }
    noteAId = idA;
    noteBId = idB;
    noteCId = idC;

    // Tier 1 emits body wikilinks rooted at the source block
    // (`block -> wikilink -> note`). The linker's exclusion query traverses
    // wikilinks rooted at the active *note* (`note -> wikilink -> note`), so
    // we seed a note-level edge directly to exercise that filter, matching
    // the pattern used in linker.test.ts.
    await relateEdge(connection.db, {
      table: "wikilink",
      from: noteAId,
      to: noteBId,
      source: "wikilink",
      confidenceClass: "EXTRACTED",
      confidence: 1,
    });

    await markTier3Done(connection.db, noteBId);
    await markTier3Done(connection.db, noteCId);
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

  test("[smoke] chunk rows exist for all three notes with EMBED_MODEL and 768-dim vectors", async () => {
    interface ChunkRow {
      ord: number;
      vector: number[];
      embed_model: string;
    }
    for (const noteId of [noteAId, noteBId, noteCId]) {
      const [rows] = await connection.db
        .query<[ChunkRow[]]>(
          "SELECT ord, vector, embed_model FROM chunk WHERE note = $note ORDER BY ord;",
          { note: noteId },
        )
        .collect<[ChunkRow[]]>();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.vector.length).toBe(VECTOR_DIM);
        expect(row.embed_model).toBe(EMBED_MODEL);
      }
    }
  });

  test("[smoke] kNN against chunk.vector returns the seeded chunks", async () => {
    const queryVector = vectorOf(SEED_A);
    const hits = await searchVector(connection.db, { vector: queryVector, k: 5, ef: 40 });
    expect(hits.length).toBeGreaterThan(0);
    const noteKeys = hits.map((hit) => hit.noteId.toString());
    expect(noteKeys).toContain(noteAId.toString());
    expect(noteKeys.some((key) => key === noteCId.toString() || key === noteBId.toString())).toBe(
      true,
    );
  });

  test("[smoke] note-rooted wikilink edge A -> B exists for the linker filter", async () => {
    const [rows] = await connection.db
      .query<[Array<{ source: string }>]>(
        "SELECT source FROM wikilink WHERE in = $a AND out = $b;",
        { a: noteAId, b: noteBId },
      )
      .collect<[Array<{ source: string }>]>();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].source).toBe("wikilink");
  });

  test("[smoke] linkerNeighbors excludes the active note and the wikilinked B; includes C", async () => {
    const queryVector = vectorOf(SEED_A);
    const candidates = await linkerNeighbors(connection.db, {
      activeNoteId: noteAId,
      activeChunkVectors: [queryVector],
      k: 10,
      ef: 40,
    });
    const candidateIds = candidates.map((candidate) => candidate.noteId.toString());
    expect(candidateIds).not.toContain(noteAId.toString());
    expect(candidateIds).not.toContain(noteBId.toString());
    expect(candidateIds).toContain(noteCId.toString());
  });

  test("[smoke] runTier3 persists extractor edges with approved=true and a linker supports edge with approved=false", async () => {
    const extractorProvider = fakeProvider({
      chatJson: async <T>() =>
        ({
          entities: ["POSIX"],
          claims: ["POSIX is leaky in distributed file systems."],
          questions: ["How do leaky abstractions affect throughput?"],
        }) as T,
    });
    const extractor = new Extractor(extractorProvider, { model: "test-extractor-model" });

    // The linker mock only proposes C. B is excluded by `linkerNeighbors`
    // before the LLM is called, so a real linker would never see B as a
    // candidate. This mirrors the production behaviour the wikilink filter
    // is designed to enforce.
    const linkerProvider = fakeProvider({
      chatJson: async <T>(_messages: ChatMessage[], _opts: ChatOptions, schema: JsonSchema) => {
        if (schema.name === "Extraction") {
          return { entities: [], claims: [], questions: [] } as T;
        }
        return {
          edges: [
            {
              targetNotePath: pathC,
              type: "supports",
              confidence: 0.85,
              rationale: "C echoes A's POSIX argument.",
              evidenceChunkIds: ["chunk-0"],
            },
          ],
        } as T;
      },
    });
    const linker = new Linker({
      db: connection.db,
      provider: linkerProvider,
      reasoningModel: "test-linker-model",
    });

    interface ChunkRow {
      ord: number;
      text: string;
      vector: number[];
    }
    const [activeChunkRows] = await connection.db
      .query<[ChunkRow[]]>("SELECT ord, text, vector FROM chunk WHERE note = $note ORDER BY ord;", {
        note: noteAId,
      })
      .collect<[ChunkRow[]]>();
    const inputChunks: Tier3Chunk[] = activeChunkRows.map((row) => ({
      ord: row.ord,
      text: row.text,
      vector: row.vector,
    }));

    const result = await runTier3(connection.db, {
      notePath: pathA,
      chunks: inputChunks,
      extractor,
      linker,
    });
    expect(result.noteId.toString()).toBe(noteAId.toString());

    const [mentionsRows] = await connection.db
      .query<[Array<{ approved: boolean; agent: string; source: string; class: string }>]>(
        "SELECT approved, agent, source, class FROM mentions WHERE in = $note;",
        { note: noteAId },
      )
      .collect<[Array<{ approved: boolean; agent: string; source: string; class: string }>]>();
    expect(mentionsRows.length).toBe(1);
    expect(mentionsRows[0].approved).toBe(true);
    expect(mentionsRows[0].agent).toBe("extractor");
    expect(mentionsRows[0].source).toBe("extractor");
    expect(mentionsRows[0].class).toBe("INFERRED");

    const [assertsRows] = await connection.db
      .query<[Array<{ approved: boolean; agent: string }>]>(
        "SELECT approved, agent FROM asserts WHERE in = $note;",
        { note: noteAId },
      )
      .collect<[Array<{ approved: boolean; agent: string }>]>();
    expect(assertsRows.length).toBe(1);
    expect(assertsRows[0].approved).toBe(true);
    expect(assertsRows[0].agent).toBe("extractor");

    const [asksRows] = await connection.db
      .query<[Array<{ approved: boolean; agent: string }>]>(
        "SELECT approved, agent FROM asks WHERE in = $note;",
        { note: noteAId },
      )
      .collect<[Array<{ approved: boolean; agent: string }>]>();
    expect(asksRows.length).toBe(1);
    expect(asksRows[0].approved).toBe(true);

    const [supportsRows] = await connection.db
      .query<
        [
          Array<{
            in: RecordId<"note">;
            out: RecordId<"note">;
            approved: boolean;
            agent: string;
            source: string;
          }>,
        ]
      >("SELECT in, out, approved, agent, source FROM supports WHERE in = $active;", {
        active: noteAId,
      })
      .collect<
        [
          Array<{
            in: RecordId<"note">;
            out: RecordId<"note">;
            approved: boolean;
            agent: string;
            source: string;
          }>,
        ]
      >();
    expect(supportsRows.length).toBe(1);
    expect(supportsRows[0].out.toString()).toBe(noteCId.toString());
    expect(supportsRows[0].approved).toBe(false);
    expect(supportsRows[0].agent).toBe("linker");
    expect(supportsRows[0].source).toBe("linker");

    const [supportsToB] = await connection.db
      .query<[Array<{ count: number }>]>(
        "SELECT count() AS count FROM supports WHERE in = $active AND out = $b GROUP ALL;",
        { active: noteAId, b: noteBId },
      )
      .collect<[Array<{ count: number }>]>();
    expect(supportsToB[0]?.count ?? 0).toBe(0);
  });
});
