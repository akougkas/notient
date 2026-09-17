import { NoteReadService, contentRevision, sourceRange } from "../../../../src/api/notes";
import { makeReadNoteTool } from "../../../../src/core/chat/tools/vault";
const FIXTURE_BODY =
  "auth body\ntrusted retrieval excerpt\nfirst trusted excerpt\nlater trusted excerpt\nfirst\nduplicate";
const fixtureReader = new NoteReadService({ read: async () => FIXTURE_BODY });
function citation(path = "a.md", score = 0.9, quote = "auth body") {
  const start = Math.max(0, FIXTURE_BODY.indexOf(quote));
  return {
    path,
    score,
    revision: contentRevision(FIXTURE_BODY),
    quote,
    range: sourceRange(FIXTURE_BODY, start, start + quote.length),
  };
}
import { describe, expect, test } from "bun:test";
import { NOTIENT_IDENTITY } from "../../../../src/agent/identity";
import type { ToolMode, ToolModeCache } from "../../../../src/core/chat/toolModeProbe";
import {
  type ToolDefinition,
  type ToolJsonSchema,
  ToolRegistry,
} from "../../../../src/core/chat/tools/registry";
import { ReasoningScheduler } from "../../../../src/core/coordinator/reasoningScheduler";
import { EventBus } from "../../../../src/core/events/eventBus";
import type {
  ChatOptions,
  ChatWithToolsEvent,
  ChatWithToolsHandle,
  ChatWithToolsRequest,
  ChatWithToolsResult,
  ChatWithToolsToolCall,
  EmbedOptions,
  JsonSchema,
  LLMProvider,
  ChatMessage as ProviderChatMessage,
} from "../../../../src/core/llm/provider";
import { Reranker } from "../../../../src/core/search/reranker";
import {
  AGENT_ASK_RESPONSE_SCHEMA,
  AGENT_ASK_ROUND_CAP,
  ASK_SYSTEM_PROMPT,
  UNGROUNDED_ANSWER,
  makeAgentAskHandler,
} from "../../../../src/daemon/handlers/agentAsk";
import { RpcError } from "../../../../src/daemon/rpc";
import { currentCoverageFixture } from "../../../indexingFixture";
import { agentPrincipal, rpcRequest } from "../../../rpcRequest";

interface ScriptedTurn {
  toolCalls?: ChatWithToolsToolCall[];
  finalContent?: string;
}

class ScriptedProvider implements LLMProvider {
  public readonly requests: ChatWithToolsRequest[] = [];

  constructor(
    private readonly script: ScriptedTurn[],
    private readonly jsonResponse?: (
      messages: ProviderChatMessage[],
      options: ChatOptions,
    ) => unknown | Promise<unknown>,
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }
  async chat(): Promise<string> {
    return "";
  }
  async *chatStream(
    _messages: ProviderChatMessage[],
    _options: ChatOptions,
  ): AsyncIterable<string> {
    yield "";
  }
  async chatJson<T>(
    messages: ProviderChatMessage[],
    options: ChatOptions,
    _schema: JsonSchema,
  ): Promise<T> {
    if (this.jsonResponse === undefined) return {} as T;
    return (await this.jsonResponse(messages, options)) as T;
  }
  async embed(_input: string[], _options: EmbedOptions): Promise<number[][]> {
    return [];
  }

  async chatWithTools(request: ChatWithToolsRequest): Promise<ChatWithToolsHandle> {
    this.requests.push(request);
    const turn = this.script[this.requests.length - 1];
    if (!turn) throw new Error(`unexpected provider call #${this.requests.length}`);
    const result: ChatWithToolsResult = {
      content: turn.finalContent ?? "",
      reasoningContent: "",
      toolCalls: turn.toolCalls ?? [],
    };
    return {
      events: emptyEvents(),
      result: async () => result,
    };
  }
}

async function* emptyEvents(): AsyncIterable<ChatWithToolsEvent> {
  yield { type: "delta", contentDelta: "" };
}

function makeReadOnlyVaultSearchTool(
  invoke: (args: unknown, signal: AbortSignal) => Promise<unknown>,
): ToolDefinition<unknown, unknown> {
  const schema: ToolJsonSchema = {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  };
  return {
    name: "vault.search_notes",
    description: "Search vault notes.",
    schema,
    validate: (args) => args,
    invoke,
    writeGated: false,
  };
}

