import { describe, expect, test } from "bun:test";
import { ApprovalGate } from "../../core/chat/approvalGate";
import type { ToolMode, ToolModeCache } from "../../core/chat/toolModeProbe";
import {
  type ToolDefinition,
  type ToolJsonSchema,
  ToolRegistry,
} from "../../core/chat/tools/registry";
import { EventBus } from "../../core/events/eventBus";
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
} from "../../core/llm/provider";
import {
  AGENT_ASK_RESPONSE_SCHEMA,
  AGENT_ASK_ROUND_CAP,
  UNGROUNDED_ANSWER,
  makeAgentAskHandler,
} from "./agentAsk";

interface ScriptedTurn {
  toolCalls?: ChatWithToolsToolCall[];
  finalContent?: string;
}

class ScriptedProvider implements LLMProvider {
  public readonly requests: ChatWithToolsRequest[] = [];

  constructor(private readonly script: ScriptedTurn[]) {}

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
    _messages: ProviderChatMessage[],
    _options: ChatOptions,
    _schema: JsonSchema,
  ): Promise<T> {
    return {} as T;
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
    hits: [{ notePath: "a.md", score: 0.9, snippet: "auth body" }],
  }),
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(makeReadOnlyVaultSearchTool(searchInvoke));
  registry.register(
    makeWriteOnlyNotesCreateTool(async () => {
      throw new Error("write tools must never run during agent.ask");
    }),
  );
  return registry;
}

