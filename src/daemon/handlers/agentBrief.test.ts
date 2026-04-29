/**
 * Phase 4 Task 12 agent.brief handler smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/daemon/handlers/`.
 *
 * The handler keeps a hybrid storage footprint until a follow-up task
 * migrates `notes` and `graph_nodes` off SQLite: the contradiction event
 * lookup reads from the SurrealDB-backed `agent_event` ledger, while
 * `notes.updated_at` and `graph_nodes` continue to read through the
 * SQLite mirror. This test boots both backends so both reads are
 * exercised against real storage end-to-end.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolve } from "node:path";
import type { VaultFacade } from "../../core/chat/tools/vault";
import { Database, type DatabaseAdapter } from "../../core/db/database";
import { applySchema } from "../../core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../core/db/surreal";
import type {
  ChatOptions,
  EmbedOptions,
  JsonSchema,
  LLMProvider,
  ChatMessage as ProviderChatMessage,
} from "../../core/llm/provider";
import type { SearchEvent, SearchHit, SearchQuery } from "../../core/search/types";
import { type SurrealServerHandle, startSurreal } from "../surrealServer";
import {
  AGENT_BRIEF_DEFAULT_MAX_DECISIONS,
  AGENT_BRIEF_DEFAULT_MAX_NOTES,
  AGENT_BRIEF_DEFAULT_MAX_QUESTIONS,
  type BriefSearchPipeline,
  makeAgentBriefHandler,
} from "./agentBrief";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

class MemAdapter implements DatabaseAdapter {
  files = new Map<string, ArrayBuffer>();
  constructor(init: Record<string, ArrayBuffer>) {
    for (const [k, v] of Object.entries(init)) this.files.set(k, v);
  }
  async readBinary(filePath: string): Promise<ArrayBuffer | null> {
    return this.files.get(filePath) ?? null;
  }
  async writeBinary(filePath: string, data: ArrayBuffer): Promise<void> {
    this.files.set(filePath, data);
  }
}

function loadWasm(): ArrayBuffer {
  const buffer = readFileSync(
    resolve(import.meta.dir, "../../../node_modules/sql.js/dist/sql-wasm.wasm"),
  );
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

async function freshDatabase(): Promise<Database> {
  const database = new Database(new MemAdapter({ "/wasm": loadWasm() }), {
    dbPath: "/db",
    wasmPath: "/wasm",
  });
  await database.init();
  return database;
}

class StubProvider implements LLMProvider {
  public readonly chatCalls: ProviderChatMessage[][] = [];
  constructor(
    private readonly behavior: { reply?: string; throwError?: boolean } = { reply: "" },
  ) {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async chat(messages: ProviderChatMessage[], _options: ChatOptions): Promise<string> {
    this.chatCalls.push(messages);
    if (this.behavior.throwError === true) {
      throw new Error("provider unavailable");
    }
    return this.behavior.reply ?? "";
  }
  async *chatStream(
    _messages: ProviderChatMessage[],
    _options: ChatOptions,
  ): AsyncIterable<string> {
    yield "";
  }
  async chatJson<T>(
    _messages: ProviderChatMessage[],
    _options: ChatOptions,
    _schema: JsonSchema,
  ): Promise<T> {
    return {} as T;
  }
  async embed(_input: string[], _options: EmbedOptions): Promise<number[][]> {
    return [];
  }
}

class ScriptedPipeline implements BriefSearchPipeline {
  public readonly queries: SearchQuery[] = [];
  constructor(private readonly hits: SearchHit[]) {}
  async *run(query: SearchQuery, _signal: AbortSignal): AsyncIterable<SearchEvent> {
    this.queries.push(query);
    yield { type: "search:retrieving", mode: query.mode };
    yield { type: "search:hits", hits: this.hits };
    yield {
      type: "search:done",
      result: { query: query.query, mode: query.mode, hits: this.hits, durationMs: 1 },
    };
  }
}

class InMemoryFacade implements VaultFacade {
  constructor(private readonly files: Map<string, string>) {}
  async readNote(filePath: string): Promise<string> {
    const found = this.files.get(filePath);
    if (found === undefined) throw new Error(`missing fixture file: ${filePath}`);
    return found;
  }
}

const SETTINGS = (): { model: string } => ({ model: "test-model" });

interface SeedOptions {
  database: Database;
  notes: Array<{ path: string; updatedAt: number }>;
  claims?: Array<{
    id: string;
    label: string;
    notePath: string;
    payload: Record<string, unknown>;
    createdAt: number;
  }>;
  questions?: Array<{
    id: string;
    label: string;
    notePath: string;
    payload: Record<string, unknown> | null;
  }>;
}

function seedSqlite(options: SeedOptions): void {
  for (const note of options.notes) {
    options.database.run(
      "INSERT INTO notes (path, sha, word_count, maturity, indexed_at, updated_at) VALUES (?,?,?,?,?,?);",
      [note.path, "sha", 100, "raw", note.updatedAt, note.updatedAt],
    );
  }
  for (const claim of options.claims ?? []) {
    options.database.run(
      `INSERT INTO graph_nodes (id, type, label, note_path, payload, created_at)
       VALUES (?,?,?,?,?,?);`,
      [
        claim.id,
        "claim",
        claim.label,
        claim.notePath,
        JSON.stringify(claim.payload),
        claim.createdAt,
      ],
    );
  }
  for (const question of options.questions ?? []) {
    options.database.run(
      `INSERT INTO graph_nodes (id, type, label, note_path, payload, created_at)
       VALUES (?,?,?,?,?,?);`,
      [
        question.id,
        "question",
        question.label,
        question.notePath,
        question.payload === null ? null : JSON.stringify(question.payload),
        1,
      ],
    );
  }
}

interface ContradictionEvent {
  pair: [string, string];
  severity: number;
  notePaths: string[];
}

async function nextSeq(connection: SurrealConnection): Promise<number> {
  const [rows] = await connection.db
    .query<[Array<{ seq: number }>]>("SELECT seq FROM agent_event ORDER BY seq DESC LIMIT 1;")
    .collect<[Array<{ seq: number }>]>();
  return (rows[0]?.seq ?? 0) + 1;
}

async function seedContradictions(
  connection: SurrealConnection,
  events: ContradictionEvent[],
): Promise<void> {
  for (const event of events) {
    const seq = await nextSeq(connection);
    await connection.db
      .query(
        "CREATE agent_event CONTENT { seq: $seq, kind: 'swarm:contradiction_discovered', payload: $payload, ts_ms: $tsMs };",
        {
          seq,
          payload: JSON.stringify({
            pair: event.pair,
            severity: event.severity,
            notePaths: event.notePaths,
          }),
          tsMs: Date.now(),
        },
      )
      .collect();
  }
}

async function clearLedger(connection: SurrealConnection): Promise<void> {
  await connection.db.query("DELETE agent_event;").collect();
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] agent.brief handler", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase4-agentbrief-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-agentbrief-smoke-"));
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
    await clearLedger(connection);
  });

  test("[smoke] topic mode returns relevantNotes, decisions, questions, and a stubbed summary", async () => {
    const database = await freshDatabase();
    const hits: SearchHit[] = [
      {
        notePath: "auth/oauth.md",
        chunkId: "c1",
        snippet: "OAuth flow uses PKCE.",
        score: 0.92,
        matchedText: "auth",
      },
      {
        notePath: "auth/jwt.md",
        chunkId: "c2",
        snippet: "JWT bearer tokens with rotating refresh.",
        score: 0.88,
        matchedText: "auth",
      },
    ];
    seedSqlite({
      database,
      notes: [
        { path: "auth/oauth.md", updatedAt: 1_700_000_000 },
        { path: "auth/jwt.md", updatedAt: 1_700_000_500 },
        { path: "unrelated.md", updatedAt: 1_600_000_000 },
      ],
      claims: [
        {
          id: "claim:1",
          label: "We use PKCE for the OAuth flow.",
          notePath: "auth/oauth.md",
          payload: { text: "...", maturity: "decision" },
          createdAt: 100,
        },
        {
          id: "claim:2",
          label: "JWT refresh window is short.",
          notePath: "auth/jwt.md",
          payload: { text: "...", maturity: "decision" },
          createdAt: 200,
        },
        {
          id: "claim:3",
          label: "Exploratory: maybe move to opaque tokens.",
          notePath: "auth/jwt.md",
          payload: { text: "..." },
          createdAt: 300,
        },
        {
          id: "claim:elsewhere",
          label: "Unrelated note decision.",
          notePath: "unrelated.md",
          payload: { text: "...", maturity: "decision" },
          createdAt: 400,
        },
      ],
      questions: [
        {
          id: "question:1",
          label: "What is the refresh window?",
          notePath: "auth/jwt.md",
          payload: null,
        },
        {
          id: "question:answered",
          label: "Already answered.",
          notePath: "auth/oauth.md",
          payload: { answered: true },
        },
        {
          id: "question:elsewhere",
          label: "Outside the relevant set.",
          notePath: "unrelated.md",
          payload: null,
        },
      ],
    });
    const pipeline = new ScriptedPipeline(hits);
    const provider = new StubProvider({ reply: "  Auth is OAuth+PKCE with short JWTs.  " });
    const handler = makeAgentBriefHandler({
      database,
      surrealDb: connection.db,
      searchPipeline: pipeline,
      vault: new InMemoryFacade(new Map()),
      provider,
      settings: SETTINGS,
    });

    const result = await handler({ topic: "authentication" }, () => {}, "req-1", "claude-code");
    expect(result.ok).toBe(true);
    expect(result.topic).toBe("authentication");
    expect(result.summary).toBe("Auth is OAuth+PKCE with short JWTs.");
    expect(pipeline.queries).toHaveLength(1);
    expect(pipeline.queries[0].query).toBe("authentication");
    expect(pipeline.queries[0].mode).toBe("balanced");

    const relevantNotes = result.relevantNotes as Array<{ path: string; lastTouchedAt: number }>;
    expect(relevantNotes).toHaveLength(2);
    expect(relevantNotes[0].path).toBe("auth/oauth.md");
    expect(relevantNotes[0].lastTouchedAt).toBe(1_700_000_000);
    expect(relevantNotes[1].path).toBe("auth/jwt.md");

    const decisions = result.recentDecisions as Array<{ id: string; notePath: string }>;
    expect(decisions.map((decision) => decision.id)).toEqual(["claim:2", "claim:1"]);
    for (const decision of decisions) {
      expect(decision.notePath === "auth/oauth.md" || decision.notePath === "auth/jwt.md").toBe(
        true,
      );
    }

    const questions = result.openQuestions as Array<{ id: string }>;
    expect(questions.map((question) => question.id)).toEqual(["question:1"]);

    const contradictions = result.openContradictions as unknown[];
    expect(contradictions).toEqual([]);

    expect(typeof result.durationMs).toBe("number");
  });

  test("[smoke] file mode reads the fixture file and labels the topic from the basename", async () => {
    const database = await freshDatabase();
    seedSqlite({
      database,
      notes: [{ path: "guides/oauth.md", updatedAt: 1_700_000_000 }],
    });
    const fixtureFiles = new Map<string, string>([
      ["src/auth/oauth.ts", "export function authorize() {\n  // OAuth bearer flow with PKCE.\n}"],
    ]);
    const hits: SearchHit[] = [
      {
        notePath: "guides/oauth.md",
        chunkId: "c1",
        snippet: "OAuth guide.",
        score: 0.5,
        matchedText: "oauth",
      },
    ];
    const pipeline = new ScriptedPipeline(hits);
    const provider = new StubProvider({ reply: "Brief about OAuth code." });
    const handler = makeAgentBriefHandler({
      database,
      surrealDb: connection.db,
      searchPipeline: pipeline,
      vault: new InMemoryFacade(fixtureFiles),
      provider,
      settings: SETTINGS,
    });

    const result = await handler(
      { filePath: "src/auth/oauth.ts" },
      () => {},
      "req-2",
      "claude-code",
    );
    expect(result.topic).toBe("oauth");
    expect(pipeline.queries[0].query).toContain("OAuth bearer flow with PKCE");
    const relevantNotes = result.relevantNotes as Array<{ path: string }>;
    expect(relevantNotes[0].path).toBe("guides/oauth.md");
  });

  test("[smoke] honors maxNotes, maxQuestions, maxDecisions caps", async () => {
    const database = await freshDatabase();
    const hits: SearchHit[] = Array.from({ length: 6 }, (_, index) => ({
      notePath: `note-${index}.md`,
      chunkId: `c${index}`,
      snippet: `snippet ${index}`,
      score: 1 - index * 0.1,
      matchedText: "x",
    }));
    seedSqlite({
      database,
      notes: hits.map((hit, index) => ({ path: hit.notePath, updatedAt: 100 + index })),
      claims: hits.map((hit, index) => ({
        id: `claim:${index}`,
        label: `Decision ${index}`,
        notePath: hit.notePath,
        payload: { maturity: "decision" },
        createdAt: 1000 + index,
      })),
      questions: hits.map((hit, index) => ({
        id: `question:${index}`,
        label: `Question ${index}`,
        notePath: hit.notePath,
        payload: null,
      })),
    });
    const handler = makeAgentBriefHandler({
      database,
      surrealDb: connection.db,
      searchPipeline: new ScriptedPipeline(hits),
      vault: new InMemoryFacade(new Map()),
      provider: new StubProvider({ reply: "summary" }),
      settings: SETTINGS,
    });

    const result = await handler(
      { topic: "anything", maxNotes: 3, maxQuestions: 2, maxDecisions: 1 },
      () => {},
      "req-7",
      "claude-code",
    );
    const relevantNotes = result.relevantNotes as unknown[];
    const decisions = result.recentDecisions as unknown[];
    const questions = result.openQuestions as unknown[];
    expect(relevantNotes).toHaveLength(3);
    expect(decisions).toHaveLength(1);
    expect(questions).toHaveLength(2);
  });

  test("[smoke] LLM failure returns empty summary with structured fields populated", async () => {
    const database = await freshDatabase();
    const hits: SearchHit[] = [
      {
        notePath: "auth/jwt.md",
        chunkId: "c1",
        snippet: "JWT.",
        score: 0.9,
        matchedText: "x",
      },
    ];
    seedSqlite({
      database,
      notes: [{ path: "auth/jwt.md", updatedAt: 100 }],
      claims: [
        {
          id: "claim:1",
          label: "JWT refresh is short.",
          notePath: "auth/jwt.md",
          payload: { maturity: "decision" },
          createdAt: 1,
        },
      ],
    });
    const provider = new StubProvider({ throwError: true });
    const handler = makeAgentBriefHandler({
      database,
      surrealDb: connection.db,
      searchPipeline: new ScriptedPipeline(hits),
      vault: new InMemoryFacade(new Map()),
      provider,
      settings: SETTINGS,
    });
    const result = await handler({ topic: "auth" }, () => {}, "req-8", "claude-code");
    expect(result.summary).toBe("");
    const decisions = result.recentDecisions as Array<{ id: string }>;
    expect(decisions.map((decision) => decision.id)).toEqual(["claim:1"]);
    const relevantNotes = result.relevantNotes as Array<{ path: string }>;
    expect(relevantNotes[0].path).toBe("auth/jwt.md");
  });

  test("[smoke] contradiction events overlap on relevant note paths", async () => {
    const database = await freshDatabase();
    const hits: SearchHit[] = [
      {
        notePath: "auth/jwt.md",
        chunkId: "c1",
        snippet: "JWT.",
        score: 0.9,
        matchedText: "auth",
      },
    ];
    seedSqlite({
      database,
      notes: [{ path: "auth/jwt.md", updatedAt: 100 }],
    });
    await seedContradictions(connection, [
      {
        pair: ["claim:a", "claim:b"],
        severity: 0.8,
        notePaths: ["auth/jwt.md", "other.md"],
      },
      {
        pair: ["claim:c", "claim:d"],
        severity: 0.6,
        notePaths: ["unrelated.md"],
      },
    ]);
    const handler = makeAgentBriefHandler({
      database,
      surrealDb: connection.db,
      searchPipeline: new ScriptedPipeline(hits),
      vault: new InMemoryFacade(new Map()),
      provider: new StubProvider({ reply: "summary" }),
      settings: SETTINGS,
    });
    const result = await handler({ topic: "auth" }, () => {}, "req-9", "claude-code");
    const contradictions = result.openContradictions as Array<{ pair: [string, string] }>;
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0].pair).toEqual(["claim:a", "claim:b"]);
  });
});

describe("agent.brief defaults", () => {
  test("default cap constants stay aligned with the RPC contract", () => {
    expect(AGENT_BRIEF_DEFAULT_MAX_NOTES).toBe(8);
    expect(AGENT_BRIEF_DEFAULT_MAX_QUESTIONS).toBe(5);
    expect(AGENT_BRIEF_DEFAULT_MAX_DECISIONS).toBe(5);
  });
});
