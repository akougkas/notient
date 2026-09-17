import { describe, expect, test } from "bun:test";
import type { VaultAdapter } from "../../../../src/adapters/vaultAdapter";
import { ApprovalGate } from "../../../../src/core/chat/approvalGate";
import type { ChatService } from "../../../../src/core/chat/chatService";
import {
  ConversationStore,
  type ConversationStoreFacade,
} from "../../../../src/core/chat/conversationStore";
import type { Conversation } from "../../../../src/core/chat/types";
import { EventBus } from "../../../../src/core/events/eventBus";
import { makeChatHandlers } from "../../../../src/daemon/handlers/chat";
import type { RpcRequestContext } from "../../../../src/daemon/rpc";
import { agentPrincipal, humanPrincipal, rpcRequest } from "../../../rpcRequest";

function chatRequest(
  params: Record<string, unknown>,
  identity = "human",
  overrides: Partial<Omit<RpcRequestContext, "params" | "principal">> = {},
): RpcRequestContext {
  const principal = identity === "human" ? humanPrincipal() : agentPrincipal(identity);
  return rpcRequest(params, { principal, ...overrides });
}

function makeConversation(id = "conv-1", clientIdentity = "human"): Conversation {
  return {
    id,
    notePath: `Notient/conversations/${id}.md`,
    model: "test-model",
    pinnedContext: [],
    approvalMode: "yolo",
    topic: "test",
    summary: "",
    clientIdentity,
    messageCount: 0,
    createdAt: 0,
    updatedAt: 0,
    messages: [],
  };
}

function makeChatService(events: unknown[]): ChatService {
  return {
    startConversation: async () => makeConversation(),
    listConversations: async () => [makeConversation()],
    loadConversation: async () => makeConversation(),
    sendMessage: async function* () {
      for (const event of events) yield event as never;
    },
    abort: () => {},
  } as unknown as ChatService;
}

const STUB_VAULT: VaultAdapter = {
  isIndexablePath: () => true,
  listMarkdown: async () => [],
  read: async () => "",
  readBounded: async () => "",
  write: async () => {},
  createIfAbsent: async () => true,
  writeIfUnchanged: async () => true,
  updateFrontmatter: async () => {},
  remove: async () => {},
  removeIfUnchanged: async () => true,
  exists: async () => false,
  createFolder: async () => {},
  list: async () => ({ files: [], folders: [] }),
  readBinary: async () => null,
  writeBinary: async () => {},
  rename: async () => {},
};

function makeGate(): ApprovalGate {
  return new ApprovalGate({
    recordHistoryAutoApprove: async () => {},
    perToolPolicy: () => ({}),
    sessionGrants: { claim: async () => null },
  });
}

