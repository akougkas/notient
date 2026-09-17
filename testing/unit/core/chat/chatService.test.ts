import { describe, expect, test } from "bun:test";
import type { VaultAdapter } from "../../../../src/adapters/vaultAdapter";
import { contentRevision } from "../../../../src/api/notes";
import { NoteAnalysis } from "../../../../src/core/analysis/noteAnalysis";
import { ApprovalGate } from "../../../../src/core/chat/approvalGate";
import {
  type ChatRuntimeSettings,
  ChatService,
  type ChatStreamEvent,
} from "../../../../src/core/chat/chatService";
import { ContextManager, type ContextSettingsView } from "../../../../src/core/chat/contextManager";
import {
  ConversationStore,
  type ConversationStoreFacade,
} from "../../../../src/core/chat/conversationStore";
import type { ToolMode, ToolModeCache } from "../../../../src/core/chat/toolModeProbe";
import { makeAnalysisTools } from "../../../../src/core/chat/tools/analysis";
import { ToolRegistry } from "../../../../src/core/chat/tools/registry";
import type { Conversation } from "../../../../src/core/chat/types";
import { ReasoningScheduler } from "../../../../src/core/coordinator/reasoningScheduler";
import { EventBus } from "../../../../src/core/events/eventBus";
import { LMStudioProvider } from "../../../../src/core/llm/lmStudioProvider";
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
} from "../../../../src/core/llm/provider";
import type { SearchPipeline } from "../../../../src/core/search/searchPipeline";
import { DEFAULT_CHAT_BUDGET } from "../../../../src/core/settings/types";
import { currentCoverageFixture, currentIndexingFixture } from "../../../indexingFixture";
import { InMemoryConversationMemory } from "./conversationMemoryFake";

interface ScriptedTurn {
  toolCalls?: ChatWithToolsToolCall[];
  finalContent?: string;
  /**
   * Holds the provider call open until the promise settles, so a test can
   * keep several turns in flight at once. The wait is abort-aware: aborting
   * the request signal rejects it the way a real provider would.
   */
  park?: Promise<void>;
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
    if (turn.park) {
      await new Promise<void>((resolve, reject) => {
        const fail = (): void => reject(new Error("aborted"));
        if (request.signal.aborted) {
          fail();
          return;
        }
        request.signal.addEventListener("abort", fail, { once: true });
        void turn.park?.then(() => {
          request.signal.removeEventListener("abort", fail);
          resolve();
        });
      });
    }
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
  async createIfAbsent(path: string, content: string): Promise<boolean> {
    if (this.files.has(path)) return false;
    this.files.set(path, content);
    return true;
  }
  async writeIfUnchanged(path: string, expected: string, content: string): Promise<boolean> {
    if (this.files.get(path) !== expected) return false;
    this.files.set(path, content);
    return true;
  }
  async removeIfUnchanged(path: string, expected: string): Promise<boolean> {
    if (this.files.get(path) !== expected) return false;
    this.files.delete(path);
    return true;
  }
}

/** Minimal SurrealDB query shape used by ContextManager's vault snapshot. */
interface FakeSurreal {
  query<T>(sql: string): { collect: <R = T>() => Promise<R> };
}

