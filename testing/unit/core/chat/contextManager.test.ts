import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import { NOTIENT_IDENTITY } from "../../../../src/agent/identity";
import {
  ContextManager,
  type ContextManagerOptions,
  type ContextSettingsView,
  toProviderMessages,
} from "../../../../src/core/chat/contextManager";
import {
  type ConversationMemory,
  ConversationMemoryIntegrityError,
  ConversationMemoryUnavailableError,
} from "../../../../src/core/chat/conversationIndex";
import type {
  ChatMessage,
  Conversation,
  ConversationChatMessage,
  ToolChatMessage,
} from "../../../../src/core/chat/types";
import { EventBus } from "../../../../src/core/events/eventBus";
import type {
  ContextOverflowWarningEvent,
  ContextSummarizedEvent,
} from "../../../../src/core/events/types";
import type {
  ChatOptions,
  ChatWithToolsHandle,
  ChatWithToolsRequest,
  EmbedOptions,
  JsonSchema,
  LLMProvider,
  ChatMessage as ProviderChatMessage,
} from "../../../../src/core/llm/provider";
import { InMemoryConversationMemory } from "./conversationMemoryFake";

interface CountRow {
  count: number;
}

test("unresolved optional recall does not disable chat, while storage integrity still fails closed", async () => {
  const memory = new InMemoryConversationMemory();
  memory.search = async () => {
    throw new ConversationMemoryUnavailableError("temporarily-unresolved");
  };
  const { manager } = makeManager({
    conversationIndex: memory,
    embed: async () => new Float32Array([1, 0]),
  });
  const result = await manager.compose(
    makeConversation(),
    makeMessage("user", "Help develop my thought"),
    new AbortController().signal,
  );
  expect(result.systemPrompt).toContain("Cross-session semantic recall is unavailable");
  expect(result.messages.at(-1)?.content).toBe("Help develop my thought");
  memory.search = async () => {
    throw new ConversationMemoryIntegrityError("wrong owner");
  };
  await expect(
    manager.compose(
      makeConversation(),
      makeMessage("user", "Try again"),
      new AbortController().signal,
    ),
  ).rejects.toThrow("storage integrity failure");
});

/**
 * Minimal SurrealDB shim for the snapshot count queries. Canned table counts
 * keep the prompt assertions deterministic without a live database.
 */
class FakeSurreal {
  // Defaults: 42 notes, 7 approved edges across all writeback tables (set on
  // `supports`), 3 pending edges (set on `contradicts`). Other tables return 0.
  constructor(
    private readonly counts: {
      note: number;
      approvedByTable: Partial<Record<string, number>>;
      pendingByTable: Partial<Record<string, number>>;
    } = {
      note: 42,
      approvedByTable: { supports: 7 },
      pendingByTable: { contradicts: 3 },
    },
  ) {}

  query<T>(sql: string): { collect: <R = T>() => Promise<R> } {
    return {
      collect: async <R = T>(): Promise<R> => {
        if (sql === "SELECT count() FROM note GROUP ALL;") {
          return [[{ count: this.counts.note }]] as unknown as R;
        }
        const approvedMatch = sql.match(
          /^SELECT count\(\) FROM (\w+) WHERE approved = true AND applied = true GROUP ALL;$/,
        );
        if (approvedMatch) {
          const value = this.counts.approvedByTable[approvedMatch[1]] ?? 0;
          return [[{ count: value }]] as unknown as R;
        }
        const pendingMatch = sql.match(
          /^SELECT count\(\) FROM (\w+) WHERE approved = false GROUP ALL;$/,
        );
        if (pendingMatch) {
          const value = this.counts.pendingByTable[pendingMatch[1]] ?? 0;
          return [[{ count: value }]] as unknown as R;
        }
        return [[]] as unknown as R;
      },
    };
  }
}

class FakeProvider implements LLMProvider {
  public summaryCalls: ProviderChatMessage[][] = [];

  constructor(private readonly summary: string = "earlier topic recap") {}

