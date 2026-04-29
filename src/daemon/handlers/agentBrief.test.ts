import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { VaultFacade } from "../../core/chat/tools/vault";
import { Database, type DatabaseAdapter } from "../../core/db/database";
import type {
  ChatOptions,
  EmbedOptions,
  JsonSchema,
  LLMProvider,
  ChatMessage as ProviderChatMessage,
} from "../../core/llm/provider";
import type { SearchEvent, SearchHit, SearchQuery } from "../../core/search/types";
import {
  AGENT_BRIEF_DEFAULT_MAX_DECISIONS,
  AGENT_BRIEF_DEFAULT_MAX_NOTES,
  AGENT_BRIEF_DEFAULT_MAX_QUESTIONS,
  type BriefSearchPipeline,
  makeAgentBriefHandler,
} from "./agentBrief";

class MemAdapter implements DatabaseAdapter {
  files = new Map<string, ArrayBuffer>();
  constructor(init: Record<string, ArrayBuffer>) {
    for (const [k, v] of Object.entries(init)) this.files.set(k, v);
  }
  async readBinary(path: string): Promise<ArrayBuffer | null> {
    return this.files.get(path) ?? null;
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, data);
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
  async readNote(path: string): Promise<string> {
    const found = this.files.get(path);
    if (found === undefined) throw new Error(`missing fixture file: ${path}`);
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
  contradictionEvents?: Array<{
    pair: [string, string];
    severity: number;
    notePaths: string[];
  }>;
}

function seedDatabase(options: SeedOptions): void {
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
  for (const event of options.contradictionEvents ?? []) {
    options.database.run("INSERT INTO agent_events (ts, type, payload) VALUES (?,?,?);", [
      Date.now(),
      "swarm:contradiction_discovered",
      JSON.stringify({
        pair: event.pair,
        severity: event.severity,
        notePaths: event.notePaths,
      }),
    ]);
  }
}

describe("agent.brief handler", () => {
  test("topic mode returns relevantNotes, decisions, questions, and a stubbed summary", async () => {
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
    seedDatabase({
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

  test("file mode reads the fixture file and labels the topic from the basename", async () => {
    const database = await freshDatabase();
    seedDatabase({
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

  test("rejects empty topic", async () => {
    const handler = baseHandler();
    let thrown: unknown = null;
    try {
      await handler({ topic: "   " }, () => {}, "req-3", "claude-code");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("topic or filePath is required");
  });

  test("rejects missing both topic and filePath", async () => {
    const handler = baseHandler();
    let thrown: unknown = null;
    try {
      await handler({}, () => {}, "req-4", "claude-code");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("topic or filePath is required");
  });

  test("rejects when both topic and filePath are supplied", async () => {
    const handler = baseHandler();
    let thrown: unknown = null;
    try {
      await handler({ topic: "auth", filePath: "src/auth.ts" }, () => {}, "req-5", "claude-code");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("not both");
  });

  test("rejects '..' traversal in filePath", async () => {
    const handler = baseHandler();
    let thrown: unknown = null;
    try {
      await handler({ filePath: "../etc/passwd" }, () => {}, "req-6", "claude-code");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("'..' traversal");
  });

  test("honors maxNotes, maxQuestions, maxDecisions caps", async () => {
    const database = await freshDatabase();
    const hits: SearchHit[] = Array.from({ length: 6 }, (_, index) => ({
      notePath: `note-${index}.md`,
      chunkId: `c${index}`,
      snippet: `snippet ${index}`,
      score: 1 - index * 0.1,
      matchedText: "x",
    }));
    seedDatabase({
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

  test("LLM failure returns empty summary with structured fields populated", async () => {
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
    seedDatabase({
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

  test("contradiction events overlap on relevant note paths", async () => {
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
    seedDatabase({
      database,
      notes: [{ path: "auth/jwt.md", updatedAt: 100 }],
      contradictionEvents: [
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
      ],
    });
    const handler = makeAgentBriefHandler({
      database,
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

function baseHandler() {
  return makeAgentBriefHandler({
    database: stubDatabase(),
    searchPipeline: new ScriptedPipeline([]),
    vault: new InMemoryFacade(new Map()),
    provider: new StubProvider(),
    settings: SETTINGS,
  });
}

function stubDatabase(): Database {
  // Validation happens before any DB or pipeline call. Tests that exercise
  // negative paths never reach the database, so an unopened instance is fine.
  return new Database(new MemAdapter({}), { dbPath: "/db", wasmPath: "/wasm" });
}
