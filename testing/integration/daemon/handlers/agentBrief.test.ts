/**
 * Phase 5 Task 4 agent.brief handler smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/daemon/handlers/`.
 *
 * Migrated to a SurrealDB-only fixture: `notes.updated_at` and
 * `graph_nodes` carry-forwards retired in Phase 5 Task 4. The test boots
 * a real SurrealDB, applies the Phase 1 schema, seeds `note`, `claim`,
 * `question`, `asserts`, and `asks` rows directly, and exercises the
 * handler against the live database. The wire shape (relevantNotes,
 * recentDecisions, openQuestions, openContradictions) round-trips
 * unchanged from the Phase 4 SQLite-mirror harness.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DateTime, type RecordId } from "surrealdb";
import type { VaultFacade } from "../../../../src/core/chat/tools/vault";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  relateEdge,
  upsertClaim,
  upsertNoteByPath,
  upsertQuestion,
} from "../../../../src/core/db/surreal";
import type {
  ChatOptions,
  EmbedOptions,
  JsonSchema,
  LLMProvider,
  ChatMessage as ProviderChatMessage,
} from "../../../../src/core/llm/provider";
import type { SearchEvent, SearchHit, SearchQuery } from "../../../../src/core/search/types";
import {
  type BriefSearchPipeline,
  makeAgentBriefHandler,
} from "../../../../src/daemon/handlers/agentBrief";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

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

interface SeedNoteSpec {
  path: string;
  /** Epoch seconds. Mirrors the Phase 4 wire-shape for `lastTouchedAt`. */
  lastUserEditAtSec: number;
}

interface SeedClaimSpec {
  text: string;
  notePath: string;
}

interface SeedQuestionSpec {
  text: string;
  notePath: string;
}

interface SeedSurreal {
  connection: SurrealConnection;
  notes: SeedNoteSpec[];
  claims?: SeedClaimSpec[];
  questions?: SeedQuestionSpec[];
}

async function setLastUserEditAt(
  connection: SurrealConnection,
  noteId: RecordId<"note">,
  sec: number,
): Promise<void> {
  await connection.db
    .query("UPDATE $id SET last_user_edit_at = $when;", {
      id: noteId,
      when: new DateTime(new Date(sec * 1000)),
    })
    .collect();
}

