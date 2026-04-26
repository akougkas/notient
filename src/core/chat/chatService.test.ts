import { describe, expect, test } from "bun:test";
import { ReasoningMutex } from "../coordinator/reasoningMutex";
import type {
  ChatOptions,
  ChatWithToolsHandle,
  ChatWithToolsRequest,
  ChatWithToolsResult,
  ChatWithToolsToolCall,
  EmbedOptions,
  JsonSchema,
  LLMProvider,
  ChatMessage as ProviderChatMessage,
} from "../llm/provider";
import { ApprovalGate } from "./approvalGate";
import { type ChatRuntimeSettings, ChatService, type ChatStreamEvent } from "./chatService";
import { ContextManager, type ContextSettingsView } from "./contextManager";
import {
  ConversationIndex,
  type ConversationIndexFacade,
  encodeBase64Float32,
} from "./conversationIndex";
import { ConversationStore, type ConversationStoreFacade } from "./conversationStore";
import type { ToolMode, ToolModeCache } from "./toolModeProbe";
import { ToolRegistry } from "./tools/registry";
import type { Conversation } from "./types";

interface ScriptedTurn {
  toolCalls?: ChatWithToolsToolCall[];
  finalContent?: string;
}

class ScriptedProvider implements LLMProvider {
  public readonly toolRequests: ChatWithToolsRequest[] = [];
  public readonly jsonRequests: ProviderChatMessage[][] = [];
  public readonly embedRequests: string[][] = [];

  constructor(
    private readonly turns: ScriptedTurn[],
    private readonly summaryText = "session summary",
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
    _options: ChatOptions,
    _schema: JsonSchema,
  ): Promise<T> {
    this.jsonRequests.push(messages);
    return { summary: this.summaryText } as unknown as T;
  }
  async embed(input: string[], _options: EmbedOptions): Promise<number[][]> {
    this.embedRequests.push(input);
    return input.map(() => Array.from({ length: 4 }, () => 0.1));
  }
  async chatWithTools(request: ChatWithToolsRequest): Promise<ChatWithToolsHandle> {
    this.toolRequests.push(request);
    const turn = this.turns[this.toolRequests.length - 1];
    if (!turn) throw new Error("unexpected provider call");
    const result: ChatWithToolsResult = {
      content: turn.finalContent ?? "",
      reasoningContent: "",
      toolCalls: turn.toolCalls ?? [],
    };
    const events = (async function* () {
      if (turn.finalContent) {
        yield { type: "delta" as const, contentDelta: turn.finalContent };
      }
    })();
    return { events, result: async () => result };
  }
}

class FakeStoreFacade implements ConversationStoreFacade {
  public readonly files = new Map<string, string>();
  async list(folder: string): Promise<string[]> {
    const prefix = `${folder}/`;
    return Array.from(this.files.keys()).filter((path) => path.startsWith(prefix));
  }
  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`not found: ${path}`);
    return content;
  }
  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }
}

class FakeIndexFacade implements ConversationIndexFacade {
  public readonly files = new Map<string, string>();
  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
}

interface FakeDatabase {
  query<T>(sql: string): T[];
}

function makeDatabase(): FakeDatabase {
  return {
    query<T>(_sql: string): T[] {
      return [{ count: 0 } as unknown as T];
    },
  };
}

function makeToolModeCache(initial: Record<string, ToolMode> = {}): ToolModeCache & {
  store: Record<string, ToolMode>;
  writeCount: number;
} {
  const store = { ...initial };
  let writeCount = 0;
  return {
    store,
    get writeCount() {
      return writeCount;
    },
    read: (model) => store[model] ?? null,
    write: async (model, mode) => {
      store[model] = mode;
      writeCount++;
    },
  };
}

function defaultRuntimeSettings(overrides: Partial<ChatRuntimeSettings> = {}): ChatRuntimeSettings {
  return {
    model: "Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M",
    maxRoundsPerTurn: 4,
    approvalMode: "yolo",
    persistReasoning: false,
    ...overrides,
  };
}

interface ServiceFixture {
  service: ChatService;
  provider: ScriptedProvider;
  store: ConversationStore;
  storeFacade: FakeStoreFacade;
  conversationIndex: ConversationIndex;
  indexFacade: FakeIndexFacade;
  toolRegistry: ToolRegistry;
  approvalGate: ApprovalGate;
  mutex: ReasoningMutex;
  toolModeCache: ReturnType<typeof makeToolModeCache>;
}