  async isAvailable(): Promise<boolean> {
    return true;
  }
  async chat(_messages: ProviderChatMessage[], _options: ChatOptions): Promise<string> {
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
    _options: ChatOptions,
    _schema: JsonSchema,
  ): Promise<T> {
    this.summaryCalls.push(messages);
    return { summary: this.summary } as unknown as T;
  }
  async embed(_input: string[], _options: EmbedOptions): Promise<number[][]> {
    return [];
  }
  async chatWithTools(_request: ChatWithToolsRequest): Promise<ChatWithToolsHandle> {
    throw new Error("not used");
  }
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-current",
    notePath: "Notient/conversations/2026-04-25 current.md",
    model: "Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M",
    pinnedContext: [],
    approvalMode: "safe",
    topic: "Current",
    summary: "",
    clientIdentity: "human",
    messageCount: 0,
    createdAt: 0,
    updatedAt: 0,
    messages: [],
    ...overrides,
  };
}

function makeMessage(
  role: "tool",
  content: string,
  createdAt: number,
  toolCallId: string,
): ToolChatMessage;
function makeMessage(
  role: ConversationChatMessage["role"],
  content: string,
  createdAt?: number,
): ConversationChatMessage;
function makeMessage(
  role: ChatMessage["role"],
  content: string,
  createdAt = 0,
  toolCallId?: string,
): ChatMessage {
  if (role === "tool") {
    if (toolCallId === undefined) throw new Error("test tool message requires toolCallId");
    return { id: `${role}-${createdAt}`, role, content, toolCallId, createdAt };
  }
  return { id: `${role}-${createdAt}`, role, content, createdAt };
}

function defaultSettings(overrides: Partial<ContextSettingsView> = {}): ContextSettingsView {
  return {
    includeVaultSnapshot: true,
    includeCrossSessionMemory: true,
    crossSessionTopK: 2,
    crossSessionSimThreshold: 0.7,
    pinnedNoteMaxTokens: 4000,
    contextBudgetFraction: 0.7,
    modelContextTokens: 8192,
    ...overrides,
  };
}

function makeManager(options: Partial<ContextManagerOptions> = {}): {
  manager: ContextManager;
  provider: FakeProvider;
  conversationIndex: ConversationMemory;
} {
  const provider = options.provider instanceof FakeProvider ? options.provider : new FakeProvider();
  const facadeRead = options.facade?.readNote ?? (async () => "");
  const conversationIndex = options.conversationIndex ?? new InMemoryConversationMemory();
  const manager = new ContextManager({
    db: (options.db ?? (new FakeSurreal() as unknown)) as Surreal,
    provider: provider as LLMProvider,
    conversationIndex,
    embed: options.embed ?? (async () => null),
    contextSettings: options.contextSettings ?? (() => defaultSettings()),
    engagedNotePath: options.engagedNotePath ?? (() => null),
    facade: { readNote: facadeRead },
    approvalMode: options.approvalMode ?? (() => "safe"),
    toolCatalog:
      options.toolCatalog ??
      (() => [
        { name: "vault.search", description: "Semantic search across notes." },
        { name: "vault.read", description: "Read note content." },
      ]),
    estimateTokens: options.estimateTokens ?? ((text) => Math.ceil(text.length / 4)),
    summaryModel: options.summaryModel ?? "Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M",
    bus: options.bus ?? new EventBus(),
  });
  return { manager, provider, conversationIndex };
}