async function seedSurreal(seed: SeedSurreal): Promise<Map<string, RecordId<"note">>> {
  const noteIds = new Map<string, RecordId<"note">>();
  for (const note of seed.notes) {
    const id = await upsertNoteByPath(seed.connection.db, {
      path: note.path,
      sha: "sha",
      wordCount: 100,
    });
    await setLastUserEditAt(seed.connection, id, note.lastUserEditAtSec);
    noteIds.set(note.path, id);
  }
  for (const claim of seed.claims ?? []) {
    const noteId = noteIds.get(claim.notePath);
    if (noteId === undefined) {
      throw new Error(`seedSurreal: claim references missing note ${claim.notePath}`);
    }
    const claimId = await upsertClaim(seed.connection.db, claim.text);
    await relateEdge(seed.connection.db, {
      table: "asserts",
      from: noteId,
      to: claimId,
      source: "extractor",
      confidenceClass: "INFERRED",
      confidence: 0.7,
      agent: "extractor",
      approved: true,
    });
  }
  for (const question of seed.questions ?? []) {
    const noteId = noteIds.get(question.notePath);
    if (noteId === undefined) {
      throw new Error(`seedSurreal: question references missing note ${question.notePath}`);
    }
    const questionId = await upsertQuestion(seed.connection.db, question.text);
    await relateEdge(seed.connection.db, {
      table: "asks",
      from: noteId,
      to: questionId,
      source: "extractor",
      confidenceClass: "INFERRED",
      confidence: 0.7,
      agent: "extractor",
      approved: true,
    });
  }
  return noteIds;
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

async function clearVault(connection: SurrealConnection): Promise<void> {
  // Edge tables first so the relation FROM/TO references stay valid while
  // the entity tables drain. asserts/asks/wikilink/embed/etc. are cleared
  // up-front so a re-seed in the next test starts from a clean slate.
  await connection.db.query("DELETE asserts; DELETE asks;").collect();
  await connection.db.query("DELETE claim; DELETE question;").collect();
  await connection.db.query("DELETE block; DELETE chunk;").collect();
  await connection.db.query("DELETE note;").collect();
  await connection.db.query("DELETE agent_event;").collect();
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] agent.brief handler", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase5-agentbrief-smoke-secret";

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
    await clearVault(connection);
  });

  test("[smoke] topic mode returns relevantNotes, decisions, questions, and a stubbed summary", async () => {
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
    await seedSurreal({
      connection,
      notes: [
        { path: "auth/oauth.md", lastUserEditAtSec: 1_700_000_000 },
        { path: "auth/jwt.md", lastUserEditAtSec: 1_700_000_500 },
        { path: "unrelated.md", lastUserEditAtSec: 1_600_000_000 },
      ],
      claims: [
        { text: "We use PKCE for the OAuth flow.", notePath: "auth/oauth.md" },
        { text: "JWT refresh window is short.", notePath: "auth/jwt.md" },
        { text: "Unrelated note decision.", notePath: "unrelated.md" },
      ],
      questions: [
        { text: "What is the refresh window?", notePath: "auth/jwt.md" },
        { text: "Outside the relevant set.", notePath: "unrelated.md" },
      ],
    });
    const pipeline = new ScriptedPipeline(hits);
    const provider = new StubProvider({ reply: "  Auth is OAuth+PKCE with short JWTs.  " });
    const handler = makeAgentBriefHandler({
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
    expect(relevantNotes[1].lastTouchedAt).toBe(1_700_000_500);

    const decisions = result.recentDecisions as Array<{
      id: string;
      text: string;
      notePath: string;
      ts: number;
    }>;
    const decisionPaths = new Set(decisions.map((decision) => decision.notePath));
    expect(decisionPaths.has("auth/oauth.md") || decisionPaths.has("auth/jwt.md")).toBe(true);
    expect(decisionPaths.has("unrelated.md")).toBe(false);
    for (const decision of decisions) {
      expect(typeof decision.id).toBe("string");
      expect(decision.id.length).toBeGreaterThan(0);
      expect(typeof decision.ts).toBe("number");
    }

    const questions = result.openQuestions as Array<{
      id: string;
      text: string;
      notePath: string;
    }>;
    expect(questions).toHaveLength(1);
    expect(questions[0].notePath).toBe("auth/jwt.md");
    expect(questions[0].text).toBe("What is the refresh window?");
    expect(typeof questions[0].id).toBe("string");

    const contradictions = result.openContradictions as unknown[];
    expect(contradictions).toEqual([]);

    expect(typeof result.durationMs).toBe("number");
  });

  test("[smoke] file mode reads the fixture file and labels the topic from the basename", async () => {
    await seedSurreal({
      connection,
      notes: [{ path: "guides/oauth.md", lastUserEditAtSec: 1_700_000_000 }],
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
    const relevantNotes = result.relevantNotes as Array<{ path: string; lastTouchedAt: number }>;
    expect(relevantNotes[0].path).toBe("guides/oauth.md");
    expect(relevantNotes[0].lastTouchedAt).toBe(1_700_000_000);
  });

  test("[smoke] honors maxNotes, maxQuestions, maxDecisions caps", async () => {
    const hits: SearchHit[] = Array.from({ length: 6 }, (_, index) => ({
      notePath: `note-${index}.md`,
      chunkId: `c${index}`,
      snippet: `snippet ${index}`,
      score: 1 - index * 0.1,
      matchedText: "x",
    }));
    await seedSurreal({
      connection,
      notes: hits.map((hit, index) => ({
        path: hit.notePath,
        lastUserEditAtSec: 1_700_000_000 + index,
      })),
      claims: hits.map((hit, index) => ({
        text: `Decision ${index}`,
        notePath: hit.notePath,
      })),
      questions: hits.map((hit, index) => ({
        text: `Question ${index}`,
        notePath: hit.notePath,
      })),
    });
    const handler = makeAgentBriefHandler({
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
    const hits: SearchHit[] = [
      {
        notePath: "auth/jwt.md",
        chunkId: "c1",
        snippet: "JWT.",
        score: 0.9,
        matchedText: "x",
      },
    ];
    await seedSurreal({
      connection,
      notes: [{ path: "auth/jwt.md", lastUserEditAtSec: 1_700_000_000 }],
      claims: [{ text: "JWT refresh is short.", notePath: "auth/jwt.md" }],
    });
    const provider = new StubProvider({ throwError: true });
    const handler = makeAgentBriefHandler({
      surrealDb: connection.db,
      searchPipeline: new ScriptedPipeline(hits),
      vault: new InMemoryFacade(new Map()),
      provider,
      settings: SETTINGS,
    });
    const result = await handler({ topic: "auth" }, () => {}, "req-8", "claude-code");
    expect(result.summary).toBe("");
    const decisions = result.recentDecisions as Array<{ notePath: string; text: string }>;
    expect(decisions).toHaveLength(1);
    expect(decisions[0].notePath).toBe("auth/jwt.md");
    expect(decisions[0].text).toBe("JWT refresh is short.");
    const relevantNotes = result.relevantNotes as Array<{ path: string }>;
    expect(relevantNotes[0].path).toBe("auth/jwt.md");
  });

  test("[smoke] note with NONE last_user_edit_at round-trips lastTouchedAt as 0", async () => {
    const hits: SearchHit[] = [
      {
        notePath: "untouched.md",
        chunkId: "c1",
        snippet: "Never edited.",
        score: 0.9,
        matchedText: "x",
      },
    ];
    // upsert without invoking setLastUserEditAt: the field stays NONE.
    await upsertNoteByPath(connection.db, {
      path: "untouched.md",
      sha: "sha",
      wordCount: 10,
    });
    const handler = makeAgentBriefHandler({
      surrealDb: connection.db,
      searchPipeline: new ScriptedPipeline(hits),
      vault: new InMemoryFacade(new Map()),
      provider: new StubProvider({ reply: "summary" }),
      settings: SETTINGS,
    });
    const result = await handler({ topic: "anything" }, () => {}, "req-none", "claude-code");
    const relevantNotes = result.relevantNotes as Array<{ path: string; lastTouchedAt: number }>;
    expect(relevantNotes).toHaveLength(1);
    expect(relevantNotes[0].lastTouchedAt).toBe(0);
  });

  test("[smoke] missing note row round-trips lastTouchedAt as 0", async () => {
    const hits: SearchHit[] = [
      {
        notePath: "ghost.md",
        chunkId: "c1",
        snippet: "No note row.",
        score: 0.9,
        matchedText: "x",
      },
    ];
    const handler = makeAgentBriefHandler({
      surrealDb: connection.db,
      searchPipeline: new ScriptedPipeline(hits),
      vault: new InMemoryFacade(new Map()),
      provider: new StubProvider({ reply: "summary" }),
      settings: SETTINGS,
    });
    const result = await handler({ topic: "anything" }, () => {}, "req-ghost", "claude-code");
    const relevantNotes = result.relevantNotes as Array<{ path: string; lastTouchedAt: number }>;
    expect(relevantNotes).toHaveLength(1);
    expect(relevantNotes[0].lastTouchedAt).toBe(0);
  });

  test("[smoke] contradiction events overlap on relevant note paths", async () => {
    const hits: SearchHit[] = [
      {
        notePath: "auth/jwt.md",
        chunkId: "c1",
        snippet: "JWT.",
        score: 0.9,
        matchedText: "auth",
      },
    ];
    await seedSurreal({
      connection,
      notes: [{ path: "auth/jwt.md", lastUserEditAtSec: 1_700_000_000 }],
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