function makeService(
  turns: ScriptedTurn[],
  options: {
    settings?: () => ChatRuntimeSettings;
    contextSettings?: () => ContextSettingsView;
    embed?: (text: string, signal: AbortSignal) => Promise<Float32Array | null>;
    toolModeCache?: ReturnType<typeof makeToolModeCache>;
    summaryText?: string;
    voiceProfile?: () => string;
    pinnedPath?: string;
  } = {},
): ServiceFixture {
  const provider = new ScriptedProvider(turns, options.summaryText);
  const storeFacade = new FakeStoreFacade();
  const indexFacade = new FakeIndexFacade();
  const conversationIndex = new ConversationIndex({
    facade: indexFacade,
    indexPath: "Notient/.index.json",
  });
  let now = 1745625600000;
  const advance = () => {
    now += 1;
    return now;
  };
  const store = new ConversationStore({
    facade: storeFacade,
    folder: "Notient/conversations",
    now: advance,
  });
  const toolRegistry = new ToolRegistry();
  const approvalGate = new ApprovalGate({
    events: { onPending: () => undefined, onResolved: () => undefined },
    recordHistoryAutoApprove: async () => undefined,
  });
  const mutex = new ReasoningMutex();
  const toolModeCache =
    options.toolModeCache ??
    makeToolModeCache({
      "Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M": "native",
    });
  const contextManager = new ContextManager({
    database: makeDatabase() as unknown as ConstructorParameters<
      typeof ContextManager
    >[0]["database"],
    provider,
    conversationIndex,
    embed: options.embed ?? (async () => null),
    contextSettings:
      options.contextSettings ??
      (() => ({
        includeUserProfile: false,
        includeVaultSnapshot: true,
        includeWorkspaceState: false,
        includeCrossSessionMemory: true,
        crossSessionTopK: 2,
        crossSessionSimThreshold: 0.7,
        pinnedNoteMaxTokens: 4000,
        contextBudgetFraction: 0.7,
        modelContextTokens: 8192,
      })),
    workspace: {
      getActiveNotePath: () => null,
      getOpenNotePaths: () => [],
      getRecentNotePaths: () => [],
      getRecentSearchQueries: () => [],
    },
    facade: { readNote: async () => "" },
    voiceProfile: options.voiceProfile ?? (() => ""),
    approvalMode: () => "safe",
    toolCatalog: () => [],
    estimateTokens: (text: string) => Math.ceil(text.length / 4),
    summaryModel: "Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M",
  } as unknown as ConstructorParameters<typeof ContextManager>[0]);
  const service = new ChatService({
    provider,
    contextManager,
    conversationStore: store,
    conversationIndex,
    toolRegistry,
    approvalGate,
    mutex,
    toolModeCache,
    embed: options.embed ?? (async () => new Float32Array([0.1, 0.2, 0.3, 0.4])),
    settings: options.settings ?? (() => defaultRuntimeSettings()),
    generateId: (() => {
      let counter = 0;
      return () => `id-${counter++}`;
    })(),
    now: () => 1745625600000,
  });
  return {
    service,
    provider,
    store,
    storeFacade,
    conversationIndex,
    indexFacade,
    toolRegistry,
    approvalGate,
    mutex,
    toolModeCache,
  };
}