function makeWriteOnlyNotesCreateTool(
  invoke: (args: unknown, signal: AbortSignal) => Promise<unknown>,
): ToolDefinition<unknown, unknown> {
  const schema: ToolJsonSchema = {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
    additionalProperties: false,
  };
  return {
    name: "notes.create",
    description: "Create a note.",
    schema,
    validate: (args) => args,
    invoke,
    writeGated: true,
  };
}

function buildRegistry(
  searchInvoke: (args: unknown, signal: AbortSignal) => Promise<unknown> = async () => ({
    ...searchResult(),
  }),
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(makeReadOnlyVaultSearchTool(searchInvoke));
  registry.register(
    makeReadNoteTool({
      read: async () => FIXTURE_BODY,
      readBounded: async () => FIXTURE_BODY,
      isIndexablePath: () => true,
    }),
  );
  registry.register(
    makeWriteOnlyNotesCreateTool(async () => {
      throw new Error("write tools must never run during ask.run");
    }),
  );
  return registry;
}

function searchHit(
  overrides: Partial<{
    notePath: string;
    chunkId: string | null;
    snippet: string;
    score: number;
    matchedText: string;
  }> = {},
) {
  const { path, score, ...evidence } = citation(
    overrides.notePath,
    overrides.score,
    overrides.snippet,
  );
  return {
    note: { path, revision: evidence.revision },
    score,
    scoreKind: "bm25",
    evidence: { ...evidence, path },
    freshness: { state: "current", indexedRevision: evidence.revision, reason: null },
  };
}

function searchResult(hits: unknown[] = [searchHit()]) {
  return {
    ok: true,
    query: "anything",
    mode: "lexical",
    omitted: 0,
    hits,
    durationMs: 3,
    coverage: currentCoverageFixture(),
  };
}

function groundedFinal(
  overrides: Partial<{
    answer: string;
    citations: string[];
    confidence: number;
    openQuestions: string[];
  }> = {},
): string {
  return JSON.stringify({
    answer: "Auth uses JWT bearer tokens with rotating refresh tokens.",
    citations: ["a.md"],
    confidence: 0.8,
    openQuestions: [],
    ...overrides,
  });
}

function ungroundedFinal(): string {
  return JSON.stringify({
    answer: UNGROUNDED_ANSWER,
    citations: [],
    confidence: 0,
    openQuestions: [],
  });
}

function makeNativeCache(): ToolModeCache {
  const store = new Map<string, ToolMode>();
  return {
    read: (model) => store.get(model) ?? "native",
    write: async (model, mode) => {
      store.set(model, mode);
    },
  };
}

const SETTINGS = (): { model: string; defaultMaxRoundsPerTurn: number } => ({
  model: "test-model",
  defaultMaxRoundsPerTurn: 4,
});

describe("AGENT_ASK_RESPONSE_SCHEMA", () => {
  test("requires path-only citations, confidence, and openQuestions in strict schema mode", () => {
    const schema = AGENT_ASK_RESPONSE_SCHEMA.schema as {
      properties: Record<string, Record<string, unknown> | undefined>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.properties.citations).toEqual({
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
    });
    expect(schema.properties.confidence).toBeDefined();
    expect(schema.properties.confidence).toEqual({ type: "number", minimum: 0, maximum: 1 });
    expect(schema.properties.openQuestions).toBeDefined();
    expect(schema.required).toEqual(
      expect.arrayContaining(["answer", "citations", "confidence", "openQuestions"]),
    );
    expect(schema.additionalProperties).toBe(false);
    expect(JSON.stringify(schema.properties.citations)).not.toContain("score");
    expect(JSON.stringify(schema.properties.citations)).not.toContain("snippet");
  });
});