async function advanceGrantLookup(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("chat.send handler", () => {
  test("forwards turn:start, loop deltas, and turn:complete with bridged names", async () => {
    const conversation = makeConversation();
    const service = makeChatService([
      {
        type: "turn:start",
        conversationId: conversation.id,
        userMessage: { role: "user", content: "hi" },
      },
      { type: "loop:assistant-token", delta: "hello" },
      {
        type: "loop:tool-call",
        call: { id: "tc1", name: "vault.search_notes", args: {} },
      },
      {
        type: "loop:tool-result",
        result: {
          callId: "tc1",
          status: "ok",
          data: { hits: [] },
          durationMs: 12,
        },
      },
      {
        type: "loop:done",
        finalMessage: { role: "assistant", content: "hello" },
        toolMessages: [],
      },
      { type: "turn:complete", conversation },
    ]);
    const handlers = makeChatHandlers({
      chatService: service,
      approvalGate: makeGate(),
      vault: STUB_VAULT,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
      bus: new EventBus(),
    });
    const lines: string[] = [];
    const result = await handlers.send(
      chatRequest({ conversationId: conversation.id, userMessage: "hi" }, "human", {
        emit: (line) => lines.push(line),
      }),
    );
    const events = lines.map((line) => JSON.parse(line));
    const types = events.map((event) => event.event);
    expect(types).toContain("turn:start");
    expect(types).toContain("loop:assistant_delta");
    expect(types).toContain("loop:tool_call_started");
    expect(types).toContain("loop:tool_call_result");
    expect(types).toContain("loop:done");
    expect(types).toContain("turn:complete");
    expect(result.ok).toBe(true);
  });

  test("forwards loop:tool_call_error when result.status === error", async () => {
    const conversation = makeConversation();
    const service = makeChatService([
      {
        type: "turn:start",
        conversationId: conversation.id,
        userMessage: { role: "user", content: "hi" },
      },
      {
        type: "loop:tool-result",
        result: {
          callId: "tc1",
          status: "error",
          error: "boom",
          durationMs: 1,
        },
      },
      { type: "turn:complete", conversation },
    ]);
    const handlers = makeChatHandlers({
      chatService: service,
      approvalGate: makeGate(),
      vault: STUB_VAULT,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
      bus: new EventBus(),
    });
    const lines: string[] = [];
    await handlers.send(
      chatRequest({ conversationId: conversation.id, userMessage: "hi" }, "human", {
        emit: (line) => lines.push(line),
      }),
    );
    const events = lines.map((line) => JSON.parse(line));
    expect(events.some((event) => event.event === "loop:tool_call_error")).toBe(true);
  });

  test("rejects images when vision is unavailable", async () => {
    const conversation = makeConversation();
    const service = makeChatService([{ type: "turn:complete", conversation }]);
    const visualVault: VaultAdapter = {
      ...STUB_VAULT,
      exists: async () => true,
      readBinary: async () => new Uint8Array().buffer,
    };
    const handlers = makeChatHandlers({
      chatService: service,
      approvalGate: makeGate(),
      vault: visualVault,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
      bus: new EventBus(),
    });
    let thrown: unknown = null;
    try {
      await handlers.send(
        chatRequest({
          conversationId: conversation.id,
          userMessage: "describe @cat.png",
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("vision is not supported");
  });

  test("emits loop:approval_pending and loop:approval_resolved when gate fires", async () => {
    const conversation = makeConversation();
    const gate = makeGate();

    // Hold the chatService stream open until the test fires the gate. The
    // handler's subscribe() must run before gate.request() so the per-turn
    // listener is wired in time.
    let releaseGate: () => void = () => {};
    const gateReady = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const fakeService: ChatService = {
      startConversation: async () => conversation,
      listConversations: async () => [conversation],
      loadConversation: async () => conversation,
      sendMessage: async function* () {
        yield {
          type: "turn:start",
          conversationId: conversation.id,
          userMessage: { role: "user", content: "hi" },
        } as never;
        await gateReady;
        yield { type: "turn:complete", conversation } as never;
      },
      abort: () => {},
    } as unknown as ChatService;

    const handlers = makeChatHandlers({
      chatService: fakeService,
      approvalGate: gate,
      vault: STUB_VAULT,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
      bus: new EventBus(),
    });

    const lines: string[] = [];
    const sendPromise = handlers.send(
      chatRequest({ conversationId: conversation.id, userMessage: "hi" }, "human", {
        emit: (line) => lines.push(line),
      }),
    );

    // Let the handler subscribe before firing the gate.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const controller = new AbortController();
    const requestPromise = gate.request(
      { id: "tc-approval", name: "notes.create", args: { path: "x.md" } },
      "safe",
      "preview",
      controller.signal,
      { clientIdentity: "human" },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const resolved = await handlers.approve(
      chatRequest({
        callId: "tc-approval",
        approved: false,
        reason: "  unsafe target  ",
      }),
    );
    expect(resolved).toEqual({
      ok: true,
      callId: "tc-approval",
      approved: false,
      reason: "unsafe target",
    });
    await expect(requestPromise).resolves.toEqual({
      approved: false,
      reason: "unsafe target",
    });
    releaseGate();
    await sendPromise;

    const events = lines.map((line) => JSON.parse(line));
    expect(events.some((event) => event.event === "loop:approval_pending")).toBe(true);
    expect(events.find((event) => event.event === "loop:approval_resolved")).toMatchObject({
      callId: "tc-approval",
      approved: false,
      reason: "unsafe target",
    });
  });

  test("an agent stream sees only its own principal's pending approvals", async () => {
    const conversation = makeConversation("conv-1", "claude-code");
    const gate = makeGate();
    let releaseGate: () => void = () => {};
    const gateReady = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const fakeService: ChatService = {
      startConversation: async () => conversation,
      listConversations: async () => [conversation],
      loadConversation: async () => conversation,
      sendMessage: async function* () {
        yield {
          type: "turn:start",
          conversationId: conversation.id,
          userMessage: { role: "user", content: "hi" },
        } as never;
        await gateReady;
        yield { type: "turn:complete", conversation } as never;
      },
      abort: () => {},
    } as unknown as ChatService;
    const handlers = makeChatHandlers({
      chatService: fakeService,
      approvalGate: gate,
      vault: STUB_VAULT,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
      bus: new EventBus(),
    });

    const claude = {
      principal: {
        id: "claude-code",
        kind: "agent" as const,
        scopes: ["read", "write"],
      },
      connectionId: "conn-claude",
    };
    const codex = {
      principal: {
        id: "codex",
        kind: "agent" as const,
        scopes: ["read", "write"],
      },
      connectionId: "conn-codex",
    };

    const lines: string[] = [];
    const sendPromise = handlers.send(
      rpcRequest(
        { conversationId: conversation.id, userMessage: "hi" },
        { ...claude, emit: (line) => lines.push(line) },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const controller = new AbortController();
    const mine = gate.request(
      { id: "tc-mine", name: "notes.write", args: { path: "mine.md" } },
      "safe",
      "my preview",
      controller.signal,
      { clientIdentity: "claude-code" },
    );
    const theirs = gate.request(
      {
        id: "tc-theirs",
        name: "notes.write",
        args: { path: "secret.md", body: "their data" },
      },
      "safe",
      "their preview",
      controller.signal,
      { clientIdentity: "codex" },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const pendingIds = lines
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === "loop:approval_pending")
      .map((event) => event.callId);
    expect(pendingIds).toEqual(["tc-mine"]);

    // Visibility never grants an agent authority to approve its own writes.
    await expect(
      handlers.approve(
        rpcRequest({ callId: "tc-theirs", approved: true }, { ...codex, requestId: "req-approve" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await handlers.approve(rpcRequest({ callId: "tc-theirs", approved: true }));
    gate.resolve(
      "tc-mine",
      { approved: true },
      { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
    );
    await Promise.all([mine, theirs]);
    releaseGate();
    await sendPromise;
  });

  test("a human stream still sees every principal's pending approvals", async () => {
    const conversation = makeConversation();
    const gate = makeGate();
    let releaseGate: () => void = () => {};
    const gateReady = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const fakeService: ChatService = {
      startConversation: async () => conversation,
      listConversations: async () => [conversation],
      loadConversation: async () => conversation,
      sendMessage: async function* () {
        yield {
          type: "turn:start",
          conversationId: conversation.id,
          userMessage: { role: "user", content: "hi" },
        } as never;
        await gateReady;
        yield { type: "turn:complete", conversation } as never;
      },
      abort: () => {},
    } as unknown as ChatService;
    const handlers = makeChatHandlers({
      chatService: fakeService,
      approvalGate: gate,
      vault: STUB_VAULT,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
      bus: new EventBus(),
    });
    const human = {
      principal: {
        id: "human",
        kind: "human" as const,
        scopes: ["read", "write", "admin"],
      },
      connectionId: "conn-human",
    };
    const lines: string[] = [];
    const sendPromise = handlers.send(
      rpcRequest(
        { conversationId: conversation.id, userMessage: "hi" },
        { ...human, emit: (line) => lines.push(line) },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const controller = new AbortController();
    const theirs = gate.request(
      { id: "tc-agent", name: "notes.write", args: { path: "a.md" } },
      "safe",
      "preview",
      controller.signal,
      { clientIdentity: "codex" },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pendingIds = lines
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === "loop:approval_pending")
      .map((event) => event.callId);
    expect(pendingIds).toEqual(["tc-agent"]);
    gate.resolve(
      "tc-agent",
      { approved: true },
      { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
    );
    await theirs;
    releaseGate();
    await sendPromise;
  });

  test("forwards loop:context_summarized scoped to the conversation", async () => {
    const conversation = makeConversation();
    const bus = new EventBus();

    let releaseStream: () => void = () => {};
    const streamReady = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });

    const fakeService: ChatService = {
      startConversation: async () => conversation,
      listConversations: async () => [conversation],
      loadConversation: async () => conversation,
      sendMessage: async function* () {
        yield {
          type: "turn:start",
          conversationId: conversation.id,
          userMessage: { role: "user", content: "hi" },
        } as never;
        await streamReady;
        yield { type: "turn:complete", conversation } as never;
      },
      abort: () => {},
    } as unknown as ChatService;

    const handlers = makeChatHandlers({
      chatService: fakeService,
      approvalGate: makeGate(),
      vault: STUB_VAULT,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
      bus,
    });

    const lines: string[] = [];
    const sendPromise = handlers.send(
      chatRequest({ conversationId: conversation.id, userMessage: "hi" }, "human", {
        emit: (line) => lines.push(line),
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    bus.emit({
      type: "loop:context_summarized",
      conversationId: conversation.id,
      model: "test-model",
      originalTokens: 100,
      summarizedTokens: 50,
    });
    bus.emit({
      type: "loop:context_summarized",
      conversationId: "other-conversation",
      model: "test-model",
      originalTokens: 200,
      summarizedTokens: 25,
    });
    releaseStream();
    await sendPromise;

    const events = lines.map((line) => JSON.parse(line));
    const summarized = events.filter((event) => event.event === "loop:context_summarized");
    expect(summarized).toHaveLength(1);
    expect(summarized[0].conversationId).toBe(conversation.id);
    expect(summarized[0].model).toBe("test-model");
    expect(summarized[0].originalTokens).toBe(100);
    expect(summarized[0].summarizedTokens).toBe(50);
  });

  test("forwards loop:context_overflow_warning scoped to the conversation", async () => {
    const conversation = makeConversation();
    const bus = new EventBus();

    let releaseStream: () => void = () => {};
    const streamReady = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });

    const fakeService: ChatService = {
      startConversation: async () => conversation,
      listConversations: async () => [conversation],
      loadConversation: async () => conversation,
      sendMessage: async function* () {
        yield {
          type: "turn:start",
          conversationId: conversation.id,
          userMessage: { role: "user", content: "hi" },
        } as never;
        await streamReady;
        yield { type: "turn:complete", conversation } as never;
      },
      abort: () => {},
    } as unknown as ChatService;

    const handlers = makeChatHandlers({
      chatService: fakeService,
      approvalGate: makeGate(),
      vault: STUB_VAULT,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
      bus,
    });

    const lines: string[] = [];
    const sendPromise = handlers.send(
      chatRequest({ conversationId: conversation.id, userMessage: "hi" }, "human", {
        emit: (line) => lines.push(line),
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    bus.emit({
      type: "loop:context_overflow_warning",
      conversationId: conversation.id,
      model: "test-model",
      configuredTokens: 4096,
      estimatedTokens: 5000,
    });
    bus.emit({
      type: "loop:context_overflow_warning",
      conversationId: "other-conversation",
      model: "test-model",
      configuredTokens: 4096,
      estimatedTokens: 9000,
    });
    releaseStream();
    await sendPromise;

    const events = lines.map((line) => JSON.parse(line));
    const overflow = events.filter((event) => event.event === "loop:context_overflow_warning");
    expect(overflow).toHaveLength(1);
    expect(overflow[0].conversationId).toBe(conversation.id);
    expect(overflow[0].model).toBe("test-model");
    expect(overflow[0].configuredTokens).toBe(4096);
    expect(overflow[0].estimatedTokens).toBe(5000);
  });

  test("forwards loop:tool_mode_probed broadcast (no conversation filter)", async () => {
    const conversation = makeConversation();
    const bus = new EventBus();

    let releaseStream: () => void = () => {};
    const streamReady = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });

    const fakeService: ChatService = {
      startConversation: async () => conversation,
      listConversations: async () => [conversation],
      loadConversation: async () => conversation,
      sendMessage: async function* () {
        yield {
          type: "turn:start",
          conversationId: conversation.id,
          userMessage: { role: "user", content: "hi" },
        } as never;
        await streamReady;
        yield { type: "turn:complete", conversation } as never;
      },
      abort: () => {},
    } as unknown as ChatService;

    const handlers = makeChatHandlers({
      chatService: fakeService,
      approvalGate: makeGate(),
      vault: STUB_VAULT,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
      bus,
    });

    const lines: string[] = [];
    const sendPromise = handlers.send(
      chatRequest({ conversationId: conversation.id, userMessage: "hi" }, "human", {
        emit: (line) => lines.push(line),
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    bus.emit({
      type: "loop:tool_mode_probed",
      model: "test-model",
      mode: "native",
      attempts: 1,
    });
    releaseStream();
    await sendPromise;

    const events = lines.map((line) => JSON.parse(line));
    const probed = events.filter((event) => event.event === "loop:tool_mode_probed");
    expect(probed).toHaveLength(1);
    expect(probed[0].model).toBe("test-model");
    expect(probed[0].mode).toBe("native");
    expect(probed[0].attempts).toBe(1);
  });
});

describe("chat.approve handler", () => {
  test("errors when the call id is unknown", async () => {
    const handlers = makeChatHandlers({
      chatService: makeChatService([]),
      approvalGate: makeGate(),
      vault: STUB_VAULT,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
      bus: new EventBus(),
    });

    await expect(
      handlers.approve(chatRequest({ callId: "missing", approved: true })),
    ).rejects.toThrow("unknown call id: missing");
  });

  test("resolves a pending call id", async () => {
    const gate = makeGate();
    const handlers = makeChatHandlers({
      chatService: makeChatService([]),
      approvalGate: gate,
      vault: STUB_VAULT,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
      bus: new EventBus(),
    });
    const controller = new AbortController();
    const pending = gate.request(
      { id: "call-1", name: "notes.create", args: { path: "x.md" } },
      "safe",
      "preview",
      controller.signal,
      { clientIdentity: "human" },
    );
    await advanceGrantLookup();

    const result = await handlers.approve(
      chatRequest({ callId: "call-1", approved: false, reason: "  not now  " }),
    );

    expect(result).toEqual({
      ok: true,
      callId: "call-1",
      approved: false,
      reason: "not now",
    });
    await expect(pending).resolves.toEqual({
      approved: false,
      reason: "not now",
    });
  });

  test("supplies one observable reason when a denial omits it", async () => {
    const gate = makeGate();
    const handlers = makeChatHandlers({
      chatService: makeChatService([]),
      approvalGate: gate,
      vault: STUB_VAULT,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
      bus: new EventBus(),
    });
    const pending = gate.request(
      { id: "call-default", name: "notes.create", args: { path: "x.md" } },
      "safe",
      "preview",
      new AbortController().signal,
      { clientIdentity: "human" },
    );
    await advanceGrantLookup();

    const result = await handlers.approve(chatRequest({ callId: "call-default", approved: false }));

    expect(result).toEqual({
      ok: true,
      callId: "call-default",
      approved: false,
      reason: "rejected by user",
    });
    await expect(pending).resolves.toEqual({
      approved: false,
      reason: "rejected by user",
    });
  });

  test("refuses a decorative reason on an approved decision", async () => {
    const handlers = makeChatHandlers({
      chatService: makeChatService([]),
      approvalGate: makeGate(),
      vault: STUB_VAULT,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
      bus: new EventBus(),
    });

    await expect(
      handlers.approve(chatRequest({ callId: "call-1", approved: true, reason: "looks good" })),
    ).rejects.toThrow("reason is valid only when denying");
  });

  test("requires approved to be an explicit boolean", async () => {
    const handlers = makeChatHandlers({
      chatService: makeChatService([]),
      approvalGate: makeGate(),
      vault: STUB_VAULT,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
      bus: new EventBus(),
    });

    await expect(handlers.approve(chatRequest({ callId: "call-1" }))).rejects.toThrow(
      "approved must be a boolean",
    );
  });
});

describe("chat.start handler identity plumbing", () => {
  test("forwards the authenticated principal into ChatService.startConversation", async () => {
    const captured: Array<{ topic: string; clientIdentity: string }> = [];
    const conversation = makeConversation("conv-id-1", "claude-code");
    const service: ChatService = {
      startConversation: async (input: {
        topic: string;
        pinnedContext?: string[];
        clientIdentity: string;
      }) => {
        captured.push({
          topic: input.topic,
          clientIdentity: input.clientIdentity,
        });
        return { ...conversation, topic: input.topic };
      },
      listConversations: async () => [],
      loadConversation: async () => conversation,
      sendMessage: async function* () {
        // Unused in this test; chat.start does not stream.
      },
      abort: () => {},
    } as unknown as ChatService;
    const handlers = makeChatHandlers({
      chatService: service,
      approvalGate: makeGate(),
      vault: STUB_VAULT,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
      bus: new EventBus(),
    });
    await handlers.start(
      chatRequest({ topic: "agent-bridge" }, "claude-code", {
        requestId: "req-claude",
      }),
    );
    await handlers.start(
      chatRequest({ topic: "human-direct" }, "human", {
        requestId: "req-human",
      }),
    );
    expect(captured).toEqual([
      { topic: "agent-bridge", clientIdentity: "claude-code" },
      { topic: "human-direct", clientIdentity: "human" },
    ]);
  });

  test("conversation persisted via ConversationStore stamps client_identity in frontmatter", async () => {
    const facade = new (class implements ConversationStoreFacade {
      readonly files = new Map<string, string>();
      async list(): Promise<string[]> {
        return Array.from(this.files.keys());
      }
      async read(path: string): Promise<string> {
        const value = this.files.get(path);
        if (value === undefined) throw new Error(`not found: ${path}`);
        return value;
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
    })();
    const store = new ConversationStore({
      facade,
      folder: "Notient/conversations",
      now: () => 1745625600000,
    });
    const created = await store.create({
      id: "conv-claude",
      model: "test-model",
      pinnedContext: [],
      approvalMode: "yolo",
      topic: "from claude",
      clientIdentity: "claude-code",
    });
    const raw = facade.files.get(created.notePath) ?? "";
    expect(raw).toContain('client_identity: "claude-code"');
    const reloaded = await store.load(created.notePath);
    expect(reloaded.clientIdentity).toBe("claude-code");

    const humanCreated = await store.create({
      id: "conv-human",
      model: "test-model",
      pinnedContext: [],
      approvalMode: "yolo",
      topic: "from human",
      clientIdentity: "human",
    });
    const humanRaw = facade.files.get(humanCreated.notePath) ?? "";
    expect(humanRaw).toContain('client_identity: "human"');
  });

  test("accepts only ordinary note paths as durable pinned context", async () => {
    const captured: string[][] = [];
    const conversation = makeConversation("pinned", "claude-code");
    const service = makeChatService([]);
    service.startConversation = async (input) => {
      captured.push([...(input.pinnedContext ?? [])]);
      return conversation;
    };
    const handlers = makeChatHandlers({
      chatService: service,
      approvalGate: makeGate(),
      vault: STUB_VAULT,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
      bus: new EventBus(),
    });

    await handlers.start(
      chatRequest({ topic: "owned context", pinnedContext: ["Projects/brief.md"] }, "claude-code"),
    );
    expect(captured).toEqual([["Projects/brief.md"]]);

    for (const pinnedContext of [
      ["Notient/conversations/another-owner.md"],
      ["notient/PROPOSALS/private.md"],
      ["../outside.md"],
      ["Images/photo.png"],
    ]) {
      await expect(
        handlers.start(chatRequest({ topic: "forged", pinnedContext }, "claude-code")),
      ).rejects.toThrow("ordinary Markdown note paths");
    }
    expect(captured).toEqual([["Projects/brief.md"]]);
  });
});

describe("chat authority model", () => {
  const AGENT_CONTEXT = {
    principal: {
      id: "claude-code",
      kind: "agent" as const,
      scopes: ["read", "write"],
    },
    connectionId: "conn-agent",
  };
  const HUMAN_CONTEXT = {
    principal: {
      id: "human",
      kind: "human" as const,
      scopes: ["read", "write", "admin"],
    },
    connectionId: "conn-human",
  };

  interface AbortCalls {
    connections: string[];
    all: number;
  }

  function makeAbortCalls(): AbortCalls {
    return { connections: [], all: 0 };
  }

  function build(abortCalls: AbortCalls, events: unknown[] = []) {
    const service = makeChatService(events);
    service.abortConnection = (connectionId: string) => {
      abortCalls.connections.push(connectionId);
    };
    service.abortAllConnections = () => {
      abortCalls.all++;
    };
    return makeChatHandlers({
      chatService: service,
      approvalGate: makeGate(),
      vault: STUB_VAULT,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
      bus: new EventBus(),
    });
  }

  test("an agent connection with no turn in flight cannot abort", async () => {
    const abortCalls = makeAbortCalls();
    const handlers = build(abortCalls);
    const result = await handlers.abort(rpcRequest({}, AGENT_CONTEXT));
    expect(result).toEqual({ ok: true, aborted: false });
    expect(abortCalls).toEqual({ connections: [], all: 0 });
  });

  test("a human connection with no turn in flight aborts nothing by default", async () => {
    const abortCalls = makeAbortCalls();
    const handlers = build(abortCalls);
    const result = await handlers.abort(rpcRequest({}, HUMAN_CONTEXT));
    expect(result).toEqual({ ok: true, aborted: false });
    expect(abortCalls).toEqual({ connections: [], all: 0 });
  });

  test("a human may abort every connection by asking for it explicitly", async () => {
    const abortCalls = makeAbortCalls();
    const handlers = build(abortCalls);
    const result = await handlers.abort(rpcRequest({ allConnections: true }, HUMAN_CONTEXT));
    expect(result).toEqual({ ok: true, aborted: true, scope: "all" });
    expect(abortCalls).toEqual({ connections: [], all: 1 });
  });

  test("an agent cannot ask for a process-wide abort", async () => {
    const abortCalls = makeAbortCalls();
    const handlers = build(abortCalls);
    expect(handlers.abort(rpcRequest({ allConnections: true }, AGENT_CONTEXT))).rejects.toThrow(
      "human principal",
    );
    expect(abortCalls).toEqual({ connections: [], all: 0 });
  });

  test("an agent connection may abort a turn it owns", async () => {
    const abortCalls = makeAbortCalls();
    const conversation = makeConversation("conv-1", "claude-code");
    let releaseTurn: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const service = makeChatService([]);
    service.listConversations = async () => [conversation];
    service.abortConnection = (connectionId: string) => {
      abortCalls.connections.push(connectionId);
    };
    service.abortAllConnections = () => {
      abortCalls.all++;
    };
    service.sendMessage = async function* () {
      await gate;
      yield { type: "turn:complete", conversation } as never;
    };
    const handlers = makeChatHandlers({
      chatService: service,
      approvalGate: makeGate(),
      vault: STUB_VAULT,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
      bus: new EventBus(),
    });
    const sending = handlers.send(
      rpcRequest(
        { conversationId: conversation.id, userMessage: "hi" },
        { ...AGENT_CONTEXT, requestId: "req-send" },
      ),
    );
    // Let the send handler register its turn before the abort lands.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await handlers.abort(
      rpcRequest({}, { ...AGENT_CONTEXT, requestId: "req-abort" }),
    );
    expect(result).toEqual({ ok: true, aborted: true });
    expect(abortCalls.all).toBe(0);
    // Scoped to the calling connection, so a concurrent turn on another
    // connection keeps running.
    expect(abortCalls.connections).toEqual(["conn-agent"]);
    releaseTurn();
    await sending;

    // Once the turn settles the connection owns nothing again.
    const after = await handlers.abort(
      rpcRequest({}, { ...AGENT_CONTEXT, requestId: "req-abort-2" }),
    );
    expect(after).toEqual({ ok: true, aborted: false });
  });

  test("a different agent connection cannot abort somebody else's turn", async () => {
    const abortCalls = makeAbortCalls();
    const conversation = makeConversation("conv-1", "claude-code");
    let releaseTurn: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const service = makeChatService([]);
    service.listConversations = async () => [conversation];
    service.abortConnection = (connectionId: string) => {
      abortCalls.connections.push(connectionId);
    };
    service.abortAllConnections = () => {
      abortCalls.all++;
    };
    service.sendMessage = async function* () {
      await gate;
      yield { type: "turn:complete", conversation } as never;
    };
    const handlers = makeChatHandlers({
      chatService: service,
      approvalGate: makeGate(),
      vault: STUB_VAULT,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
      bus: new EventBus(),
    });
    const sending = handlers.send(
      rpcRequest(
        { conversationId: conversation.id, userMessage: "hi" },
        { ...AGENT_CONTEXT, requestId: "req-send" },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const other = {
      principal: {
        id: "codex",
        kind: "agent" as const,
        scopes: ["read", "write"],
      },
      connectionId: "conn-other",
    };
    expect(await handlers.abort(rpcRequest({}, { ...other, requestId: "req-abort" }))).toEqual({
      ok: true,
      aborted: false,
    });
    expect(abortCalls).toEqual({ connections: [], all: 0 });
    releaseTurn();
    await sending;
  });

  test("chat.send passes the owning connection into ChatService", async () => {
    const conversation = makeConversation("conv-1", "claude-code");
    const service = makeChatService([{ type: "turn:complete", conversation }]);
    service.listConversations = async () => [conversation];
    const seen: string[] = [];
    const inner = service.sendMessage.bind(service);
    service.sendMessage = (input) => {
      seen.push(input.connectionId);
      return inner(input);
    };
    const handlers = makeChatHandlers({
      chatService: service,
      approvalGate: makeGate(),
      vault: STUB_VAULT,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
      bus: new EventBus(),
    });
    await handlers.send(
      rpcRequest({ conversationId: conversation.id, userMessage: "hi" }, AGENT_CONTEXT),
    );
    expect(seen).toEqual(["conn-agent"]);
  });

  test("chat.send refuses a foreign conversation before attachments, provider work, or mutation", async () => {
    const conversation = makeConversation("conv-1", "human");
    const service = makeChatService([{ type: "turn:complete", conversation }]);
    service.listConversations = async () => [conversation];
    let sends = 0;
    service.sendMessage = async function* () {
      sends++;
      yield* [];
    };
    let vaultTouches = 0;
    const vault: VaultAdapter = {
      ...STUB_VAULT,
      exists: async () => {
        vaultTouches++;
        return true;
      },
      read: async () => {
        vaultTouches++;
        return "secret";
      },
    };
    const handlers = makeChatHandlers({
      chatService: service,
      approvalGate: makeGate(),
      vault,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
      bus: new EventBus(),
    });
    await expect(
      handlers.send(
        rpcRequest(
          {
            conversationId: conversation.id,
            userMessage: "inspect @private.md",
          },
          AGENT_CONTEXT,
        ),
      ),
    ).rejects.toThrow("conversation belongs to another principal");
    expect(conversation.clientIdentity).toBe("human");
    expect(conversation.pinnedContext).toEqual([]);
    expect(vaultTouches).toBe(0);
    expect(sends).toBe(0);
  });

  test("chat.list and chat.load isolate agents while a human can inspect every transcript", async () => {
    const claude = makeConversation("claude", "claude-code");
    const codex = makeConversation("codex", "codex");
    const service = makeChatService([]);
    service.listConversations = async () => [claude, codex];
    service.loadConversation = async (path) => (path === claude.notePath ? claude : codex);
    const handlers = makeChatHandlers({
      chatService: service,
      approvalGate: makeGate(),
      vault: STUB_VAULT,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
      bus: new EventBus(),
    });

    const agentList = await handlers.list(rpcRequest({}, AGENT_CONTEXT));
    const humanList = await handlers.list(rpcRequest({}, HUMAN_CONTEXT));
    expect((agentList.conversations as Conversation[]).map((item) => item.id)).toEqual(["claude"]);
    expect((humanList.conversations as Conversation[]).map((item) => item.id)).toEqual([
      "claude",
      "codex",
    ]);
    await expect(
      handlers.load(rpcRequest({ notePath: codex.notePath }, AGENT_CONTEXT)),
    ).rejects.toThrow("conversation belongs to another principal");
    await expect(
      handlers.load(rpcRequest({ notePath: codex.notePath }, HUMAN_CONTEXT)),
    ).resolves.toMatchObject({ ok: true, conversation: codex });
  });

  test("chat.send fails closed when storage presents a duplicate conversation id", async () => {
    const first = makeConversation("duplicate", "claude-code");
    const second = {
      ...makeConversation("duplicate", "claude-code"),
      notePath: "Notient/conversations/second.md",
    };
    const service = makeChatService([]);
    service.listConversations = async () => [first, second];
    let sends = 0;
    service.sendMessage = async function* () {
      sends++;
      yield* [];
    };
    const handlers = makeChatHandlers({
      chatService: service,
      approvalGate: makeGate(),
      vault: STUB_VAULT,
      visionRouter: null,
      pinnedNoteMaxTokens: 1000,
      bus: new EventBus(),
    });

    await expect(
      handlers.send(
        rpcRequest(
          {
            conversationId: "duplicate",
            userMessage: "do not choose arbitrarily",
          },
          AGENT_CONTEXT,
        ),
      ),
    ).rejects.toThrow("duplicate conversation id");
    expect(sends).toBe(0);
  });
});