function makeSurreal(): FakeSurreal {
  return {
    query<T>(_sql: string): { collect: <R = T>() => Promise<R> } {
      return {
        collect: async <R = T>(): Promise<R> => [[{ count: 0 }]] as unknown as R,
      };
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
    budget: { ...DEFAULT_CHAT_BUDGET },
    approvalMode: "yolo",
    persistReasoning: false,
    ...overrides,
  };
}

interface ServiceFixture {
  bus: EventBus;
  service: ChatService;
  provider: ScriptedProvider;
  store: ConversationStore;
  storeFacade: FakeStoreFacade;
  conversationIndex: InMemoryConversationMemory;
  toolRegistry: ToolRegistry;
  approvalGate: ApprovalGate;
  scheduler: ReasoningScheduler;
  toolModeCache: ReturnType<typeof makeToolModeCache>;
}

function makeService(
  turns: ScriptedTurn[],
  options: {
    wireProvider?: LLMProvider;
    settings?: () => ChatRuntimeSettings;
    contextSettings?: () => ContextSettingsView;
    embed?: (text: string, signal: AbortSignal) => Promise<Float32Array | null>;
    toolModeCache?: ReturnType<typeof makeToolModeCache>;
    scheduler?: ReasoningScheduler;
    summaryText?: string;
    pinnedPath?: string;
    conversationIndex?: InMemoryConversationMemory;
  } = {},
): ServiceFixture {
  const provider = new ScriptedProvider(turns, options.summaryText);
  const storeFacade = new FakeStoreFacade();
  const conversationIndex = options.conversationIndex ?? new InMemoryConversationMemory();
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
    recordHistoryAutoApprove: async () => undefined,
    perToolPolicy: () => ({}),
    sessionGrants: { claim: async () => null },
  });
  const scheduler = options.scheduler ?? new ReasoningScheduler({ maxConcurrent: 1 });
  const bus = new EventBus();
  const toolModeCache =
    options.toolModeCache ??
    makeToolModeCache({
      "Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M": "native",
    });
  const contextManager = new ContextManager({
    db: makeSurreal() as unknown as ConstructorParameters<typeof ContextManager>[0]["db"],
    provider: options.wireProvider ?? provider,
    conversationIndex,
    embed: options.embed ?? (async () => null),
    contextSettings:
      options.contextSettings ??
      (() => ({
        includeVaultSnapshot: true,
        includeCrossSessionMemory: true,
        crossSessionTopK: 2,
        crossSessionSimThreshold: 0.7,
        pinnedNoteMaxTokens: 4000,
        contextBudgetFraction: 0.7,
        modelContextTokens: 8192,
      })),
    engagedNotePath: () => null,
    facade: { readNote: async () => "" },
    approvalMode: () => "safe",
    toolCatalog: () => [],
    estimateTokens: (text: string) => Math.ceil(text.length / 4),
    summaryModel: "Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M",
    bus,
  } as unknown as ConstructorParameters<typeof ContextManager>[0]);
  const service = new ChatService({
    provider: options.wireProvider ?? provider,
    contextManager,
    conversationStore: store,
    conversationIndex,
    toolRegistry,
    scheduler,
    toolModeCache,
    embed: options.embed ?? (async () => new Float32Array([0.1, 0.2, 0.3, 0.4])),
    settings: options.settings ?? (() => defaultRuntimeSettings()),
    bus,
    generateId: (() => {
      let counter = 0;
      return () => `id-${counter++}`;
    })(),
    now: () => 1745625600000,
  });
  return {
    bus,
    service,
    provider,
    store,
    storeFacade,
    conversationIndex,
    toolRegistry,
    approvalGate,
    scheduler,
    toolModeCache,
  };
}

