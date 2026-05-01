import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import {
  ContextManager,
  type ContextManagerOptions,
  type ContextSettingsView,
} from "../../../../src/core/chat/contextManager";
import { ConversationIndex } from "../../../../src/core/chat/conversationIndex";
import { encodeBase64Float32 } from "../../../../src/core/chat/conversationIndex";
import type { ChatMessage, Conversation } from "../../../../src/core/chat/types";
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

interface CountRow {
  count: number;
}

/**
 * Phase 5 Task 7: minimal SurrealDB shim used by the unit tests. ContextManager
 * issues `SELECT count() FROM <table> [WHERE ...] GROUP ALL;` queries; the
 * fake matches each query string against a canned result set so the snapshot
 * line ("N notes. M approved edges. K pending proposals.") can be asserted
 * against without a live SurrealDB. The smoke surface owns the live-DB
 * coverage.
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

interface IndexFile {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
}

class InMemoryIndexFacade implements IndexFile {
  private store = new Map<string, string>();
  async read(path: string): Promise<string | null> {
    return this.store.get(path) ?? null;
  }
  async write(path: string, content: string): Promise<void> {
    this.store.set(path, content);
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
    summaryEmbeddingB64: null,
    clientIdentity: "human",
    messageCount: 0,
    createdAt: 0,
    updatedAt: 0,
    messages: [],
    ...overrides,
  };
}

function makeMessage(role: ChatMessage["role"], content: string, createdAt = 0): ChatMessage {
  return { id: `${role}-${createdAt}`, role, content, createdAt };
}

function defaultSettings(overrides: Partial<ContextSettingsView> = {}): ContextSettingsView {
  return {
    includeUserProfile: true,
    includeVaultSnapshot: true,
    includeWorkspaceState: true,
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
  conversationIndex: ConversationIndex;
} {
  const provider = options.provider instanceof FakeProvider ? options.provider : new FakeProvider();
  const facadeRead = options.facade?.readNote ?? (async () => "");
  const conversationIndex =
    options.conversationIndex ??
    new ConversationIndex({
      facade: new InMemoryIndexFacade(),
      indexPath: "Notient/.index.json",
    });
  const manager = new ContextManager({
    db: (options.db ?? (new FakeSurreal() as unknown)) as Surreal,
    provider: provider as LLMProvider,
    conversationIndex,
    embed: options.embed ?? (async () => null),
    contextSettings: options.contextSettings ?? (() => defaultSettings()),
    workspace: options.workspace ?? {
      getActiveNotePath: () => null,
      getOpenNotePaths: () => [],
      getRecentNotePaths: () => [],
      getRecentSearchQueries: () => [],
    },
    facade: { readNote: facadeRead },
    voiceProfile: options.voiceProfile ?? (() => ""),
    approvalMode: options.approvalMode ?? (() => "safe"),
    toolCatalog:
      options.toolCatalog ??
      (() => [
        { name: "vault.search", description: "Semantic search across notes." },
        { name: "vault.read", description: "Read note content." },
      ]),
    estimateTokens: options.estimateTokens ?? ((text) => Math.ceil(text.length / 4)),
    summaryModel: options.summaryModel ?? "Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M",
    identity: options.identity,
    bus: options.bus,
  });
  return { manager, provider, conversationIndex };
}

describe("ContextManager.compose", () => {
  test("composes all eight layers when every flag is enabled", async () => {
    const { manager } = makeManager({
      voiceProfile: () =>
        "Writes in second person. Prefers terse outlines. Uses lowercase headings.",
      workspace: {
        getActiveNotePath: () => "Notes/Today.md",
        getOpenNotePaths: () => ["Notes/Today.md", "Notes/Other.md"],
        getRecentNotePaths: () => ["Notes/Yesterday.md", "Notes/A.md"],
        getRecentSearchQueries: () => ["embedding pipeline", "graph proposals"],
      },
      facade: { readNote: async () => "Pinned body content here." },
    });
    const conversation = makeConversation({ pinnedContext: ["Notes/Pinned.md"] });
    const result = await manager.compose(
      conversation,
      makeMessage("user", "What changed since yesterday?"),
      new AbortController().signal,
    );
    expect(result.systemPrompt).toContain("# Identity");
    expect(result.systemPrompt).toContain("# User profile");
    expect(result.systemPrompt).toContain("# Vault snapshot");
    expect(result.systemPrompt).toContain("42 notes");
    expect(result.systemPrompt).toContain("# Workspace");
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

  test("omits sections when their setting is disabled", async () => {
    const { manager } = makeManager({
      contextSettings: () =>
        defaultSettings({
          includeUserProfile: false,
          includeVaultSnapshot: false,
          includeWorkspaceState: false,
          includeCrossSessionMemory: false,
        }),
      voiceProfile: () => "should-not-appear",
      workspace: {
        getActiveNotePath: () => "should-not-appear.md",
        getOpenNotePaths: () => [],
        getRecentNotePaths: () => [],
        getRecentSearchQueries: () => [],
      },
    });
    const conversation = makeConversation();
    const result = await manager.compose(
      conversation,
      makeMessage("user", "hello"),
      new AbortController().signal,
    );
    expect(result.systemPrompt).not.toContain("# User profile");
    expect(result.systemPrompt).not.toContain("# Vault snapshot");
    expect(result.systemPrompt).not.toContain("# Workspace");
    expect(result.systemPrompt).not.toContain("# Earlier conversations");
    expect(result.systemPrompt).not.toContain("should-not-appear");
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
    const summarySystem = result.messages.find(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.startsWith("Earlier in this conversation:"),
    );
    expect(summarySystem).toBeDefined();
    expect(summarySystem?.content as string).toContain("compressed earlier turns");
    // Newest turn must still be present verbatim.
    expect(result.messages.at(-1)?.content).toBe("next question");
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
    const conversationIndex = new ConversationIndex({
      facade: new InMemoryIndexFacade(),
      indexPath: "Notient/.index.json",
    });
    const queryVector = new Float32Array([1, 0, 0]);
    const sameVector = new Float32Array([1, 0, 0]);
    await conversationIndex.record({
      id: "conv-other",
      notePath: "Notient/conversations/2026-04-20 prior.md",
      model: "model",
      pinnedContext: [],
      approvalMode: "safe",
      topic: "Prior topic",
      summary: "",
      summaryEmbeddingB64: encodeBase64Float32(sameVector),
      clientIdentity: "human",
      messageCount: 0,
      createdAt: 0,
      updatedAt: 1,
      messages: [],
    });
    await conversationIndex.record({
      id: "conv-current",
      notePath: "Notient/conversations/2026-04-25 current.md",
      model: "model",
      pinnedContext: [],
      approvalMode: "safe",
      topic: "Current topic",
      summary: "",
      summaryEmbeddingB64: encodeBase64Float32(sameVector),
      clientIdentity: "human",
      messageCount: 0,
      createdAt: 0,
      updatedAt: 2,
      messages: [],
    });
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