async function collect(generator: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

describe("ChatService", () => {
  test("startConversation writes a fresh markdown file", async () => {
    const fixture = makeService([{ finalContent: "ok" }]);
    const conversation = await fixture.service.startConversation({
      topic: "Daily review",
    });
    expect(conversation.notePath).toContain("Notient/conversations/");
    expect(fixture.storeFacade.files.has(conversation.notePath)).toBe(true);
    const raw = fixture.storeFacade.files.get(conversation.notePath) ?? "";
    expect(raw).toContain('topic: "Daily review"');
    expect(raw).toContain("approval_mode: yolo");
  });

  test("sendMessage runs the loop and persists the conversation", async () => {
    const fixture = makeService([{ finalContent: "Hello back." }]);
    const conversation = await fixture.service.startConversation({ topic: "Smoke" });
    const events = await collect(
      fixture.service.sendMessage({ conversation, userMessage: "Hi there" }),
    );
    expect(events.find((event) => event.type === "turn:start")).toBeDefined();
    const complete = events.find((event) => event.type === "turn:complete");
    expect(complete).toBeDefined();
    if (complete && complete.type === "turn:complete") {
      const messages = complete.conversation.messages;
      expect(messages.length).toBe(2);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("Hi there");
      expect(messages[1].role).toBe("assistant");
      expect(messages[1].content).toBe("Hello back.");
    }
    // Persisted to vault.
    const raw = fixture.storeFacade.files.get(conversation.notePath) ?? "";
    expect(raw).toContain("Hi there");
    expect(raw).toContain("Hello back.");
    // Provider was called for the chat turn AND for the post-turn summary.
    expect(fixture.provider.toolRequests.length).toBe(1);
    expect(fixture.provider.jsonRequests.length).toBe(1);
  });

  test("listConversations delegates to the store", async () => {
    const fixture = makeService([{ finalContent: "ok" }]);
    await fixture.service.startConversation({ topic: "First" });
    await fixture.service.startConversation({ topic: "Second" });
    const conversations = await fixture.service.listConversations();
    expect(conversations.length).toBe(2);
    expect(conversations.map((entry) => entry.topic).sort()).toEqual(["First", "Second"]);
  });

  test("cross-session memory is injected when prior conversation matches", async () => {
    const sharedVector = new Float32Array([1, 0, 0, 0]);
    const indexFacade = new FakeIndexFacade();
    const conversationIndex = new ConversationIndex({
      facade: indexFacade,
      indexPath: "Notient/.index.json",
    });
    const priorConversation: Conversation = {
      id: "conv-prior",
      notePath: "Notient/conversations/2026-04-20 prior.md",
      model: "Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M",
      pinnedContext: [],
      approvalMode: "safe",
      topic: "Project planning",
      summary: "discussed Q2 goals",
      summaryEmbeddingB64: encodeBase64Float32(sharedVector),
      messageCount: 0,
      createdAt: 0,
      updatedAt: 1,
      messages: [],
    };
    await conversationIndex.record(priorConversation);

    const provider = new ScriptedProvider([{ finalContent: "noted." }], "fresh summary");
    const storeFacade = new FakeStoreFacade();
    const store = new ConversationStore({
      facade: storeFacade,
      folder: "Notient/conversations",
      now: () => 1745625600000,
    });
    const toolRegistry = new ToolRegistry();
    const approvalGate = new ApprovalGate({
      events: { onPending: () => undefined, onResolved: () => undefined },
      recordHistoryAutoApprove: async () => undefined,
    });
    const mutex = new ReasoningMutex();
    const toolModeCache = makeToolModeCache({
      "Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M": "native",
    });
    const contextManager = new ContextManager({
      database: makeDatabase() as unknown as ConstructorParameters<
        typeof ContextManager
      >[0]["database"],
      provider,
      conversationIndex,
      embed: async () => sharedVector,
      contextSettings: () => ({
        includeUserProfile: false,
        includeVaultSnapshot: false,
        includeWorkspaceState: false,
        includeCrossSessionMemory: true,
        crossSessionTopK: 2,
        crossSessionSimThreshold: 0.5,
        pinnedNoteMaxTokens: 4000,
        contextBudgetFraction: 0.7,
        modelContextTokens: 8192,
      }),
      workspace: {
        getActiveNotePath: () => null,
        getOpenNotePaths: () => [],
        getRecentNotePaths: () => [],
        getRecentSearchQueries: () => [],
      },
      facade: { readNote: async () => "" },
      voiceProfile: () => "",
      approvalMode: () => "safe",
      toolCatalog: () => [],
      estimateTokens: (text) => Math.ceil(text.length / 4),
      summaryModel: "Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M",
    });
    const service = new ChatService({
      provider,
      contextManager,
      conversationStore: store,
      conversationIndex,
      toolRegistry,
      approvalGate,
      mutex,
      toolModeCache,
      embed: async () => sharedVector,
      settings: () => defaultRuntimeSettings(),
      generateId: (() => {
        let counter = 0;
        return () => `id-${counter++}`;
      })(),
      now: () => 1745625600000,
    });
    const conversation = await service.startConversation({ topic: "Followup" });
    await collect(service.sendMessage({ conversation, userMessage: "what was decided?" }));
    const sentSystem = provider.toolRequests[0].messages[0];
    expect(sentSystem.role).toBe("system");
    expect(sentSystem.content).toContain("Earlier conversations");
    expect(sentSystem.content).toContain("Project planning");
  });
});
