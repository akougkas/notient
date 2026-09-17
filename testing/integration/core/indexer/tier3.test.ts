/**
 * Real-Surreal Tier 3 coverage for extracted findings, reviewed Linker edges,
 * durable run provenance, persisted swarm events, and the completion stamp.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { Linker } from "../../../../src/core/agents/linker";
import { AgentRunExecutor } from "../../../../src/core/coordinator/agentRunExecutor";
import { ReasoningScheduler } from "../../../../src/core/coordinator/reasoningScheduler";
import { parseUuidRecordId } from "../../../../src/core/db/recordId";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  fetchChunksForTier3,
  lookupNoteByPath,
  markTier2Done,
  markTier3Done,
  replaceChunks,
  upsertNoteByPath,
} from "../../../../src/core/db/surreal";
import { EventBus } from "../../../../src/core/events/eventBus";
import { Extractor } from "../../../../src/core/indexer/extractor";
import { runTier1 } from "../../../../src/core/indexer/tier1";
import { type Tier3Chunk, runTier3 } from "../../../../src/core/indexer/tier3";
import type {
  ChatMessage,
  ChatOptions,
  JsonSchema,
  LLMProvider,
} from "../../../../src/core/llm/provider";
import { AgentEventStore } from "../../../../src/core/services/agentEventStore";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

const VECTOR_DIM = 768;
const EMBEDDING_IDENTITY = { model: "tier3-fixture", dimension: VECTOR_DIM } as const;

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
      notePath: activePath,
      source: activeNoteSource,
      vaultPaths: [activePath],
      bus: new EventBus(),
    });

    const activeId = await lookupNoteByPath(connection.db, activePath);
    if (activeId === null) {
      throw new Error("setup: failed to find active note after Tier 1");
    }
    await replaceChunks(connection.db, activeId, EMBEDDING_IDENTITY, [
      {
        ord: 0,
        text: "A paragraph about POSIX limits in distributed file systems.",
        tokenEstimate: 12,
        vector: vectorOf(0.42),
      },
    ]);

    const neighborId = await upsertNoteByPath(connection.db, {
      path: neighborPath,
      sha: "neighbor-sha",
      wordCount: 8,
    });
    await replaceChunks(connection.db, neighborId, EMBEDDING_IDENTITY, [
      {
        ord: 0,
        text: "Distributed POSIX assumptions break at scale.",
        tokenEstimate: 8,
        vector: vectorOf(0.42),
      },
    ]);
    // linkerNeighbors gates candidates on `tier2_at`, which real Tier 2 stamps
    // after replaceChunks. The seeding here bypasses Tier 2, so stamp it
    // explicitly or the neighbour is invisible to the kNN probe.
    await markTier2Done(connection.db, neighborId);
    await markTier3Done(connection.db, neighborId);
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

  test("[smoke] persists extractor + linker findings and stamps tier3_at", async () => {
    const scheduler = new ReasoningScheduler({ maxConcurrent: 1 });
    const extractorProvider = fakeProvider({
      chatJson: async <T>() =>
        ({
          entities: [{ label: "POSIX", kind: "system", chunkRefs: [0] }],
          claims: [{ text: "POSIX is leaky.", kind: "assertion", chunkRefs: [0] }],
          questions: [{ text: "Why?", chunkRefs: [0] }],
        }) as T,
    });
    const extractor = new Extractor(extractorProvider, {
      model: "test-extractor-model",
      scheduler,

      concurrency: 1,
    });

    const linkerProvider = fakeProvider({
      chatJson: async <T>(_messages: ChatMessage[], _opts: ChatOptions, _schema: JsonSchema) =>
        ({
          edges: [
            {
              targetNotePath: neighborPath,
              type: "supports",
              rationale: "Both notes argue POSIX limits.",
            },
          ],
        }) as T,
    });
    const linker = new Linker({
      db: connection.db,
      provider: linkerProvider,
      reasoningModel: "test-linker-model",
    });
    const bus = new EventBus();
    const eventStore = new AgentEventStore({ db: connection.db, bus, maxRows: 50_000 });
    const executor = new AgentRunExecutor({ db: connection.db, bus, scheduler, now: Date.now });
    const runLinker = executor.bind(linker);

    // Read the real chunk rows so each Tier3Chunk carries its `chunk` record
    // id; that is what lets the windowed extractor's chunkRefs land in the
    // `evidence` field on the extractor edges.
    const activeNoteId = await lookupNoteByPath(connection.db, activePath);
    if (activeNoteId === null) throw new Error("test: active note vanished");
    const inputChunks: Tier3Chunk[] = await fetchChunksForTier3(
      connection.db,
      activeNoteId,
      EMBEDDING_IDENTITY,
    );
    expect(inputChunks).toHaveLength(1);

    const result = await runTier3(connection.db, {
      notePath: activePath,
      chunks: inputChunks,
      extractor,
      runLinker,
    });

    // One chunk fits in one extraction window and uses one structured-output call.
    expect(result.extractionWindows).toBe(1);
    expect(result.llmCalls).toBe(1);

    type MentionsRow = {
      approved: boolean;
      agent: string;
      source: string;
      class: string;
      evidence: unknown[] | undefined;
    };
    const [mentionsRows] = await connection.db
      .query<[MentionsRow[]]>(
        "SELECT approved, agent, source, class, evidence FROM mentions WHERE in = $note;",
        { note: result.noteId },
      )
      .collect<[MentionsRow[]]>();
    expect(mentionsRows.length).toBe(1);
    // Chunk-level evidence survives windowed extraction.
    expect(mentionsRows[0].evidence?.length).toBe(1);
    expect(String(mentionsRows[0].evidence?.[0])).toBe(String(inputChunks[0].id));
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

    eventStore.dispose();
    await eventStore.drain();
    const persistedSwarmEvents = (await eventStore.since(null, 100)).filter(
      (event) => event.type === "swarm:link_proposed",
    );
    const swarmRunIds = persistedSwarmEvents.map((event) => {
      const payload = event.payload as { runId?: unknown };
      expect(typeof payload.runId).toBe("string");
      expect(payload.runId).toMatch(/^agent_run:u"[0-9a-f-]{36}"$/);
      return payload.runId as string;
    });
    expect(swarmRunIds).toHaveLength(1);
    const [runRows] = await connection.db
      .query<
        [
          Array<{
            id: RecordId<"agent_run">;
            trigger: string;
            ok: boolean;
            finished_at?: Date | string;
          }>,
        ]
      >("SELECT id, trigger, ok, finished_at FROM agent_run WHERE id IN $runIds;", {
        runIds: swarmRunIds.map((runId) => parseUuidRecordId(runId, "agent_run", "runId")),
      })
      .collect<
        [
          Array<{
            id: RecordId<"agent_run">;
            trigger: string;
            ok: boolean;
            finished_at?: Date | string;
          }>,
        ]
      >();
    expect(runRows).toHaveLength(swarmRunIds.length);
    expect(runRows[0].id.toString()).toBe(swarmRunIds[0]);
    expect(runRows[0].trigger).toBe("vault-save");
    expect(runRows[0].ok).toBe(true);
    expect(runRows[0].finished_at).toBeDefined();

    const [noteRows] = await connection.db
      .query<[Array<{ tier3_at: string | null }>]>("SELECT tier3_at FROM note WHERE id = $note;", {
        note: result.noteId,
      })
      .collect<[Array<{ tier3_at: string | null }>]>();
    expect(noteRows.length).toBe(1);
    expect(noteRows[0].tier3_at).not.toBeNull();
  });

  test("[smoke] throws when active note is not in SurrealDB", async () => {
    const scheduler = new ReasoningScheduler({ maxConcurrent: 1 });
    const extractor = new Extractor(fakeProvider({}), { model: "noop", scheduler, concurrency: 1 });
    const linker = new Linker({
      db: connection.db,
      provider: fakeProvider({}),
      reasoningModel: "noop",
    });
    const executor = new AgentRunExecutor({
      db: connection.db,
      bus: new EventBus(),
      scheduler,
      now: Date.now,
    });
    await expect(
      runTier3(connection.db, {
        notePath: "missing.md",
        chunks: [],
        extractor,
        runLinker: executor.bind(linker),
      }),
    ).rejects.toThrow("runTier3: note not found by path 'missing.md'");
  });
});
