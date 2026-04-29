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
import { AGENT_ASK_ROUND_CAP, makeAgentAskHandler } from "./agentAsk";

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

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    makeReadOnlyVaultSearchTool(async () => ({ hits: [{ path: "a.md", score: 0.9 }] })),
  );
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
      citations: [{ path: "Notient/auth.md", score: 0.91, snippet: "JWT-based auth" }],
      openQuestions: ["What is the refresh window?"],
      confidence: 0.82,
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
    expect(result.citations).toEqual(structured.citations);
    expect(result.openQuestions).toEqual(structured.openQuestions);
    expect(result.confidence).toBe(structured.confidence);
    const toolCalls = result.toolCalls as Array<{ name: string; durationMs: number }>;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("vault.search_notes");
    expect(typeof result.durationMs).toBe("number");
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

  test("parse-failure fallback wraps raw text with confidence zero", async () => {
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
    expect(result.answer).toBe("I do not know.");
    expect(result.citations).toEqual([]);
    expect(result.openQuestions).toEqual([]);
    expect(result.confidence).toBe(0);
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

    const result = await handler(
      { intent: "loop please", maxRoundsPerTurn: 100 },
      () => {},
      "req-5",
      "claude-code",
    );
    expect(provider.requests).toHaveLength(AGENT_ASK_ROUND_CAP);
    // Truncated final message is plain prose; the handler wraps it as the
    // parse-failure fallback with confidence zero.
    expect(result.confidence).toBe(0);
    const toolCalls = result.toolCalls as Array<{ name: string }>;
    expect(toolCalls.length).toBe(AGENT_ASK_ROUND_CAP);
  });
});