function makeNoopGate(): ApprovalGate {
  return new ApprovalGate({
    events: { onPending: () => {}, onResolved: () => {} },
    recordHistoryAutoApprove: async () => {},
    sessionGrants: { find: () => null, incrementWriteCount: () => {} },
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

describe("agent.ask handler", () => {
  test("happy path returns the parsed JSON shape with tool-call summaries", async () => {
    const structured = {
      answer: "Auth uses JWT bearer tokens with rotating refresh tokens.",
      citations: [{ path: "a.md", score: 0.91, snippet: "JWT-based auth" }],
    };
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: "tc1", name: "vault.search_notes", args: { query: "auth" } }],
      },
      { finalContent: JSON.stringify(structured) },
    ]);

    const handler = makeAgentAskHandler({
      provider,
      toolRegistry: buildRegistry(),
      approvalGate: makeNoopGate(),
      toolModeCache: makeNativeCache(),
      bus: new EventBus(),
      settings: SETTINGS,
    });

    const result = await handler(
      { intent: "How does auth work?" },
      () => {},
      "req-1",
      "claude-code",
    );
    expect(result.ok).toBe(true);
    expect(result.answer).toBe(structured.answer);
    expect(result.citations).toEqual([{ path: "a.md", score: 0.9, snippet: "auth body" }]);
    expect(result.openQuestions).toEqual([]);
    expect(result.confidence).toBe(0);
    expect(provider.requests[0]?.responseSchema).toBeUndefined();
    expect(provider.requests[1]?.responseSchema).toEqual(AGENT_ASK_RESPONSE_SCHEMA);
    const toolCalls = result.toolCalls as Array<{ name: string; durationMs: number }>;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("vault.search_notes");
    expect(typeof result.durationMs).toBe("number");
  });

  test("fabricated citations are filtered against seen tool-result paths", async () => {
    const structured = {
      answer: "There is one real reference and one made-up one.",
      citations: [
        { path: "real/found.md", score: 0.96, snippet: "model snippet" },
        { path: "fake/never_searched.md", score: 0.95, snippet: "made up" },
      ],
    };
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: "tc1", name: "vault.search_notes", args: { query: "anything" } }],
      },
      { finalContent: JSON.stringify(structured) },
    ]);

    const handler = makeAgentAskHandler({
      provider,
      toolRegistry: buildRegistry(async () => ({
        hits: [{ notePath: "real/found.md", score: 0.7, snippet: "..." }],
      })),
      approvalGate: makeNoopGate(),
      toolModeCache: makeNativeCache(),
      bus: new EventBus(),
      settings: SETTINGS,
    });

    const result = await handler({ intent: "anything" }, () => {}, "req-fab", "claude-code");
    const citations = result.citations as Array<{ path: string; score: number; snippet: string }>;
    expect(citations).toHaveLength(1);
    expect(citations[0].path).toBe("real/found.md");
    expect(citations[0].score).toBe(0.7);
    expect(citations[0].snippet).toBe("...");
    expect(citations.some((entry) => entry.path === "fake/never_searched.md")).toBe(false);
    expect(result.answer).toBe(structured.answer);
    expect(result.confidence).toBe(0);
  });

  test("citation-free final answers are replaced with an ungrounded fallback", async () => {
    const structured = {
      answer: "Pure hallucination, no tools were ever run.",
      citations: [{ path: "anything.md", score: 0.99, snippet: "..." }],
    };
    const provider = new ScriptedProvider([{ finalContent: JSON.stringify(structured) }]);

    const handler = makeAgentAskHandler({
      provider,
      toolRegistry: buildRegistry(),
      approvalGate: makeNoopGate(),
      toolModeCache: makeNativeCache(),
      bus: new EventBus(),
      settings: SETTINGS,
    });

    const result = await handler({ intent: "anything" }, () => {}, "req-no-tool", "claude-code");
    expect(result.citations).toEqual([]);
    expect(result.answer).toBe(UNGROUNDED_ANSWER);
    expect(result.toolCalls).toEqual([]);
  });

  test("all-fabricated citations after search produce an ungrounded fallback", async () => {
    const structured = {
      answer: "A made-up answer with only made-up sources.",
      citations: [{ path: "fake/never_searched.md", score: 0.99, snippet: "..." }],
    };
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: "tc1", name: "vault.search_notes", args: { query: "anything" } }],
      },
      { finalContent: JSON.stringify(structured) },
    ]);

    const handler = makeAgentAskHandler({
      provider,
      toolRegistry: buildRegistry(async () => ({
        hits: [{ notePath: "real/found.md", score: 0.7, snippet: "..." }],
      })),
      approvalGate: makeNoopGate(),
      toolModeCache: makeNativeCache(),
      bus: new EventBus(),
      settings: SETTINGS,
    });

    const result = await handler({ intent: "anything" }, () => {}, "req-fake-only", "claude-code");
    expect(result.citations).toEqual([]);
    expect(result.answer).toBe(UNGROUNDED_ANSWER);
  });

  test("read-only enforcement rejects out-of-band write tool calls", async () => {
    // The provider hallucinates a notes.create call. The filtered registry
    // never advertised it, so the registry's UnknownToolError surfaces as a
    // tool-result error; the handler's defense-in-depth gate also fires on
    // the matching loop:tool-call event.
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: "tc-bad", name: "notes.create", args: { path: "x.md", content: "x" } }],
      },
    ]);

    const handler = makeAgentAskHandler({
      provider,
      toolRegistry: buildRegistry(),
      approvalGate: makeNoopGate(),
      toolModeCache: makeNativeCache(),
      bus: new EventBus(),
      settings: SETTINGS,
    });

    let thrown: unknown = null;
    try {
      await handler({ intent: "create something" }, () => {}, "req-2", "claude-code");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("notes.create");
    expect((thrown as Error).message).toContain("not available to agent.ask");
  });

  test("schema failure before any tool call returns an ungrounded fallback", async () => {
    const provider = new ScriptedProvider([{ finalContent: "I do not know." }]);

    const handler = makeAgentAskHandler({
      provider,
      toolRegistry: buildRegistry(),
      approvalGate: makeNoopGate(),
      toolModeCache: makeNativeCache(),
      bus: new EventBus(),
      settings: SETTINGS,
    });

    const result = await handler({ intent: "anything" }, () => {}, "req-3", "claude-code");
    expect(result.answer).toBe(UNGROUNDED_ANSWER);
    expect(result.citations).toEqual([]);
  });

  test("schema failure after a tool call still rejects instead of trusting prose", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: "tc1", name: "vault.search_notes", args: { query: "auth" } }],
      },
      { finalContent: "I do not know." },
    ]);

    const handler = makeAgentAskHandler({
      provider,
      toolRegistry: buildRegistry(),
      approvalGate: makeNoopGate(),
      toolModeCache: makeNativeCache(),
      bus: new EventBus(),
      settings: SETTINGS,
    });

    await expect(
      handler({ intent: "anything" }, () => {}, "req-3b", "claude-code"),
    ).rejects.toThrow("INVALID_LLM_OUTPUT");
  });

  test("fenced JSON final content is rejected", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: "tc1", name: "vault.search_notes", args: { query: "anything" } }],
      },
      {
        finalContent:
          '```json\n{"answer":"wrapped","citations":[{"path":"a.md","score":0.9,"snippet":"x"}]}\n```',
      },
    ]);

    const handler = makeAgentAskHandler({
      provider,
      toolRegistry: buildRegistry(),
      approvalGate: makeNoopGate(),
      toolModeCache: makeNativeCache(),
      bus: new EventBus(),
      settings: SETTINGS,
    });

    await expect(
      handler({ intent: "anything" }, () => {}, "req-fence", "claude-code"),
    ).rejects.toThrow("INVALID_LLM_OUTPUT");
  });

  test("empty intent rejects before calling the provider", async () => {
    const provider = new ScriptedProvider([]);
    const handler = makeAgentAskHandler({
      provider,
      toolRegistry: buildRegistry(),
      approvalGate: makeNoopGate(),
      toolModeCache: makeNativeCache(),
      bus: new EventBus(),
      settings: SETTINGS,
    });

    let thrown: unknown = null;
    try {
      await handler({ intent: "   " }, () => {}, "req-4", "claude-code");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("intent is required");
    expect(provider.requests).toHaveLength(0);
  });

  test("maxRoundsPerTurn is silently clamped to the cap", async () => {
    // Build a provider that loops forever calling vault.search_notes. With
    // the cap enforced, runAgentTurn must stop after AGENT_ASK_ROUND_CAP
    // provider invocations and emit the truncated done event.
    const turns: ScriptedTurn[] = [];
    for (let index = 0; index < AGENT_ASK_ROUND_CAP; index++) {
      turns.push({
        toolCalls: [{ id: `tc-${index}`, name: "vault.search_notes", args: { query: "x" } }],
      });
    }
    const provider = new ScriptedProvider(turns);

    const handler = makeAgentAskHandler({
      provider,
      toolRegistry: buildRegistry(),
      approvalGate: makeNoopGate(),
      toolModeCache: makeNativeCache(),
      bus: new EventBus(),
      settings: SETTINGS,
    });

    await expect(
      handler({ intent: "loop please", maxRoundsPerTurn: 100 }, () => {}, "req-5", "claude-code"),
    ).rejects.toThrow("INVALID_LLM_OUTPUT");
    expect(provider.requests).toHaveLength(AGENT_ASK_ROUND_CAP);
  });
});
