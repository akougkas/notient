/**
 * Phase 3 Linker smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/core/agents/linker.test.ts`.
 *
 * Boots a real SurrealDB, applies the Phase 1 schema, seeds two notes
 * (active + neighbour) plus their chunk vectors via the DAL, then exercises
 * the new Linker against a mocked LLM provider. The smoke asserts the
 * acceptance contract: zero-neighbour short circuit, one-neighbour
 * proposal-write path, strict model schema enforcement, and unresolvable
 * target path filtering.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { Linker, RANK_TO_CONFIDENCE } from "../../../../src/core/agents/linker";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  lookupNoteByPath,
  markTier2Done,
  markTier3Done,
  relateEdge,
  replaceChunks,
  upsertNoteByPath,
} from "../../../../src/core/db/surreal";
import { EventBus } from "../../../../src/core/events/eventBus";
import { LINKER } from "../../../../src/core/indexer/concurrencyDefaults";
import type {
  ChatMessage,
  ChatOptions,
  JsonSchema,
  LLMProvider,
} from "../../../../src/core/llm/provider";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

const VECTOR_DIM = 768;
const EMBEDDING_IDENTITY = { model: "linker-fixture", dimension: VECTOR_DIM } as const;
const AGENT_RUN_ID = 'agent_run:u"00000000-0000-4000-8000-000000000001"';

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
  const vector = new Array<number>(VECTOR_DIM).fill(0);
  vector[Math.round(seed * 10_000) % VECTOR_DIM] = 1;
  return vector;
}

async function seedNote(
  connection: SurrealConnection,
  notePath: string,
  vectorSeed: number,
  options: { tier3Done: boolean },
): Promise<RecordId<"note">> {
  const noteId = await upsertNoteByPath(connection.db, {
    path: notePath,
    sha: `sha-${notePath}`,
    wordCount: 10,
  });
  await replaceChunks(connection.db, noteId, EMBEDDING_IDENTITY, [
    {
      ord: 0,
      text: `body of ${notePath}`,
      tokenEstimate: 4,
      vector: vectorOf(vectorSeed),
    },
  ]);
  // Real Tier 2 stamps tier2_at after replaceChunks; linkerNeighbors gates
  // candidates on it.
  await markTier2Done(connection.db, noteId);
  if (options.tier3Done) {
    await markTier3Done(connection.db, noteId);
  }
  return noteId;
}

async function clearTier3Edges(connection: SurrealConnection): Promise<void> {
  for (const table of [
    "supports",
    "contradicts",
    "extends",
    "exemplifies",
    "synthesizes",
    "related_to",
  ]) {
    await connection.db.query(`DELETE ${table};`).collect();
  }
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] Linker", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase3-linker-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-linker-smoke-"));
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

  afterEach(async () => {
    await clearTier3Edges(connection);
    await connection.db.query("DELETE chunk; DELETE note;").collect();
  });

  test("[smoke] returns 0 proposals when no neighbours have tier3_at set", async () => {
    await seedNote(connection, "active.md", 0.42, { tier3Done: false });

    const provider = fakeProvider({
      chatJson: async <T>() => ({ edges: [] }) as T,
    });
    const linker = new Linker({ db: connection.db, provider, reasoningModel: "test-model" });
    const result = await linker.run({
      trigger: "vault-save",
      notePath: "active.md",
      signal: new AbortController().signal,
      runId: AGENT_RUN_ID,
      bus: new EventBus(),
    });
    expect(result.proposals).toBe(0);
  });

  test("[smoke] writes one supports edge with approved=false when LLM proposes a valid edge", async () => {
    await seedNote(connection, "active.md", 0.42, { tier3Done: false });
    await seedNote(connection, "neighbor.md", 0.42, { tier3Done: true });

    const provider = fakeProvider({
      chatJson: async <T>() =>
        ({
          edges: [
            {
              targetNotePath: "neighbor.md",
              type: "supports",
              rationale: "Both notes discuss the same topic.",
            },
          ],
        }) as T,
    });
    const linker = new Linker({ db: connection.db, provider, reasoningModel: "test-model" });
    const result = await linker.run({
      trigger: "vault-save",
      notePath: "active.md",
      signal: new AbortController().signal,
      runId: AGENT_RUN_ID,
      bus: new EventBus(),
    });
    expect(result.proposals).toBe(1);

    const [rows] = await connection.db
      .query<
        [
          Array<{
            agent: string;
            source: string;
            confidence: number;
            approved: boolean;
            class: string;
          }>,
        ]
      >("SELECT agent, source, confidence, approved, class FROM supports;")
      .collect<
        [
          Array<{
            agent: string;
            source: string;
            confidence: number;
            approved: boolean;
            class: string;
          }>,
        ]
      >();
    expect(rows.length).toBe(1);
    expect(rows[0].agent).toBe("linker");
    expect(rows[0].source).toBe("linker");
    expect(rows[0].class).toBe("INFERRED");
    expect(rows[0].approved).toBe(false);
    expect(rows[0].confidence).toBeCloseTo(RANK_TO_CONFIDENCE[0]);
  });

  test("[smoke] re-running linker replaces stale pending proposals instead of duplicating them", async () => {
    await seedNote(connection, "active.md", 0.42, { tier3Done: false });
    await seedNote(connection, "neighbor.md", 0.42, { tier3Done: true });

    const provider = fakeProvider({
      chatJson: async <T>() =>
        ({
          edges: [
            {
              targetNotePath: "neighbor.md",
              type: "supports",
              rationale: "Both notes discuss the same topic.",
            },
          ],
        }) as T,
    });
    const linker = new Linker({ db: connection.db, provider, reasoningModel: "test-model" });
    const context = {
      trigger: "vault-save" as const,
      notePath: "active.md",
      signal: new AbortController().signal,
      runId: AGENT_RUN_ID,
      bus: new EventBus(),
    };

    expect((await linker.run(context)).proposals).toBe(1);
    expect((await linker.run(context)).proposals).toBe(1);

    const [rows] = await connection.db
      .query<[Array<{ count: number }>]>("SELECT count() AS count FROM supports GROUP ALL;")
      .collect<[Array<{ count: number }>]>();
    expect(rows[0]?.count ?? 0).toBe(1);
  });

  test("[smoke] rejects proposals with unknown edge types", async () => {
    await seedNote(connection, "active.md", 0.42, { tier3Done: false });
    await seedNote(connection, "neighbor.md", 0.42, { tier3Done: true });

    const provider = fakeProvider({
      chatJson: async <T>() =>
        ({
          edges: [
            {
              targetNotePath: "neighbor.md",
              type: "definitely-not-allowed",
              rationale: "ignored",
            },
          ],
        }) as T,
    });
    const linker = new Linker({ db: connection.db, provider, reasoningModel: "test-model" });
    await expect(
      linker.run({
        trigger: "vault-save",
        notePath: "active.md",
        signal: new AbortController().signal,
        runId: AGENT_RUN_ID,
        bus: new EventBus(),
      }),
    ).rejects.toThrow("edge 0 is invalid");

    const [rows] = await connection.db
      .query<[Array<{ count: number }>]>("SELECT count() AS count FROM supports GROUP ALL;")
      .collect<[Array<{ count: number }>]>();
    expect(rows[0]?.count ?? 0).toBe(0);
  });

  test("[smoke] silently skips proposals whose targetNotePath does not resolve", async () => {
    await seedNote(connection, "active.md", 0.42, { tier3Done: false });
    await seedNote(connection, "neighbor.md", 0.42, { tier3Done: true });

    const provider = fakeProvider({
      chatJson: async <T>() =>
        ({
          edges: [
            {
              targetNotePath: "ghost.md",
              type: "supports",
              rationale: "ghost target",
            },
          ],
        }) as T,
    });
    const linker = new Linker({ db: connection.db, provider, reasoningModel: "test-model" });
    const result = await linker.run({
      trigger: "vault-save",
      notePath: "active.md",
      signal: new AbortController().signal,
      runId: AGENT_RUN_ID,
      bus: new EventBus(),
    });
    expect(result.proposals).toBe(0);

    const [rows] = await connection.db
      .query<[Array<{ count: number }>]>("SELECT count() AS count FROM supports GROUP ALL;")
      .collect<[Array<{ count: number }>]>();
    expect(rows[0]?.count ?? 0).toBe(0);
  });

  test("[smoke] wikilinked neighbours are excluded by linkerNeighbors so no proposal lands", async () => {
    const activeId = await seedNote(connection, "active.md", 0.42, { tier3Done: false });
    const neighborId = await seedNote(connection, "wikilinked.md", 0.42, { tier3Done: true });
    await relateEdge(connection.db, {
      table: "wikilink",
      from: activeId,
      to: neighborId,
      source: "wikilink",
      confidenceClass: "EXTRACTED",
      confidence: 1,
    });

    let chatJsonCalled = false;
    const provider = fakeProvider({
      chatJson: async <T>(_messages: ChatMessage[], _opts: ChatOptions, _schema: JsonSchema) => {
        chatJsonCalled = true;
        return { edges: [] } as T;
      },
    });
    const linker = new Linker({ db: connection.db, provider, reasoningModel: "test-model" });
    const result = await linker.run({
      trigger: "vault-save",
      notePath: "active.md",
      signal: new AbortController().signal,
      runId: AGENT_RUN_ID,
      bus: new EventBus(),
    });
    expect(result.proposals).toBe(0);
    // The pre-LLM neighbour query returns empty, so the LLM should never be
    // asked. lookupNoteByPath ran for the active note only.
    expect(chatJsonCalled).toBe(false);
  });

  test("[smoke] passes the active note signal through to chatJson", async () => {
    await seedNote(connection, "active.md", 0.42, { tier3Done: false });
    await seedNote(connection, "neighbor.md", 0.42, { tier3Done: true });

    let observed: AbortSignal | undefined;
    const provider = fakeProvider({
      chatJson: async <T>(_messages: ChatMessage[], opts: ChatOptions, _schema: JsonSchema) => {
        observed = opts.signal;
        return { edges: [] } as T;
      },
    });
    const controller = new AbortController();
    const linker = new Linker({ db: connection.db, provider, reasoningModel: "test-model" });
    await linker.run({
      trigger: "vault-save",
      notePath: "active.md",
      signal: controller.signal,
      runId: AGENT_RUN_ID,
      bus: new EventBus(),
    });
    expect(observed).toBe(controller.signal);
  });

  test("[smoke] caps candidates, evidence per candidate, and active-note chunks in the prompt", async () => {
    // 30 neighbours and a 12-chunk active note. Four kNN probes of k=20 would
    // otherwise put every reachable chunk into a single prompt.
    const activeId = await upsertNoteByPath(connection.db, {
      path: "active.md",
      sha: "sha-active",
      wordCount: 500,
    });
    await replaceChunks(
      connection.db,
      activeId,
      EMBEDDING_IDENTITY,
      Array.from({ length: 12 }, (_unused, index) => ({
        ord: index,
        text: `active chunk ${index} `.padEnd(400, "a"),
        tokenEstimate: 100,
        vector: vectorOf(0.4 + index * 0.001),
      })),
    );
    await markTier2Done(connection.db, activeId);
    for (let index = 0; index < 30; index += 1) {
      const neighborId = await upsertNoteByPath(connection.db, {
        path: `n${index}.md`,
        sha: `sha-n${index}`,
        wordCount: 200,
      });
      await replaceChunks(
        connection.db,
        neighborId,
        EMBEDDING_IDENTITY,
        // Three chunks each, so the evidence cap has something to cut.
        Array.from({ length: 3 }, (_unused, chunkOrd) => ({
          ord: chunkOrd,
          text: `neighbour ${index} chunk ${chunkOrd} `.padEnd(2000, "b"),
          tokenEstimate: 500,
          vector: vectorOf(0.4 + index * 0.002 + chunkOrd * 0.0001),
        })),
      );
      await markTier2Done(connection.db, neighborId);
    }

    interface LinkerPrompt {
      activeNote: { chunks: unknown[]; omitted?: string };
      neighbors: Array<{ notePath: string; evidence: string[] }>;
    }
    const prompts: LinkerPrompt[] = [];
    const provider = fakeProvider({
      chatJson: async <T>(messages: ChatMessage[]) => {
        const user = messages.find((message) => message.role === "user");
        const content = typeof user?.content === "string" ? user.content : "{}";
        prompts.push(JSON.parse(content) as LinkerPrompt);
        return { edges: [] } as T;
      },
    });
    const linker = new Linker({ db: connection.db, provider, reasoningModel: "test-model" });
    await linker.run({
      trigger: "vault-save",
      notePath: "active.md",
      signal: new AbortController().signal,
      runId: AGENT_RUN_ID,
      bus: new EventBus(),
    });

    expect(prompts).toHaveLength(1);
    const payload = prompts[0];
    expect(payload.neighbors.length).toBeLessThanOrEqual(LINKER.maxCandidates);
    expect(payload.neighbors.length).toBeGreaterThan(1);
    // Distinct notes only; the merge groups a note's chunks into one candidate.
    expect(new Set(payload.neighbors.map((n) => n.notePath)).size).toBe(payload.neighbors.length);
    for (const neighbor of payload.neighbors) {
      expect(neighbor.evidence.length).toBeLessThanOrEqual(LINKER.maxEvidencePerNote);
      for (const snippet of neighbor.evidence) {
        // 600-char slice plus the single-character ellipsis marker.
        expect(snippet.length).toBeLessThanOrEqual(LINKER.evidenceSnippetChars + 1);
      }
    }
    expect(payload.activeNote.chunks).toHaveLength(LINKER.maxActiveChunksInPrompt);
    expect(payload.activeNote.omitted).toBe(
      `[... ${12 - LINKER.maxActiveChunksInPrompt} more chunks]`,
    );
  });
});