async function collect(generator: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

interface Gate {
  promise: Promise<void>;
  release: () => void;
}

function createGate(): Gate {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

describe("ChatService abort scoping", () => {
  test("abortConnection works immediately after turn:start", async () => {
    const fixture = makeService([{ finalContent: "must not run" }]);
    const conversation = await fixture.service.startConversation({
      topic: "Immediate abort",
      clientIdentity: "human",
    });
    const generator = fixture.service.sendMessage({
      conversation,
      userMessage: "start",
      connectionId: "conn-a",
    });

    const first = await generator.next();
    expect(first.value?.type).toBe("turn:start");
    fixture.service.abortConnection("conn-a");
    const remaining = await collect(generator);

    expect(remaining.some((event) => event.type === "turn:aborted")).toBe(true);
    expect(fixture.provider.toolRequests).toHaveLength(0);
  });

  test("abortConnection removes that connection's queued turn", async () => {
    const park = createGate();
    const fixture = makeService(
      [{ finalContent: "first", park: park.promise }, { finalContent: "second" }],
      { scheduler: new ReasoningScheduler({ maxConcurrent: 1 }) },
    );
    const conversationA = await fixture.service.startConversation({
      topic: "A",
      clientIdentity: "human",
    });
    const conversationB = await fixture.service.startConversation({
      topic: "B",
      clientIdentity: "claude-code",
    });
    const runA = collect(
      fixture.service.sendMessage({
        conversation: conversationA,
        userMessage: "occupy the slot",
        connectionId: "conn-a",
      }),
    );
    const runB = collect(
      fixture.service.sendMessage({
        conversation: conversationB,
        userMessage: "wait in the queue",
        connectionId: "conn-b",
      }),
    );
    await waitFor(
      () => fixture.provider.toolRequests.length === 1,
      "first turn did not occupy the scheduler slot",
    );

    fixture.service.abortConnection("conn-b");
    const eventsB = await runB;

    expect(eventsB.some((event) => event.type === "turn:aborted")).toBe(true);
    expect(fixture.provider.toolRequests).toHaveLength(1);
    park.release();
    const eventsA = await runA;
    expect(eventsA.some((event) => event.type === "turn:complete")).toBe(true);
  });

  test("abortConnection leaves another connection's turn running", async () => {
    const park = createGate();
    const fixture = makeService(
      [
        { finalContent: "done", park: park.promise },
        { finalContent: "done", park: park.promise },
      ],
      { scheduler: new ReasoningScheduler({ maxConcurrent: 2 }) },
    );
    const conversationA = await fixture.service.startConversation({
      topic: "A",
      clientIdentity: "human",
    });
    const conversationB = await fixture.service.startConversation({
      topic: "B",
      clientIdentity: "claude-code",
    });
    const runA = collect(
      fixture.service.sendMessage({
        conversation: conversationA,
        userMessage: "hi from A",
        connectionId: "conn-a",
      }),
    );
    const runB = collect(
      fixture.service.sendMessage({
        conversation: conversationB,
        userMessage: "hi from B",
        connectionId: "conn-b",
      }),
    );
    await waitFor(
      () => fixture.provider.toolRequests.length === 2,
      "concurrent turns did not reach the provider",
    );

    fixture.service.abortConnection("conn-a");
    const eventsA = await runA;
    park.release();
    const eventsB = await runB;

    expect(eventsA.some((event) => event.type === "turn:aborted")).toBe(true);
    expect(eventsB.some((event) => event.type === "turn:aborted")).toBe(false);
    expect(eventsB.some((event) => event.type === "turn:complete")).toBe(true);
  });

  test("abortAllConnections explicitly stops every turn", async () => {
    const park = createGate();
    const fixture = makeService(
      [
        { finalContent: "done", park: park.promise },
        { finalContent: "done", park: park.promise },
      ],
      { scheduler: new ReasoningScheduler({ maxConcurrent: 2 }) },
    );
    const conversationA = await fixture.service.startConversation({
      topic: "A",
      clientIdentity: "human",
    });
    const conversationB = await fixture.service.startConversation({
      topic: "B",
      clientIdentity: "claude-code",
    });
    const runA = collect(
      fixture.service.sendMessage({
        conversation: conversationA,
        userMessage: "hi from A",
        connectionId: "conn-a",
      }),
    );
    const runB = collect(
      fixture.service.sendMessage({
        conversation: conversationB,
        userMessage: "hi from B",
        connectionId: "conn-b",
      }),
    );
    await waitFor(
      () => fixture.provider.toolRequests.length === 2,
      "concurrent turns did not reach the provider",
    );

    fixture.service.abortAllConnections();
    const eventsA = await runA;
    const eventsB = await runB;
    park.release();

    expect(eventsA.some((event) => event.type === "turn:aborted")).toBe(true);
    expect(eventsB.some((event) => event.type === "turn:aborted")).toBe(true);
  });
});

describe("ChatService", () => {
  test("startConversation writes a fresh markdown file", async () => {
    const fixture = makeService([{ finalContent: "ok" }]);
    const conversation = await fixture.service.startConversation({
      topic: "Daily review",
      clientIdentity: "human",
    });
    expect(conversation.notePath).toContain("Notient/conversations/");
    expect(fixture.storeFacade.files.has(conversation.notePath)).toBe(true);
    const raw = fixture.storeFacade.files.get(conversation.notePath) ?? "";
    expect(raw).toContain('topic: "Daily review"');
    expect(raw).toContain("approval_mode: yolo");
  });

  test("sendMessage runs the loop and persists the conversation", async () => {
    const fixture = makeService([{ finalContent: "Hello back." }]);
    const conversation = await fixture.service.startConversation({
      topic: "Smoke",
      clientIdentity: "human",
    });
    const events = await collect(
      fixture.service.sendMessage({
        conversation,
        userMessage: "Hi there",
        connectionId: "test",
      }),
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

  test("a denied write reason survives the stream, transcript, and reload", async () => {
    const fixture = makeService([
      {
        toolCalls: [{ id: "call-denied", name: "notes.test_write", args: { path: "x.md" } }],
      },
      { finalContent: "I left the note unchanged." },
    ]);
    fixture.toolRegistry.register({
      name: "notes.test_write",
      description: "Test-only approval-gated write",
      schema: { type: "object", properties: {}, required: [] },
      writeGated: true,
      validate: () => ({}),
      invoke: async (_args, signal, invokeContext) => {
        const decision = await fixture.approvalGate.request(
          { id: "call-denied", name: "notes.test_write", args: { path: "x.md" } },
          "safe",
          "Write x.md",
          signal,
          invokeContext,
        );
        return decision.approved ? { applied: true } : { applied: false, reason: decision.reason };
      },
    });
    const conversation = await fixture.service.startConversation({
      topic: "Denied write",
      clientIdentity: "human",
    });

    const running = collect(
      fixture.service.sendMessage({
        conversation,
        userMessage: "Change x.md",
        connectionId: "test",
      }),
    );
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (fixture.approvalGate.listPending().some((entry) => entry.callId === "call-denied")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(fixture.approvalGate.listPending().map((entry) => entry.callId)).toContain(
      "call-denied",
    );
    expect(
      fixture.approvalGate.resolve("call-denied", {
        approved: false,
        reason: "unsafe target",
      }),
    ).toBe(true);

    const events = await running;
    const streamed = events.find((event) => event.type === "loop:tool-result");
    expect(streamed && streamed.type === "loop:tool-result" ? streamed.result.data : null).toEqual({
      applied: false,
      reason: "unsafe target",
    });
    const complete = events.find((event) => event.type === "turn:complete");
    if (complete === undefined || complete.type !== "turn:complete") {
      throw new Error("denied write turn did not complete");
    }

    const raw = fixture.storeFacade.files.get(complete.conversation.notePath) ?? "";
    expect(raw).toContain('> data: {"applied":false,"reason":"unsafe target"}');
    const reloaded = await fixture.service.loadConversation(complete.conversation.notePath);
    const persistedResult = reloaded.messages
      .flatMap((message) => message.toolResults ?? [])
      .find((result) => result.callId === "call-denied");
    expect(persistedResult?.data).toEqual({
      applied: false,
      reason: "unsafe target",
    });
  });

  test("listConversations delegates to the store", async () => {
    const fixture = makeService([{ finalContent: "ok" }]);
    await fixture.service.startConversation({ topic: "First", clientIdentity: "human" });
    await fixture.service.startConversation({ topic: "Second", clientIdentity: "human" });
    const conversations = await fixture.service.listConversations();
    expect(conversations.length).toBe(2);
    expect(conversations.map((entry) => entry.topic).sort()).toEqual(["First", "Second"]);
  });

  test("resolved attachment context reaches one turn but is not persisted as a pinned note path", async () => {
    const fixture = makeService([{ finalContent: "used the attachment" }]);
    const conversation = await fixture.service.startConversation({
      topic: "Ephemeral attachment",
      clientIdentity: "human",
    });
    const attachment = "[attachment: Notes/Evidence.md]\nResolved body for this turn only.";

    const events = await collect(
      fixture.service.sendMessage({
        conversation,
        userMessage: "use the evidence",
        connectionId: "test",
        ephemeralContext: [attachment],
      }),
    );

    expect(fixture.provider.toolRequests[0]?.messages[0]?.content).toContain(attachment);
    const complete = events.find((event) => event.type === "turn:complete");
    if (complete === undefined || complete.type !== "turn:complete") {
      throw new Error("attachment turn did not complete");
    }
    expect(complete.conversation.pinnedContext).toEqual([]);
    expect(
      (await fixture.service.loadConversation(complete.conversation.notePath)).pinnedContext,
    ).toEqual([]);
  });

  test("cross-session memory is injected when prior conversation matches", async () => {
    const sharedVector = new Float32Array([1, 0, 0, 0]);
    const conversationIndex = new InMemoryConversationMemory();
    const priorConversation: Conversation = {
      id: "conv-prior",
      notePath: "Notient/conversations/2026-04-20 prior.md",
      model: "Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M",
      pinnedContext: [],
      approvalMode: "safe",
      topic: "Project planning",
      summary: "discussed Q2 goals",
      clientIdentity: "human",
      messageCount: 0,
      createdAt: 0,
      updatedAt: 1,
      messages: [],
    };
    await conversationIndex.record(priorConversation, sharedVector);

    const provider = new ScriptedProvider([{ finalContent: "noted." }], "fresh summary");
    const storeFacade = new FakeStoreFacade();
    const store = new ConversationStore({
      facade: storeFacade,
      folder: "Notient/conversations",
      now: () => 1745625600000,
    });
    const toolRegistry = new ToolRegistry();
    const scheduler = new ReasoningScheduler({ maxConcurrent: 1 });
    const bus = new EventBus();
    const toolModeCache = makeToolModeCache({
      "Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M": "native",
    });
    const contextManager = new ContextManager({
      db: makeSurreal() as unknown as ConstructorParameters<typeof ContextManager>[0]["db"],
      provider,
      conversationIndex,
      embed: async () => sharedVector,
      contextSettings: () => ({
        includeVaultSnapshot: false,
        includeCrossSessionMemory: true,
        crossSessionTopK: 2,
        crossSessionSimThreshold: 0.5,
        pinnedNoteMaxTokens: 4000,
        contextBudgetFraction: 0.7,
        modelContextTokens: 8192,
      }),
      engagedNotePath: () => null,
      facade: { readNote: async () => "" },
      approvalMode: () => "safe",
      toolCatalog: () => [],
      estimateTokens: (text) => Math.ceil(text.length / 4),
      summaryModel: "Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M",
      bus,
    });
    const service = new ChatService({
      provider,
      contextManager,
      conversationStore: store,
      conversationIndex,
      toolRegistry,
      scheduler,
      toolModeCache,
      embed: async () => sharedVector,
      settings: () => defaultRuntimeSettings(),
      bus,
      generateId: (() => {
        let counter = 0;
        return () => `id-${counter++}`;
      })(),
      now: () => 1745625600000,
    });
    const conversation = await service.startConversation({
      topic: "Followup",
      clientIdentity: "human",
    });
    await collect(
      service.sendMessage({
        conversation,
        userMessage: "what was decided?",
        connectionId: "test",
      }),
    );
    const sentSystem = provider.toolRequests[0].messages[0];
    expect(sentSystem.role).toBe("system");
    expect(sentSystem.content).toContain("Earlier conversations");
    expect(sentSystem.content).toContain("Project planning");
  });

  test("a changed summary with no embedding deletes stale memory before saving Markdown", async () => {
    const fixture = makeService([{ finalContent: "new turn" }], {
      summaryText: "fresh canonical summary",
      embed: async () => null,
    });
    const created = await fixture.service.startConversation({
      topic: "Memory integrity",
      clientIdentity: "human",
    });
    const withOldSummary = await fixture.store.save(created, {
      ...created,
      summary: "old canonical summary",
    });
    await fixture.conversationIndex.record(withOldSummary, new Float32Array([1, 0, 0, 0]));

    await collect(
      fixture.service.sendMessage({
        conversation: withOldSummary,
        userMessage: "What changed?",
        connectionId: "test",
      }),
    );
    await fixture.service.drain();

    expect(fixture.conversationIndex.removals).toContain(withOldSummary.id);
    expect(await fixture.conversationIndex.list()).toEqual([]);
    const reloaded = await fixture.service.loadConversation(withOldSummary.notePath);
    expect(reloaded.summary).toBe("fresh canonical summary");
    expect(fixture.storeFacade.files.get(withOldSummary.notePath)).not.toContain(
      "summary_embedding",
    );
  });

  test("turn:complete fires before the post-turn summary chatJson resolves", async () => {
    // Without this, the daemon stays in the chat-priority scheduler slot during
    // the summary refresh and the TUI's `busy` flag stays true, dropping the
    // user's next keystrokes. Multi-turn conversations break under that race.
    const fixture = makeService([{ finalContent: "first reply" }]);
    const summaryGate = createGate();
    const originalChatJson = fixture.provider.chatJson.bind(fixture.provider);
    fixture.provider.chatJson = (async <T>(
      messages: Parameters<typeof originalChatJson>[0],
      options: Parameters<typeof originalChatJson>[1],
      schema: Parameters<typeof originalChatJson>[2],
    ): Promise<T> => {
      await summaryGate.promise;
      return originalChatJson<T>(messages, options, schema);
    }) as typeof fixture.provider.chatJson;
    const conversation = await fixture.service.startConversation({
      topic: "Race",
      clientIdentity: "human",
    });
    const generator = fixture.service.sendMessage({
      conversation,
      userMessage: "Hi",
      connectionId: "test",
    });
    let sawTurnComplete = false;
    const drain = (async () => {
      for await (const event of generator) {
        if (event.type === "turn:complete") {
          sawTurnComplete = true;
          break;
        }
      }
    })();
    // Park briefly so the runtime can flush events but never let the gated
    // summary call resolve. If the implementation blocks on chatJson before
    // emitting turn:complete, sawTurnComplete stays false.
    await Promise.race([drain, new Promise((resolve) => setTimeout(resolve, 50))]);
    expect(sawTurnComplete).toBe(true);
    summaryGate.release();
    await drain;
  });

  test("post-turn summary consumes the shared reasoning scheduler", async () => {
    const fixture = makeService([{ finalContent: "first reply" }]);
    const summaryGate = createGate();
    const originalChatJson = fixture.provider.chatJson.bind(fixture.provider);
    fixture.provider.chatJson = (async <T>(
      messages: Parameters<typeof originalChatJson>[0],
      options: Parameters<typeof originalChatJson>[1],
      schema: Parameters<typeof originalChatJson>[2],
    ): Promise<T> => {
      await summaryGate.promise;
      return originalChatJson<T>(messages, options, schema);
    }) as typeof fixture.provider.chatJson;
    const conversation = await fixture.service.startConversation({
      topic: "Scheduled summary",
      clientIdentity: "human",
    });

    const events = await collect(
      fixture.service.sendMessage({
        conversation,
        userMessage: "Hi",
        connectionId: "test",
      }),
    );
    expect(events.some((event) => event.type === "turn:complete")).toBe(true);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (fixture.scheduler.currentLabel() === "chat:summary") break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(fixture.scheduler.currentLabel()).toBe("chat:summary");

    summaryGate.release();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!fixture.scheduler.isBusy()) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(fixture.scheduler.isBusy()).toBe(false);
  });

  test("two consecutive sendMessage calls preserve history and persist combined messages", async () => {
    const fixture = makeService([
      { finalContent: "Turn 1 reply." },
      { finalContent: "Turn 2 reply, building on prior." },
    ]);
    const conversation = await fixture.service.startConversation({
      topic: "Multi-turn",
      clientIdentity: "human",
    });
    const eventsTurn1 = await collect(
      fixture.service.sendMessage({
        conversation,
        userMessage: "First",
        connectionId: "test",
      }),
    );
    const completeTurn1 = eventsTurn1.find((event) => event.type === "turn:complete");
    if (!completeTurn1 || completeTurn1.type !== "turn:complete") {
      throw new Error("turn 1 did not yield turn:complete");
    }
    const afterTurn1 = completeTurn1.conversation;
    expect(afterTurn1.messages.length).toBe(2);
    expect(afterTurn1.messages[0].content).toBe("First");
    expect(afterTurn1.messages[1].content).toBe("Turn 1 reply.");

    const eventsTurn2 = await collect(
      fixture.service.sendMessage({
        conversation: afterTurn1,
        userMessage: "Second",
        connectionId: "test",
      }),
    );
    const completeTurn2 = eventsTurn2.find((event) => event.type === "turn:complete");
    if (!completeTurn2 || completeTurn2.type !== "turn:complete") {
      throw new Error("turn 2 did not yield turn:complete");
    }
    const afterTurn2 = completeTurn2.conversation;
    expect(afterTurn2.messages.length).toBe(4);
    expect(afterTurn2.messages.map((message) => message.content)).toEqual([
      "First",
      "Turn 1 reply.",
      "Second",
      "Turn 2 reply, building on prior.",
    ]);

    const turn2Request = fixture.provider.toolRequests[1];
    const replayedUser = turn2Request.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content);
    expect(replayedUser).toEqual(["First", "Second"]);
  });
});

test("HTTP provider generations, nested domain analysis and memory share one chat allowance", async () => {
  const body = "# Storage\n\nDurable writes require three replicas.";
  const source = { path: "Storage.md", revision: contentRevision(body) };
  const requests: Record<string, unknown>[] = [];
  const usage = {
    prompt_tokens: 10,
    completion_tokens: 100,
    total_tokens: 110,
    completion_tokens_details: { reasoning_tokens: 60 },
  };
  let overrun = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const input = (await request.json()) as {
        stream?: boolean;
        response_format?: { json_schema: { name: string } };
        messages: Array<{ role: string }>;
      };
      requests.push(input);
      if (!input.stream)
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: {
                    text: "The saved storage policy requires durable replicas.",
                    evidence: [{ note: 0, quote: "Durable writes require three replicas." }],
                  },
                  findings: [],
                  abstention: null,
                }),
              },
              finish_reason: "stop",
            },
          ],
          usage,
        });
      const first = !input.messages.some((message) => message.role === "tool");
      const delta = first
        ? {
            tool_calls: [
              {
                index: 0,
                id: "call-brief",
                type: "function",
                function: {
                  name: overrun ? "notes.effect" : "brief.run",
                  arguments: JSON.stringify(overrun ? {} : { source, scope: {}, limit: 1 }),
                },
              },
            ],
          }
        : { content: "Storage requires three durable replicas." };
      const frames = [
        { choices: [{ index: 0, delta }] },
        { choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }] },
        { choices: [], usage: overrun ? { ...usage, total_tokens: 200000 } : usage },
      ];
      return new Response(
        `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  try {
    const provider = new LMStudioProvider({ baseUrl: `http://127.0.0.1:${server.port}/v1` });
    const fixture = makeService([], {
      wireProvider: provider,
      settings: () =>
        defaultRuntimeSettings({
          budget: { modelCalls: 3, tokens: 30000, durationMs: 5000, generationTokens: 1024 },
        }),
    });
    const analysis = new NoteAnalysis({
      vault: { read: async () => body } as unknown as VaultAdapter,
      search: {
        retrieve: async () => ({ hits: [], coverage: currentCoverageFixture() }),
      } as unknown as SearchPipeline,
      provider,
      scheduler: fixture.scheduler,
      settings: () => ({ model: "test", contextTokens: 32768 }),
      indexing: currentIndexingFixture,
    });
    for (const tool of makeAnalysisTools(analysis)) fixture.toolRegistry.register(tool);
    const memory: Array<{ attempts: unknown[]; state: string }> = [];
    fixture.bus.on("chat:usage", (event) => {
      if (event.phase === "memory") memory.push(event);
    });
    const conversation = await fixture.service.startConversation({
      topic: "Storage",
      clientIdentity: "human",
    });
    const events = await collect(
      fixture.service.sendMessage({
        conversation,
        userMessage: "Brief me on Storage",
        connectionId: "budget-check",
      }),
    );
    expect(events.some((event) => event.type === "turn:complete")).toBe(true);
    const accounting = events.find((event) => event.type === "turn:usage");
    if (!accounting || accounting.type !== "turn:usage") throw new Error("missing accounting");
    expect(accounting.attempts).toHaveLength(3);
    expect(accounting.attempts.map((attempt) => attempt.chargedTokens)).toEqual([110, 110, 110]);
    expect(accounting.attempts.every((attempt) => attempt.generationCeiling === 1024)).toBe(true);
    expect(accounting.attempts[1].completion?.usage).toMatchObject({
      completionTokens: 100,
      reasoningTokens: 60,
      visibleAnswerTokens: null,
      totalTokens: 110,
    });
    for (let i = 0; i < 100 && !memory.length; i++) await Bun.sleep(5);
    expect(memory[0]).toMatchObject({ state: "incomplete" });
    expect(memory[0].attempts).toHaveLength(3);
    expect(requests).toHaveLength(3); // No extra generation allowance for post-turn memory.

    overrun = true;
    let applied = false;
    fixture.toolRegistry.register({
      name: "notes.effect",
      description: "Test-only effect sentinel",
      schema: { type: "object", properties: {}, required: [] },
      validate: (value) => value,
      writeGated: true,
      invoke: async () => {
        applied = true;
        return {};
      },
    });
    const stopped = await collect(
      fixture.service.sendMessage({
        conversation,
        userMessage: "Try an effect",
        connectionId: "overrun-check",
      }),
    );
    expect(applied).toBe(false);
    expect(
      stopped.some(
        (event) => event.type === "turn:aborted" && event.reason.includes("token budget"),
      ),
    ).toBe(true);
    expect(stopped.some((event) => event.type === "turn:complete")).toBe(false);
    const overrunUsage = stopped.find((event) => event.type === "turn:usage");
    expect(overrunUsage?.type === "turn:usage" && overrunUsage.attempts[0].chargedTokens).toBe(
      200000,
    );
  } finally {
    server.stop(true);
  }
});