describe("ContextManager.compose", () => {
  test("composes the canonical identity and every live context layer", async () => {
    const { manager } = makeManager({
      engagedNotePath: () => "Notes/Today.md",
      facade: { readNote: async () => "Pinned body content here." },
    });
    const conversation = makeConversation({ pinnedContext: ["Notes/Pinned.md"] });
    const result = await manager.compose(
      conversation,
      makeMessage("user", "What changed since yesterday?"),
      new AbortController().signal,
    );
    expect(result.systemPrompt).toContain("# Identity");
    expect(result.systemPrompt).toContain(NOTIENT_IDENTITY);
    expect(result.systemPrompt).toContain("# Vault snapshot");
    expect(result.systemPrompt).toContain("42 notes");
    expect(result.systemPrompt).toContain("# Engaged note");
    expect(result.systemPrompt).toContain("[[Notes/Today.md]]");
    expect(result.systemPrompt).toContain("# Pinned context");
    expect(result.systemPrompt).toContain("Pinned body content here.");
    expect(result.systemPrompt).toContain("# Approval mode");
    expect(result.systemPrompt).toContain("# Tools available");
    expect(result.systemPrompt).toContain("vault.search");
    expect(result.summarized).toBe(false);
    expect(result.messages[0]).toEqual({
      role: "system",
      content: result.systemPrompt,
    });
    expect(result.messages.at(-1)).toEqual({
      role: "user",
      content: "What changed since yesterday?",
    });
  });

  test("injects resolved attachment content ephemerally without treating it as a vault path", async () => {
    const reads: string[] = [];
    const { manager } = makeManager({
      facade: {
        readNote: async (path) => {
          reads.push(path);
          return "unexpected";
        },
      },
    });
    const attachment = "[attachment: Notes/Evidence.md]\nExact resolved attachment body.";

    const result = await manager.compose(
      makeConversation(),
      makeMessage("user", "Use @Notes/Evidence.md"),
      new AbortController().signal,
      [attachment],
    );

    expect(result.systemPrompt).toContain(attachment);
    expect(reads).toEqual([]);
  });

  test("rejects Notient-owned or noncanonical pinned paths before reading the vault", async () => {
    const reads: string[] = [];
    const { manager } = makeManager({
      facade: {
        readNote: async (path) => {
          reads.push(path);
          return "must not be read";
        },
      },
    });

    for (const pinnedPath of [
      "Notient/conversations/other.md",
      "Notient/proposals/pending.md",
      "../outside.md",
    ]) {
      await expect(
        manager.compose(
          makeConversation({ pinnedContext: [pinnedPath] }),
          makeMessage("user", "read it"),
          new AbortController().signal,
        ),
      ).rejects.toThrow("pinned-context integrity");
    }
    expect(reads).toEqual([]);
  });

  test("a failed snapshot query fails the turn instead of inventing an empty vault", async () => {
    const db = {
      query: () => ({
        collect: async () => {
          throw new Error("database unavailable");
        },
      }),
    } as unknown as Surreal;
    const { manager } = makeManager({ db });

    await expect(
      manager.compose(
        makeConversation(),
        makeMessage("user", "What is here?"),
        new AbortController().signal,
      ),
    ).rejects.toThrow("database unavailable");
  });

  test("omits optional snapshot and memory when disabled and no note is engaged", async () => {
    const { manager } = makeManager({
      contextSettings: () =>
        defaultSettings({
          includeVaultSnapshot: false,
          includeCrossSessionMemory: false,
        }),
      engagedNotePath: () => null,
    });
    const conversation = makeConversation();
    const result = await manager.compose(
      conversation,
      makeMessage("user", "hello"),
      new AbortController().signal,
    );
    expect(result.systemPrompt).not.toContain("# Vault snapshot");
    expect(result.systemPrompt).not.toContain("# Engaged note");
    expect(result.systemPrompt).not.toContain("# Earlier conversations");
  });

  test("describes yolo writes without promising universal reversibility", async () => {
    const { manager } = makeManager({ approvalMode: () => "yolo" });
    const result = await manager.compose(
      makeConversation(),
      makeMessage("user", "apply the change"),
      new AbortController().signal,
    );
    expect(result.systemPrompt).toContain("without per-call approval");
    expect(result.systemPrompt).toContain("not imply that every operation is reversible");
    expect(result.systemPrompt).not.toContain("Every action is undoable");
    expect(result.systemPrompt).toContain("exact [[vault/path.md]]");
  });

  test("reads the currently engaged note for every turn", async () => {
    let engaged = "Notes/First.md";
    const { manager } = makeManager({ engagedNotePath: () => engaged });
    const conversation = makeConversation();
    const first = await manager.compose(
      conversation,
      makeMessage("user", "first"),
      new AbortController().signal,
    );
    engaged = "Notes/Second.md";
    const second = await manager.compose(
      conversation,
      makeMessage("user", "second"),
      new AbortController().signal,
    );
    expect(first.systemPrompt).toContain("[[Notes/First.md]]");
    expect(first.systemPrompt).not.toContain("Notes/Second.md");
    expect(second.systemPrompt).toContain("[[Notes/Second.md]]");
    expect(second.systemPrompt).not.toContain("Notes/First.md");
  });

  test("summarizes oldest 50% when token budget is exceeded", async () => {
    const provider = new FakeProvider("compressed earlier turns");
    // estimateTokens returns content.length so easy to overflow.
    const longHistory: ChatMessage[] = [];
    for (let index = 0; index < 10; index++) {
      longHistory.push(
        makeMessage("user", "u".repeat(120), index * 2),
        makeMessage("assistant", "a".repeat(120), index * 2 + 1),
      );
    }
    const { manager } = makeManager({
      provider,
      contextSettings: () =>
        defaultSettings({ modelContextTokens: 200, contextBudgetFraction: 0.5 }),
      estimateTokens: (text) => text.length,
    });
    const conversation = makeConversation({ messages: longHistory });
    const result = await manager.compose(
      conversation,
      makeMessage("user", "next question"),
      new AbortController().signal,
    );
    expect(result.summarized).toBe(true);
    expect(provider.summaryCalls.length).toBe(1);
    const summarizationPrompt = provider.summaryCalls[0];
    expect(summarizationPrompt?.[0]?.content).toContain(NOTIENT_IDENTITY);
    expect(summarizationPrompt?.[0]?.content).not.toContain("Notient assistant");
    expect(summarizationPrompt?.[1]?.content).toContain("Notient:");
    const summaryContext = result.messages.find(
      (message) =>
        message.role === "assistant" &&
        typeof message.content === "string" &&
        message.content.startsWith("Earlier conversation summary (historical data"),
    );
    expect(summaryContext).toBeDefined();
    expect(summaryContext?.content as string).toContain("compressed earlier turns");
    expect(result.messages.filter((message) => message.role === "system")).toHaveLength(1);
    // Newest turn must still be present verbatim.
    expect(result.messages.at(-1)?.content).toBe("next question");
  });

  test("summarization never splits an assistant tool_calls group from its replies", async () => {
    const provider = new FakeProvider("compressed earlier turns");
    const filler = (role: "user" | "assistant", at: number): ChatMessage =>
      makeMessage(role, `${role[0]}`.repeat(120), at);
    // Nine messages once the latest user turn is appended, so the naive
    // midpoint cutoff (floor(9 / 2) = 4) lands on the first tool reply and
    // leaves its assistant tool_calls message behind in the summarized half.
    const history: ChatMessage[] = [
      filler("user", 0),
      filler("assistant", 1),
      filler("user", 2),
      {
        ...makeMessage("assistant", "calling tools", 3),
        toolCalls: [
          { id: "call-1", name: "vault.read", args: { path: "A.md" } },
          { id: "call-2", name: "vault.read", args: { path: "B.md" } },
        ],
      },
      makeMessage("tool", '{"body":"a"}', 4, "call-1"),
      makeMessage("tool", '{"body":"b"}', 5, "call-2"),
      filler("assistant", 6),
      filler("user", 7),
    ];
    const { manager } = makeManager({
      provider,
      contextSettings: () =>
        defaultSettings({ modelContextTokens: 200, contextBudgetFraction: 0.5 }),
      estimateTokens: (text) => text.length,
    });
    const result = await manager.compose(
      makeConversation({ messages: history }),
      makeMessage("user", "next question", 8),
      new AbortController().signal,
    );
    expect(result.summarized).toBe(true);
    const announced = new Set<string>();
    for (const message of result.messages) {
      if (message.role === "assistant") {
        for (const call of message.tool_calls ?? []) announced.add(call.id);
      }
      if (message.role === "tool") {
        // An orphan tool message is what llama.cpp rejects with
        // "tool message with no matching tool call".
        expect(announced.has(message.tool_call_id)).toBe(true);
      }
    }
  });

  test("emits loop:context_summarized when oldest half is replaced by a summary", async () => {
    const provider = new FakeProvider("compressed earlier turns");
    const longHistory: ChatMessage[] = [];
    for (let index = 0; index < 10; index++) {
      longHistory.push(
        makeMessage("user", "u".repeat(120), index * 2),
        makeMessage("assistant", "a".repeat(120), index * 2 + 1),
      );
    }
    const bus = new EventBus();
    const events: ContextSummarizedEvent[] = [];
    bus.on("loop:context_summarized", (event) => {
      events.push(event);
    });
    const { manager } = makeManager({
      provider,
      bus,
      contextSettings: () =>
        defaultSettings({ modelContextTokens: 200, contextBudgetFraction: 0.5 }),
      estimateTokens: (text) => text.length,
    });
    const conversation = makeConversation({ messages: longHistory });
    await manager.compose(
      conversation,
      makeMessage("user", "next question"),
      new AbortController().signal,
    );
    expect(events.length).toBe(1);
    expect(events[0].conversationId).toBe(conversation.id);
    expect(events[0].originalTokens).toBeGreaterThan(events[0].summarizedTokens);
    expect(events[0].model).toBe("Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M");
  });

  test("emits loop:context_overflow_warning when used > modelContextTokens", async () => {
    const longHistory: ChatMessage[] = [];
    for (let index = 0; index < 6; index++) {
      longHistory.push(makeMessage("user", "y".repeat(200), index));
    }
    const bus = new EventBus();
    const warnings: ContextOverflowWarningEvent[] = [];
    bus.on("loop:context_overflow_warning", (event) => {
      warnings.push(event);
    });
    const { manager } = makeManager({
      bus,
      contextSettings: () =>
        defaultSettings({ modelContextTokens: 50, contextBudgetFraction: 0.5 }),
      estimateTokens: (text) => text.length,
    });
    const conversation = makeConversation({ messages: longHistory });
    await manager.compose(
      conversation,
      makeMessage("user", "trigger", 99),
      new AbortController().signal,
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0].configuredTokens).toBe(50);
    expect(warnings[0].estimatedTokens).toBeGreaterThan(50);
    expect(warnings[0].conversationId).toBe(conversation.id);
  });

  test("cross-session memory injects top-K matches and excludes the current conversation", async () => {
    const conversationIndex = new InMemoryConversationMemory("test-model", 3);
    const queryVector = new Float32Array([1, 0, 0]);
    const sameVector = new Float32Array([1, 0, 0]);
    await conversationIndex.record(
      {
        id: "conv-other",
        notePath: "Notient/conversations/2026-04-20 prior.md",
        model: "model",
        pinnedContext: [],
        approvalMode: "safe",
        topic: "Prior topic",
        summary: "Prior summary",
        clientIdentity: "human",
        messageCount: 0,
        createdAt: 0,
        updatedAt: 1,
        messages: [],
      },
      sameVector,
    );
    await conversationIndex.record(
      {
        id: "conv-other-owner",
        notePath: "Notient/conversations/2026-04-21 private.md",
        model: "model",
        pinnedContext: [],
        approvalMode: "safe",
        topic: "Another agent private topic",
        summary: "Another principal's private summary",
        clientIdentity: "agent-b",
        messageCount: 0,
        createdAt: 0,
        updatedAt: 3,
        messages: [],
      },
      sameVector,
    );
    await conversationIndex.record(
      {
        id: "conv-current",
        notePath: "Notient/conversations/2026-04-25 current.md",
        model: "model",
        pinnedContext: [],
        approvalMode: "safe",
        topic: "Current topic",
        summary: "Current summary",
        clientIdentity: "human",
        messageCount: 0,
        createdAt: 0,
        updatedAt: 2,
        messages: [],
      },
      sameVector,
    );
    const { manager } = makeManager({
      conversationIndex,
      embed: async () => queryVector,
    });
    const result = await manager.compose(
      makeConversation(),
      makeMessage("user", "any related work?"),
      new AbortController().signal,
    );
    expect(result.systemPrompt).toContain("# Earlier conversations");
    expect(result.systemPrompt).toContain("Prior topic");
    expect(result.systemPrompt).not.toContain("Current topic");
    expect(result.systemPrompt).not.toContain("Another agent private topic");
  });

  test("propagates AbortError from cross-session memory embedder", async () => {
    const { manager } = makeManager({
      embed: async () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    });
    const conversation = makeConversation();
    await expect(
      manager.compose(conversation, makeMessage("user", "anything"), new AbortController().signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  test("propagates AbortError from history-summarization chatJson", async () => {
    class AbortingProvider extends FakeProvider {
      override async chatJson<T>(): Promise<T> {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
    }
    const provider = new AbortingProvider();
    const longHistory: ChatMessage[] = [];
    for (let index = 0; index < 10; index++) {
      longHistory.push(
        makeMessage("user", "u".repeat(120), index * 2),
        makeMessage("assistant", "a".repeat(120), index * 2 + 1),
      );
    }
    const { manager } = makeManager({
      provider,
      contextSettings: () =>
        defaultSettings({
          modelContextTokens: 200,
          contextBudgetFraction: 0.5,
          includeCrossSessionMemory: false,
        }),
      estimateTokens: (text) => text.length,
    });
    const conversation = makeConversation({ messages: longHistory });
    await expect(
      manager.compose(
        conversation,
        makeMessage("user", "next question"),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  test("non-abort embed failure is swallowed and cross-session memory is omitted", async () => {
    const { manager } = makeManager({
      embed: async () => {
        throw new Error("embed service down");
      },
    });
    const conversation = makeConversation();
    const result = await manager.compose(
      conversation,
      makeMessage("user", "anything"),
      new AbortController().signal,
    );
    expect(result.systemPrompt).not.toContain("# Earlier conversations");
  });

  test("pinned context is elided when it exceeds pinnedNoteMaxTokens", async () => {
    const longBody = "x".repeat(4000);
    const { manager } = makeManager({
      facade: { readNote: async () => longBody },
      contextSettings: () => defaultSettings({ pinnedNoteMaxTokens: 100 }),
      estimateTokens: (text) => text.length,
    });
    const conversation = makeConversation({ pinnedContext: ["Notes/Big.md"] });
    const result = await manager.compose(
      conversation,
      makeMessage("user", "summarize the pinned note"),
      new AbortController().signal,
    );
    expect(result.systemPrompt).toContain("[...");
    expect(result.systemPrompt).toContain("tokens elided...]");
    expect(result.systemPrompt.length).toBeLessThan(longBody.length + 2000);
  });
});

describe("toProviderMessages", () => {
  test("replays a persisted tool round in the OpenAI tool-call protocol", () => {
    const history: ChatMessage[] = [
      makeMessage("user", "read A"),
      {
        ...makeMessage("assistant", "looking"),
        toolCalls: [{ id: "call-1", name: "vault.read", args: { path: "A.md" } }],
        toolResults: [{ callId: "call-1", status: "ok", data: { body: "x" }, durationMs: 1 }],
      },
      makeMessage("tool", '{"body":"x"}', 0, "call-1"),
    ];

    expect(toProviderMessages(history)).toEqual([
      { role: "user", content: "read A" },
      {
        role: "assistant",
        content: "looking",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "vault.read", arguments: '{"path":"A.md"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: '{"body":"x"}' },
    ]);
  });

  test("rejects an assistant tool call without its canonical tool message", () => {
    const history: ChatMessage[] = [
      {
        ...makeMessage("assistant", "looking"),
        toolCalls: [{ id: "call-1", name: "vault.read", args: { path: "A.md" } }],
      },
    ];

    expect(() => toProviderMessages(history)).toThrow(
      "tool call call-1 has no matching tool message",
    );
  });
});