describe("ask.run handler", () => {
  const makeHandler = (
    provider: LLMProvider,
    options: {
      toolRegistry?: ToolRegistry;
      toolModeCache?: ToolModeCache;
      scheduler?: ReasoningScheduler;
      notes?: Pick<NoteReadService, "read">;
      settings?: () => { model: string; defaultMaxRoundsPerTurn: number };
    } = {},
  ) =>
    makeAgentAskHandler({
      provider,
      notes: options.notes ?? fixtureReader,
      toolRegistry: options.toolRegistry ?? buildRegistry(),
      toolModeCache: options.toolModeCache ?? makeNativeCache(),
      bus: new EventBus(),
      scheduler: options.scheduler ?? new ReasoningScheduler({ maxConcurrent: 1 }),
      settings: options.settings ?? SETTINGS,
    });

  const ask = (
    handler: ReturnType<typeof makeAgentAskHandler>,
    params: Record<string, unknown> = { query: "anything" },
  ) => handler(rpcRequest({ scope: {}, ...params }, { principal: agentPrincipal() }));

  async function captureError(work: Promise<unknown>): Promise<unknown> {
    try {
      await work;
      return null;
    } catch (error) {
      return error;
    }
  }

  test("speaks as the notes while treating the model as a visiting host", () => {
    expect(ASK_SYSTEM_PROMPT).toContain(NOTIENT_IDENTITY);
    expect(ASK_SYSTEM_PROMPT).toContain("current model is a visiting host");
    expect(ASK_SYSTEM_PROMPT).not.toContain("Notient assistant");
  });

  test("prompt requires exact path-only search citations and the complete final shape", () => {
    expect(ASK_SYSTEM_PROMPT).toContain("exact note.path string");
    expect(ASK_SYSTEM_PROMPT).toContain("vault.search_notes hit");
    expect(ASK_SYSTEM_PROMPT).toContain("Do not cite note titles");
    expect(ASK_SYSTEM_PROMPT).toContain(JSON.stringify(UNGROUNDED_ANSWER));
    expect(ASK_SYSTEM_PROMPT).toContain("first tool round must contain only vault.search_notes");
    expect(ASK_SYSTEM_PROMPT).toContain('"citations": ["<exact search hit note.path>"]');
    expect(ASK_SYSTEM_PROMPT).toContain("Citations contain path strings only");
    expect(ASK_SYSTEM_PROMPT).not.toContain("citations[].score");
    expect(ASK_SYSTEM_PROMPT).not.toContain('"score":');
    expect(ASK_SYSTEM_PROMPT).toContain('"confidence": <number from 0 to 1>');
    expect(ASK_SYSTEM_PROMPT).toContain('"openQuestions"');
    expect(ASK_SYSTEM_PROMPT).toContain("Do not wrap the JSON in code fences");
  });

  test("returns only an exact retrieval-grounded final response", async () => {
    const draft = {
      answer: "Auth uses JWT bearer tokens with rotating refresh tokens.",
      citations: ["a.md"],
    };
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: "tc1", name: "vault.search_notes", args: { query: "auth" } }],
      },
      { finalContent: JSON.stringify(draft) },
      { finalContent: groundedFinal() },
    ]);

    const result = await ask(makeHandler(provider), { query: "How does auth work?" });
    expect(result).toMatchObject({
      ok: true,
      answer: draft.answer,
      citations: [citation()],
      openQuestions: [],
      confidence: 0.8,
    });
    expect(provider.requests[0]?.responseSchema).toBeUndefined();
    expect(provider.requests[1]?.responseSchema).toBeUndefined();
    expect(provider.requests[2]?.responseSchema).toEqual(AGENT_ASK_RESPONSE_SCHEMA);
    expect(provider.requests[2]?.tools).toEqual([]);
    expect(provider.requests).toHaveLength(3);
    const toolCalls = result.toolCalls as Array<{ name: string; durationMs: number }>;
    expect(toolCalls).toEqual([
      expect.objectContaining({ name: "vault.search_notes", durationMs: expect.any(Number) }),
    ]);
    expect(typeof result.durationMs).toBe("number");
  });

  test("completes nested search reasoning under one process-wide slot", async () => {
    const scheduler = new ReasoningScheduler({ maxConcurrent: 1 });
    const labels: Array<string | null> = [];
    let toolSignal: AbortSignal | undefined;
    const provider = new ScriptedProvider(
      [
        {
          toolCalls: [{ id: "tc1", name: "vault.search_notes", args: { query: "auth" } }],
        },
        { finalContent: groundedFinal() },
      ],
      (_messages, options) => {
        labels.push(scheduler.currentLabel());
        expect(options.signal).toBe(toolSignal);
        return { ranking: [1, 2] };
      },
    );
    const reranker = new Reranker({ provider, model: "test-model", bus: new EventBus() });
    const registry = buildRegistry(async (_args, signal) => {
      toolSignal = signal;
      const hits = await reranker.rerank(
        "auth",
        ["a.md", "b.md"].map((notePath) => ({
          notePath,
          chunkId: null,
          snippet: "auth body",
          matchedText: "auth",
          score: 0.9,
        })),
        2,
        signal,
        scheduler,
      );
      return searchResult(
        hits.map((hit) => searchHit({ notePath: hit.notePath, score: hit.score })),
      );
    });

    const result = await ask(makeHandler(provider, { toolRegistry: registry, scheduler }));

    expect(result.ok).toBe(true);
    expect(labels).toEqual(["ask.run"]);
    expect(scheduler.isBusy()).toBe(false);
  });

  test("serializes parallel search rerankers beneath one ask.run owner", async () => {
    const scheduler = new ReasoningScheduler({ maxConcurrent: 1 });
    const labels: Array<string | null> = [];
    let activeRerankers = 0;
    let peakRerankers = 0;
    let rerankerCalls = 0;
    const provider = new ScriptedProvider(
      [
        {
          toolCalls: [
            { id: "tc1", name: "vault.search_notes", args: { query: "auth" } },
            { id: "tc2", name: "vault.search_notes", args: { query: "tokens" } },
          ],
        },
        { finalContent: groundedFinal() },
      ],
      async (_messages, options) => {
        rerankerCalls += 1;
        activeRerankers += 1;
        peakRerankers = Math.max(peakRerankers, activeRerankers);
        labels.push(scheduler.currentLabel());
        expect(options.signal).toBeInstanceOf(AbortSignal);
        try {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { ranking: [1, 2] };
        } finally {
          activeRerankers -= 1;
        }
      },
    );
    const reranker = new Reranker({ provider, model: "test-model", bus: new EventBus() });
    const registry = buildRegistry(async (args, signal) => {
      const query = (args as { query: string }).query;
      const hits = await reranker.rerank(
        query,
        ["a.md", "b.md"].map((notePath) => ({
          notePath,
          chunkId: null,
          snippet: "auth body",
          matchedText: "auth",
          score: 0.9,
        })),
        2,
        signal,
        scheduler,
      );
      return searchResult(
        hits.map((hit) => searchHit({ notePath: hit.notePath, score: hit.score })),
      );
    });

    const result = await ask(makeHandler(provider, { toolRegistry: registry, scheduler }));

    expect(result.ok).toBe(true);
    expect(rerankerCalls).toBe(2);
    expect(peakRerankers).toBe(1);
    expect(labels).toEqual(["ask.run", "ask.run"]);
    expect(result.toolCalls).toHaveLength(2);
    expect(scheduler.isBusy()).toBe(false);
  });

  test("rejects an answer containing even one fabricated citation instead of filtering it", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: "tc1", name: "vault.search_notes", args: { query: "auth" } }],
      },
      {
        finalContent: groundedFinal({
          citations: ["a.md", "fake/never-searched.md"],
        }),
      },
    ]);

    const error = await captureError(ask(makeHandler(provider)));
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe("INVALID_LLM_OUTPUT");
    expect((error as Error).message).toContain("was not returned by vault.search_notes");
  });

  test.each([".hidden.md", "notes/private.txt", "notes/../secret.md"])(
    "rejects non-public search path %s before another model round",
    async (notePath) => {
      const provider = new ScriptedProvider([
        {
          toolCalls: [{ id: "tc1", name: "vault.search_notes", args: { query: "auth" } }],
        },
      ]);
      const registry = buildRegistry(async () => searchResult([searchHit({ notePath })]));

      await expect(ask(makeHandler(provider, { toolRegistry: registry }))).rejects.toThrow(
        "vault.search_notes returned a malformed result",
      );
      expect(provider.requests).toHaveLength(1);
    },
  );

  test("constructs public score and snippet only from the trusted search hit", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: "tc1", name: "vault.search_notes", args: { query: "auth" } }],
      },
      { finalContent: groundedFinal({ citations: ["a.md"] }) },
    ]);
    const registry = buildRegistry(async () =>
      searchResult([searchHit({ score: 0.731, snippet: "trusted retrieval excerpt" })]),
    );

    const result = await ask(makeHandler(provider, { toolRegistry: registry }));
    expect(result.citations).toEqual([citation("a.md", 0.731, "trusted retrieval excerpt")]);
  });

  test("retains distinct passages from successive searches with the earliest trusted score", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: "tc-first", name: "vault.search_notes", args: { query: "auth" } }],
      },
      {
        toolCalls: [{ id: "tc-second", name: "vault.search_notes", args: { query: "tokens" } }],
      },
      { finalContent: groundedFinal({ citations: ["a.md"] }) },
    ]);
    const registry = buildRegistry(async (args) => {
      const query = (args as { query: string }).query;
      return query === "auth"
        ? searchResult([searchHit({ score: 0.4, snippet: "first trusted excerpt" })])
        : searchResult([searchHit({ score: 0.95, snippet: "later trusted excerpt" })]);
    });

    const result = await ask(makeHandler(provider, { toolRegistry: registry }));
    expect(result.citations).toEqual([
      citation("a.md", 0.4, "first trusted excerpt"),
      citation("a.md", 0.4, "later trusted excerpt"),
    ]);
  });

  test("matches citation paths exactly without case or alias resolution", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: "tc1", name: "vault.search_notes", args: { query: "auth" } }],
      },
      { finalContent: groundedFinal({ citations: ["A.md"] }) },
    ]);

    const error = await captureError(ask(makeHandler(provider)));
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe("INVALID_LLM_OUTPUT");
    expect((error as Error).message).toContain("citation 'A.md' was not returned");
  });

  test("rejects duplicate citations rather than silently deduplicating", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: "tc1", name: "vault.search_notes", args: { query: "auth" } }],
      },
      { finalContent: groundedFinal({ citations: ["a.md", "a.md"] }) },
    ]);

    const error = await captureError(ask(makeHandler(provider)));
    expect(error).toBeInstanceOf(RpcError);
    expect((error as Error).message).toContain("duplicate citation path");
  });

  test("accepts the explicit confidence-0 sentinel when retrieval has no evidence", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: "tc1", name: "vault.search_notes", args: { query: "unknown" } }],
      },
      { finalContent: ungroundedFinal() },
    ]);
    const result = await ask(
      makeHandler(provider, { toolRegistry: buildRegistry(async () => searchResult([])) }),
    );
    expect(result).toMatchObject({
      ok: true,
      answer: UNGROUNDED_ANSWER,
      citations: [],
      confidence: 0,
      openQuestions: [],
    });
  });

  test("discards uncited model narration and returns the one canonical sentinel", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: "tc1", name: "vault.search_notes", args: { query: "unknown" } }],
      },
      {
        finalContent: groundedFinal({
          citations: [],
          answer: "I could not find it.",
          confidence: 0,
        }),
      },
    ]);
    const result = await ask(
      makeHandler(provider, { toolRegistry: buildRegistry(async () => searchResult([])) }),
    );
    expect(result).toMatchObject({
      ok: true,
      answer: UNGROUNDED_ANSWER,
      citations: [],
      confidence: 0,
      openQuestions: [],
    });
  });

  test("rejects citation-empty output that claims confidence or open questions", async () => {
    const malformed = [
      groundedFinal({ citations: [], answer: "No cited basis.", confidence: 0.2 }),
      groundedFinal({
        citations: [],
        answer: "No cited basis.",
        confidence: 0,
        openQuestions: ["An uncited question"],
      }),
    ];
    for (const finalContent of malformed) {
      const provider = new ScriptedProvider([
        {
          toolCalls: [{ id: "tc1", name: "vault.search_notes", args: { query: "unknown" } }],
        },
        { finalContent },
      ]);
      const error = await captureError(
        ask(makeHandler(provider, { toolRegistry: buildRegistry(async () => searchResult([])) })),
      );
      expect(error).toBeInstanceOf(RpcError);
      expect((error as Error).message).toContain("confidence 0 and no open questions");
    }
  });

  test("requires vault.search_notes before accepting any final response", async () => {
    const provider = new ScriptedProvider([{ finalContent: ungroundedFinal() }]);
    const error = await captureError(ask(makeHandler(provider)));
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe("INVALID_LLM_OUTPUT");
    expect((error as Error).message).toContain("first action must be vault.search_notes");
  });

  test("rejects an allowed non-search tool as the first action", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: "tc-read", name: "vault.read_note", args: { notePath: "a.md" } }],
      },
    ]);
    const error = await captureError(ask(makeHandler(provider)));
    expect(error).toBeInstanceOf(RpcError);
    expect((error as Error).message).toContain("first action must be vault.search_notes");
  });

  test("does not allow a parallel read to race the required first search result", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: "tc-search", name: "vault.search_notes", args: { query: "auth" } },
          { id: "tc-read", name: "vault.read_note", args: { notePath: "a.md" } },
        ],
      },
    ]);
    const error = await captureError(ask(makeHandler(provider)));
    expect(error).toBeInstanceOf(RpcError);
    expect((error as Error).message).toContain("before vault.search_notes returns evidence");
  });

  test("rejects duplicate model tool-call ids", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: "same", name: "vault.search_notes", args: { query: "auth" } },
          { id: "same", name: "vault.search_notes", args: { query: "tokens" } },
        ],
      },
    ]);
    const error = await captureError(ask(makeHandler(provider)));
    expect(error).toBeInstanceOf(RpcError);
    expect((error as Error).message).toContain("duplicate tool call id");
  });

  test("read-only enforcement rejects out-of-band write tool calls", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: "tc-bad", name: "notes.create", args: { path: "x.md", content: "x" } }],
      },
    ]);
    const error = await captureError(ask(makeHandler(provider), { query: "create something" }));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("notes.create");
    expect((error as Error).message).toContain("Unknown tool: notes.create");
  });

  test("malformed search result envelopes and hits are integrity errors", async () => {
    const malformedResults: unknown[] = [
      { hits: [searchHit()] },
      { hits: [searchHit()], durationMs: 1, legacy: true },
      searchResult([citation()]),
      searchResult([{ ...searchHit(), path: "legacy.md" }]),
      searchResult([{ ...searchHit(), score: Number.NaN }]),
      searchResult([{ ...searchHit(), evidence: { ...citation(), quote: "   " } }]),
      searchResult([{ ...searchHit(), matchedText: "" }]),
    ];
    for (const malformed of malformedResults) {
      const provider = new ScriptedProvider([
        {
          toolCalls: [{ id: "tc1", name: "vault.search_notes", args: { query: "auth" } }],
        },
      ]);
      const error = await captureError(
        ask(makeHandler(provider, { toolRegistry: buildRegistry(async () => malformed) })),
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("ask.run tool-result integrity");
      expect(error).not.toBeInstanceOf(RpcError);
    }
  });

  test("rejects duplicate note paths within one search result", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: "tc1", name: "vault.search_notes", args: { query: "auth" } }],
      },
    ]);
    const registry = buildRegistry(async () =>
      searchResult([
        searchHit({ score: 0.9, snippet: "first" }),
        searchHit({ score: 0.8, snippet: "duplicate" }),
      ]),
    );

    const error = await captureError(ask(makeHandler(provider, { toolRegistry: registry })));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RpcError);
    expect((error as Error).message).toContain("vault.search_notes returned duplicate path 'a.md'");
  });

  test("rejects prose, fenced JSON, think wrappers, missing fields, and extra fields", async () => {
    const exact = groundedFinal();
    const malformedFinals = [
      "I do not know.",
      `\`\`\`json\n${exact}\n\`\`\``,
      `<think>hidden</think>${exact}`,
      JSON.stringify({ answer: "Incomplete", citations: [] }),
      JSON.stringify({
        answer: "Old citation envelope",
        citations: [citation()],
        confidence: 0.8,
        openQuestions: [],
      }),
      JSON.stringify({
        answer: "Extra",
        citations: ["a.md"],
        confidence: 0.8,
        openQuestions: [],
        legacyAnswer: "compatibility alias",
      }),
    ];
    for (const finalContent of malformedFinals) {
      const provider = new ScriptedProvider([
        {
          toolCalls: [{ id: "tc1", name: "vault.search_notes", args: { query: "auth" } }],
        },
        { finalContent },
        { finalContent },
      ]);
      const error = await captureError(ask(makeHandler(provider)));
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe("INVALID_LLM_OUTPUT");
    }
  });

  test("rejects confidence outside [0, 1] instead of clamping", async () => {
    for (const confidence of [7, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const provider = new ScriptedProvider([
        {
          toolCalls: [{ id: "tc1", name: "vault.search_notes", args: { query: "auth" } }],
        },
        { finalContent: groundedFinal({ confidence }) },
      ]);
      const error = await captureError(ask(makeHandler(provider)));
      expect(error).toBeInstanceOf(RpcError);
      expect((error as Error).message).toContain("confidence must be a finite number");
    }
  });

  test("a failed finalization request remains a provider failure rather than malformed output", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "tc1", name: "vault.search_notes", args: { query: "auth" } }] },
      { finalContent: "An unfinished prose answer." },
    ]);
    const error = await captureError(ask(makeHandler(provider)));
    expect(error).not.toBeInstanceOf(RpcError);
    expect((error as Error).message).toContain("unexpected provider call #3");
    expect(provider.requests).toHaveLength(3);
  });

  test("rejects noncanonical and unknown input fields without normalization", async () => {
    const provider = new ScriptedProvider([]);
    const handler = makeHandler(provider);
    for (const params of [
      { query: "" },
      { query: "   " },
      { query: " padded" },
      { query: "padded " },
      { query: null },
      { query: "anything", maxRoundsPerTurn: null },
      { query: "anything", intent: "legacy alias" },
    ]) {
      const error = await captureError(ask(handler, params as { query: string }));
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe("INVALID_PARAMS");
    }
    expect(provider.requests).toHaveLength(0);
  });

  test("rejects malformed or compatibility-shaped runtime settings", async () => {
    const settingsCases = [
      () => ({ model: " test-model", defaultMaxRoundsPerTurn: 4 }),
      () => ({ model: "test-model", defaultMaxRoundsPerTurn: null }),
      () => ({ model: "test-model", defaultMaxRoundsPerTurn: 9 }),
      () => ({ model: "test-model", defaultMaxRoundsPerTurn: 4, maxRounds: 4 }),
    ];
    for (const settings of settingsCases) {
      const provider = new ScriptedProvider([]);
      const error = await captureError(
        ask(
          makeHandler(provider, {
            settings: settings as unknown as () => {
              model: string;
              defaultMaxRoundsPerTurn: number;
            },
          }),
        ),
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(RpcError);
      expect(provider.requests).toHaveLength(0);
    }
  });

  test("maxRoundsPerTurn accepts the exact cap", async () => {
    const turns: ScriptedTurn[] = [];
    for (let index = 0; index < AGENT_ASK_ROUND_CAP - 1; index++) {
      turns.push({
        toolCalls: [{ id: `tc-${index}`, name: "vault.search_notes", args: { query: "x" } }],
      });
    }
    turns.push({
      finalContent: groundedFinal({
        answer: "Partial answer from the evidence gathered so far.",
        confidence: 0.4,
      }),
    });
    const provider = new ScriptedProvider(turns);
    const result = await ask(makeHandler(provider), {
      query: "loop please",
      maxRoundsPerTurn: AGENT_ASK_ROUND_CAP,
    });
    expect(result.ok).toBe(true);
    expect(result.answer).toBe("Partial answer from the evidence gathered so far.");
    expect(provider.requests).toHaveLength(AGENT_ASK_ROUND_CAP);
    expect(provider.requests[AGENT_ASK_ROUND_CAP - 1]?.tools).toEqual([]);
    expect(provider.requests[AGENT_ASK_ROUND_CAP - 1]?.responseSchema).toEqual(
      AGENT_ASK_RESPONSE_SCHEMA,
    );
  });

  test("maxRoundsPerTurn rejects values outside the canonical bounded integer domain", async () => {
    const provider = new ScriptedProvider([]);
    const handler = makeHandler(provider);
    for (const maxRoundsPerTurn of [
      null,
      0,
      -1,
      1.5,
      AGENT_ASK_ROUND_CAP + 1,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "2",
    ]) {
      const error = await captureError(
        ask(handler, { query: "anything", maxRoundsPerTurn } as { query: string }),
      );
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe("INVALID_PARAMS");
    }
    expect(provider.requests).toHaveLength(0);
  });

  test("INVALID_LLM_OUTPUT carries only the first 200 raw characters", async () => {
    const raw = `sorry, ${"x".repeat(400)}`;
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: "tc1", name: "vault.search_notes", args: { query: "auth" } }],
      },
      { finalContent: raw },
      { finalContent: raw },
    ]);
    const error = await captureError(ask(makeHandler(provider)));
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe("INVALID_LLM_OUTPUT");
    const message = (error as Error).message;
    expect(message).toContain(raw.slice(0, 200));
    expect(message).not.toContain(raw.slice(0, 201));
  });

  test("a bounded full read replaces contained snippets so every observed claim has evidence", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "s", name: "vault.search_notes", args: { query: "auth" } }] },
      { toolCalls: [{ id: "r", name: "vault.read_note", args: { notePath: "a.md" } }] },
      { finalContent: groundedFinal() },
    ]);
    const result = await ask(makeHandler(provider));
    expect(result.citations).toEqual([citation("a.md", 0.9, FIXTURE_BODY)]);
  });
  test("a later current search cannot conceal earlier incomplete coverage", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "s1", name: "vault.search_notes", args: { query: "first" } }] },
      { toolCalls: [{ id: "s2", name: "vault.search_notes", args: { query: "second" } }] },
      { finalContent: groundedFinal() },
    ]);
    let calls = 0;
    const registry = buildRegistry(async () => {
      const result = searchResult();
      if (++calls === 1)
        return {
          ...result,
          coverage: {
            ...result.coverage,
            state: "incomplete",
            message: "Index is still catching up.",
          },
        };
      return result;
    });
    expect((await ask(makeHandler(provider, { toolRegistry: registry }))).coverage).toMatchObject({
      state: "incomplete",
      message: "Index is still catching up.",
    });
  });
  test("rejects changed sources before delivering a grounded answer", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "s", name: "vault.search_notes", args: { query: "auth" } }] },
      { finalContent: groundedFinal() },
    ]);
    const notes = new NoteReadService({ read: async () => `${FIXTURE_BODY} changed` });
    await expect(ask(makeHandler(provider, { notes }))).rejects.toMatchObject({ code: "CONFLICT" });
  });
  test("an explicit scope reaches every tool and is rechecked before returning evidence", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "s", name: "vault.search_notes", args: { query: "auth" } }] },
      { finalContent: groundedFinal() },
    ]);
    const registry = buildRegistry();
    const tool = registry.get("vault.search_notes");
    if (!tool) throw new Error("missing search tool");
    const invoke = tool.invoke;
    tool.invoke = async (args, signal, context) => {
      expect(context.noteScope?.folders).toEqual(["Work"]);
      return invoke(args, signal, context);
    };
    await expect(
      ask(makeHandler(provider, { toolRegistry: registry }), {
        query: "anything",
        scope: { folders: ["Work"] },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  test("caller cancellation aborts a running tool and releases the inference slot", async () => {
    const controller = new AbortController();
    const scheduler = new ReasoningScheduler({ maxConcurrent: 1 });
    let observed = false;
    const registry = buildRegistry(async (_args, signal) => {
      controller.abort();
      observed = signal.aborted;
      signal.throwIfAborted();
      return searchResult();
    });
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "s", name: "vault.search_notes", args: { query: "auth" } }] },
    ]);
    await expect(
      makeHandler(provider, { toolRegistry: registry, scheduler })(
        rpcRequest({ query: "anything", scope: {} }, { signal: controller.signal }),
      ),
    ).rejects.toThrow();
    expect(observed).toBe(true);
    expect(scheduler.isBusy()).toBe(false);
    expect(provider.requests).toHaveLength(1);
  });
  test("returns an honest disabled-tool response without calling the model", async () => {
    const provider = new ScriptedProvider([]);
    const disabledCache: ToolModeCache = {
      read: () => "disabled",
      write: async () => {},
    };
    await expect(
      ask(makeHandler(provider, { toolModeCache: disabledCache })),
    ).rejects.toMatchObject({ code: "INFERENCE_UNAVAILABLE" });
    expect(provider.requests).toHaveLength(0);
  });
});