test("a failed capability probe does not mark a healthy model disabled on the next turn", async () => {
  const fixture = makeService(
    [
      { toolCalls: [{ id: "probe", name: "echo", args: { value: "ping" } }] },
      { finalContent: "Recovered after the provider outage." },
    ],
    { toolModeCache: makeToolModeCache({}) },
  );
  const original = fixture.provider.chatWithTools.bind(fixture.provider);
  let fail = true;
  fixture.provider.chatWithTools = async (request) => {
    if (fail) {
      fail = false;
      throw new Error("provider temporarily offline");
    }
    return original(request);
  };
  const conversation = await fixture.service.startConversation({
    topic: "Recovery",
    clientIdentity: "human",
  });
  const first = await collect(
    fixture.service.sendMessage({ conversation, userMessage: "Hello", connectionId: "recovery" }),
  );
  expect(first.some((event) => event.type === "turn:aborted")).toBe(true);
  expect(fixture.toolModeCache.read(conversation.model)).toBeNull();
  const second = await collect(
    fixture.service.sendMessage({
      conversation,
      userMessage: "Try again",
      connectionId: "recovery",
    }),
  );
  expect(second.some((event) => event.type === "turn:complete")).toBe(true);
  expect(fixture.toolModeCache.read(conversation.model)).toBe("native");
});
