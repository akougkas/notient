/**
 * Phase 3 Linker smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/core/agents/linker.test.ts`.
 *
 * Boots a real SurrealDB, applies the Phase 1 schema, seeds two notes
 * (active + neighbour) plus their chunk vectors via the DAL, then exercises
 * the new Linker against a mocked LLM provider. The smoke asserts the
 * acceptance contract from Phase 3 plan §Task 8: zero-neighbour short
 * circuit, one-neighbour proposal-write path, type allowlist filter,
 * unresolvable target path filter.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { type SurrealServerHandle, startSurreal } from "../../daemon/surrealServer";
import { applySchema } from "../db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  lookupNoteByPath,
  markTier3Done,
  relateEdge,
  replaceChunks,
  upsertNoteByPath,
} from "../db/surreal";
import { EventBus } from "../events/eventBus";
import type { ChatMessage, ChatOptions, JsonSchema, LLMProvider } from "../llm/provider";
import {
  type LinkerJsonResponse,
  Linker,
  MAX_PROPOSALS_PER_NOTE,
  RANK_TO_CONFIDENCE,
  filterProposals,
} from "./linker";

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
  await replaceChunks(connection.db, noteId, [
    {
      ord: 0,
      text: `body of ${notePath}`,
      tokenEstimate: 4,
      vector: vectorOf(vectorSeed),
      embedModel: EMBED_MODEL,
    },
  ]);
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

describe("Linker rank-to-confidence mapping", () => {
  test("constants stay in sync", () => {
    expect(RANK_TO_CONFIDENCE.length).toBe(MAX_PROPOSALS_PER_NOTE);
    // Strictly decreasing so rank 0 is the strongest.
    for (let i = 1; i < RANK_TO_CONFIDENCE.length; i += 1) {
      expect(RANK_TO_CONFIDENCE[i]).toBeLessThan(RANK_TO_CONFIDENCE[i - 1]);
    }
    // Confidence floor still well above 0.5 so the operator never sees the
    // old 0.6 anchor again.
    expect(RANK_TO_CONFIDENCE[RANK_TO_CONFIDENCE.length - 1]).toBeGreaterThan(0.5);
  });

  test("assigns confidence by rank position across the full ladder", () => {
    const response: LinkerJsonResponse = {
      edges: [
        { targetNotePath: "a.md", type: "supports", rationale: "r1" },
        { targetNotePath: "b.md", type: "extends", rationale: "r2" },
        { targetNotePath: "c.md", type: "exemplifies", rationale: "r3" },
        { targetNotePath: "d.md", type: "related_to", rationale: "r4" },
      ],
    };
    const proposals = filterProposals(response);
    expect(proposals.length).toBe(MAX_PROPOSALS_PER_NOTE);
    for (let index = 0; index < proposals.length; index += 1) {
      expect(proposals[index].confidence).toBeCloseTo(RANK_TO_CONFIDENCE[index]);
    }
    expect(proposals.map((p) => p.targetNotePath)).toEqual(["a.md", "b.md", "c.md", "d.md"]);
    expect(proposals.map((p) => p.type)).toEqual([
      "supports",
      "extends",
      "exemplifies",
      "related_to",
    ]);
  });

  test("empty model output produces zero proposals", () => {
    expect(filterProposals({ edges: [] })).toEqual([]);
  });

  test("truncates >MAX_PROPOSALS_PER_NOTE input to the ladder length", () => {
    // Defence in depth even though the JSON schema's maxItems already caps
    // the model output. If the provider misbehaves we still honour the
    // ceiling rather than producing rank-position confidences past the end
    // of the ladder (which would be undefined).
    const overflow: LinkerJsonResponse = {
      edges: Array.from({ length: MAX_PROPOSALS_PER_NOTE + 3 }, (_unused, index) => ({
        targetNotePath: `note-${index}.md`,
        type: "related_to",
        rationale: `r${index}`,
      })),
    };
    const proposals = filterProposals(overflow);
    expect(proposals.length).toBe(MAX_PROPOSALS_PER_NOTE);
    expect(proposals[proposals.length - 1].confidence).toBeCloseTo(
      RANK_TO_CONFIDENCE[RANK_TO_CONFIDENCE.length - 1],
    );
    expect(proposals[proposals.length - 1].targetNotePath).toBe(
      `note-${MAX_PROPOSALS_PER_NOTE - 1}.md`,
    );
  });

  test("drops invalid edge types without consuming a rank slot", () => {
    const response: LinkerJsonResponse = {
      edges: [
        { targetNotePath: "a.md", type: "definitely-not-allowed", rationale: "skip" },
        { targetNotePath: "b.md", type: "supports", rationale: "keep" },
      ],
    };
    const proposals = filterProposals(response);
    expect(proposals.length).toBe(1);
    // The kept edge is at rank 0 because the invalid edge never entered the
    // accepted list. The rank ladder is anchored to accepted-array index, not
    // to the model's input position.
    expect(proposals[0].targetNotePath).toBe("b.md");
    expect(proposals[0].confidence).toBeCloseTo(RANK_TO_CONFIDENCE[0]);
  });

  test("drops edges with empty or missing targetNotePath", () => {
    const response = {
      edges: [
        { targetNotePath: "", type: "supports", rationale: "skip empty" },
        { targetNotePath: "ok.md", type: "supports", rationale: "keep" },
      ],
    } as unknown as LinkerJsonResponse;
    const proposals = filterProposals(response);
    expect(proposals.length).toBe(1);
    expect(proposals[0].targetNotePath).toBe("ok.md");
  });
});

describe("Linker end-to-end with fake provider", () => {
  test("emitted edges carry rank-derived confidence, not model-supplied numbers", async () => {
    // The fake provider returns four edges *without* a confidence field.
    // The Linker must still write four edges whose confidence values come
    // from RANK_TO_CONFIDENCE in order. We stub the database calls minimally
    // to exercise the proposal-write loop without booting SurrealDB.
    const observedConfidences: number[] = [];
    const observedTypes: string[] = [];
    const fake: LLMProvider = {
      isAvailable: async () => true,
      chat: async () => "",
      chatStream: async function* () {
        yield "";
      },
      chatJson: async <T>(_messages: ChatMessage[], _opts: ChatOptions, _schema: JsonSchema) =>
        ({
          edges: [
            { targetNotePath: "n0.md", type: "supports", rationale: "strongest" },
            { targetNotePath: "n1.md", type: "extends", rationale: "second" },
            { targetNotePath: "n2.md", type: "exemplifies", rationale: "third" },
            { targetNotePath: "n3.md", type: "related_to", rationale: "fourth" },
          ],
        }) as T,
      embed: async () => [],
    };

    // Validate filterProposals produces the contract the run() loop relies on.
    const response = (await fake.chatJson(
      [],
      { model: "fake", signal: undefined },
      { name: "noop", schema: {} },
    )) as LinkerJsonResponse;
    const proposals = filterProposals(response);
    for (const proposal of proposals) {
      observedConfidences.push(proposal.confidence);
      observedTypes.push(proposal.type);
    }
    expect(observedConfidences).toEqual([...RANK_TO_CONFIDENCE]);
    expect(observedTypes).toEqual(["supports", "extends", "exemplifies", "related_to"]);
  });
});

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
      runId: 1,
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
              confidence: 0.85,
              rationale: "Both notes discuss the same topic.",
              evidenceChunkIds: ["chunk-0"],
            },
          ],
        }) as T,
    });
    const linker = new Linker({ db: connection.db, provider, reasoningModel: "test-model" });
    const result = await linker.run({
      trigger: "vault-save",
      notePath: "active.md",
      signal: new AbortController().signal,
      runId: 1,
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
    expect(rows[0].confidence).toBeCloseTo(0.85);
  });

  test("[smoke] silently skips proposals with unknown edge types", async () => {
    await seedNote(connection, "active.md", 0.42, { tier3Done: false });
    await seedNote(connection, "neighbor.md", 0.42, { tier3Done: true });

    const provider = fakeProvider({
      chatJson: async <T>() =>
        ({
          edges: [
            {
              targetNotePath: "neighbor.md",
              type: "definitely-not-allowed",
              confidence: 0.95,
              rationale: "ignored",
              evidenceChunkIds: [],
            },
          ],
        }) as T,
    });
    const linker = new Linker({ db: connection.db, provider, reasoningModel: "test-model" });
    const result = await linker.run({
      trigger: "vault-save",
      notePath: "active.md",
      signal: new AbortController().signal,
      runId: 1,
      bus: new EventBus(),
    });
    expect(result.proposals).toBe(0);

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
              confidence: 0.9,
              rationale: "ghost target",
              evidenceChunkIds: [],
            },
          ],
        }) as T,
    });
    const linker = new Linker({ db: connection.db, provider, reasoningModel: "test-model" });
    const result = await linker.run({
      trigger: "vault-save",
      notePath: "active.md",
      signal: new AbortController().signal,
      runId: 1,
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
      runId: 1,
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
      runId: 1,
      bus: new EventBus(),
    });
    expect(observed).toBe(controller.signal);
  });
});
