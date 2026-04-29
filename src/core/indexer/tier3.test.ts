/**
 * Phase 3 Tier 3 smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/core/indexer/tier3.test.ts`.
 *
 * Boots a real SurrealDB, applies the schema, seeds Tier 1 (note + blocks)
 * for an active note plus a chunk-only neighbour with `tier3_at` set so the
 * linker's kNN candidate filter accepts it. Mocks the LLM provider for both
 * the extractor and the linker, runs `runTier3`, and asserts:
 *   - extractor edges (`mentions`, `asserts`, `asks`) land with
 *     `approved = true` and the right targets;
 *   - linker `supports` edge lands with `approved = false`;
 *   - the active note's `tier3_at` advances.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { type SurrealServerHandle, startSurreal } from "../../daemon/surrealServer";
import { Linker } from "../agents/linker";
import { applySchema } from "../db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  lookupNoteByPath,
  markTier3Done,
  replaceChunks,
  upsertNoteByPath,
} from "../db/surreal";
import type { ChatMessage, ChatOptions, JsonSchema, LLMProvider } from "../llm/provider";
import { Extractor } from "./extractor";
import { runTier1 } from "./tier1";
import { type Tier3Chunk, runTier3 } from "./tier3";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

const VECTOR_DIM = 768;
const EMBED_MODEL = "text-embedding-nomic-embed-text-v2-moe";

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
  const vector = new Array<number>(VECTOR_DIM);
  vector[0] = seed;
  for (let index = 1; index < VECTOR_DIM; index += 1) {
    vector[index] = 0.1;
  }
  return vector;
}

const activeNoteSource = `# Active

A paragraph about POSIX limits in distributed file systems.
`;

describe.skipIf(!SMOKE_ENABLED)("[smoke] runTier3", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase3-tier3-smoke-secret";
  const activePath = "active.md";
  const neighborPath = "neighbor.md";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-tier3-smoke-"));
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
      notePath: activePath,
      source: activeNoteSource,
      vaultPaths: [activePath],
    });

    const activeId = await lookupNoteByPath(connection.db, activePath);
    if (activeId === null) {
      throw new Error("setup: failed to find active note after Tier 1");
    }
    await replaceChunks(connection.db, activeId, [
      {
        ord: 0,
        text: "A paragraph about POSIX limits in distributed file systems.",
        tokenEstimate: 12,
        vector: vectorOf(0.42),
        embedModel: EMBED_MODEL,
      },
    ]);

    const neighborId = await upsertNoteByPath(connection.db, {
      path: neighborPath,
      sha: "neighbor-sha",
      wordCount: 8,
    });
    await replaceChunks(connection.db, neighborId, [
      {
        ord: 0,
        text: "Distributed POSIX assumptions break at scale.",
        tokenEstimate: 8,
        vector: vectorOf(0.42),
        embedModel: EMBED_MODEL,
      },
    ]);
    await markTier3Done(connection.db, neighborId);
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

  test("[smoke] persists extractor + linker findings and stamps tier3_at", async () => {
    const extractorProvider = fakeProvider({
      chatJson: async <T>() =>
        ({ entities: ["POSIX"], claims: ["POSIX is leaky."], questions: ["Why?"] }) as T,
    });
    const extractor = new Extractor(extractorProvider, { model: "test-extractor-model" });

    const linkerProvider = fakeProvider({
      chatJson: async <T>(_messages: ChatMessage[], _opts: ChatOptions, _schema: JsonSchema) =>
        ({
          edges: [
            {
              targetNotePath: neighborPath,
              type: "supports",
              confidence: 0.85,
              rationale: "Both notes argue POSIX limits.",
              evidenceChunkIds: ["chunk-0"],
            },
          ],
        }) as T,
    });
    const linker = new Linker({
      db: connection.db,
      provider: linkerProvider,
      reasoningModel: "test-linker-model",
    });

    const inputChunks: Tier3Chunk[] = [
      {
        ord: 0,
        text: "A paragraph about POSIX limits in distributed file systems.",
        vector: vectorOf(0.42),
      },
    ];

    const result = await runTier3(connection.db, {
      notePath: activePath,
      chunks: inputChunks,
      extractor,
      linker,
    });

    const [mentionsRows] = await connection.db
      .query<[Array<{ approved: boolean; agent: string; source: string; class: string }>]>(
        "SELECT approved, agent, source, class FROM mentions WHERE in = $note;",
        { note: result.noteId },
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
        { note: result.noteId },
      )
      .collect<[Array<{ approved: boolean; agent: string }>]>();
    expect(assertsRows.length).toBe(1);
    expect(assertsRows[0].approved).toBe(true);
    expect(assertsRows[0].agent).toBe("extractor");

    const [asksRows] = await connection.db
      .query<[Array<{ approved: boolean; agent: string }>]>(
        "SELECT approved, agent FROM asks WHERE in = $note;",
        { note: result.noteId },
      )
      .collect<[Array<{ approved: boolean; agent: string }>]>();
    expect(asksRows.length).toBe(1);
    expect(asksRows[0].approved).toBe(true);

    const [conceptRows] = await connection.db
      .query<[Array<{ label: string }>]>("SELECT label FROM concept;")
      .collect<[Array<{ label: string }>]>();
    expect(conceptRows.some((row) => row.label === "POSIX")).toBe(true);

    const neighborId = await lookupNoteByPath(connection.db, neighborPath);
    if (neighborId === null) {
      throw new Error("smoke: neighbour note vanished mid-test");
    }

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
      >(
        "SELECT in, out, approved, agent, source FROM supports WHERE in = $active AND out = $neighbor;",
        { active: result.noteId, neighbor: neighborId },
      )
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
    expect(supportsRows[0].approved).toBe(false);
    expect(supportsRows[0].agent).toBe("linker");
    expect(supportsRows[0].source).toBe("linker");

    const [noteRows] = await connection.db
      .query<[Array<{ tier3_at: string | null }>]>("SELECT tier3_at FROM note WHERE id = $note;", {
        note: result.noteId,
      })
      .collect<[Array<{ tier3_at: string | null }>]>();
    expect(noteRows.length).toBe(1);
    expect(noteRows[0].tier3_at).not.toBeNull();
  });

  test("[smoke] throws when active note is not in SurrealDB", async () => {
    const extractor = new Extractor(fakeProvider({}), { model: "noop" });
    const linker = new Linker({
      db: connection.db,
      provider: fakeProvider({}),
      reasoningModel: "noop",
    });
    await expect(
      runTier3(connection.db, {
        notePath: "missing.md",
        chunks: [],
        extractor,
        linker,
      }),
    ).rejects.toThrow("runTier3: note not found by path 'missing.md'");
  });
});
