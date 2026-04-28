import { describe, expect, test } from "bun:test";
import type { VaultAdapter } from "../../adapters/vaultAdapter";
import { ApprovalGate } from "../../core/chat/approvalGate";
import type { ChatService } from "../../core/chat/chatService";
import type { Conversation } from "../../core/chat/types";
import { EventBus } from "../../core/events/eventBus";
import { makeChatHandlers } from "./chat";

function makeConversation(id = "conv-1"): Conversation {
  return {
    id,
    notePath: `Notient/conversations/${id}.md`,
    model: "test-model",
    pinnedContext: [],
    approvalMode: "yolo",
    topic: "test",
    summary: "",
    summaryEmbeddingB64: null,
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
  listMarkdown: async () => [],
  read: async () => "",
  readNote: async () => "",
  write: async () => {},
  writeNote: async () => {},
  updateFrontmatter: async () => {},
  remove: async () => {},
  exists: async () => false,
  createFolder: async () => {},
  list: async () => ({ files: [], folders: [] }),
  readBinary: async () => null,
  writeBinary: async () => {},
  rename: async () => {},
};

function makeGate(): ApprovalGate {
  return new ApprovalGate({
    events: { onPending: () => {}, onResolved: () => {} },
    recordHistoryAutoApprove: async () => {},
  });
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
      { type: "loop:tool-call", call: { id: "tc1", name: "vault.search_notes", args: {} } },
      {
        type: "loop:tool-result",
        result: { callId: "tc1", status: "ok", data: { hits: [] }, durationMs: 12 },
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
      { conversationId: conversation.id, userMessage: "hi" },
      (line) => lines.push(line),
      "req-1",
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
        result: { callId: "tc1", status: "error", error: "boom", durationMs: 1 },
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
      { conversationId: conversation.id, userMessage: "hi" },
      (line) => lines.push(line),
      "req-1",
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
        { conversationId: conversation.id, userMessage: "describe @cat.png" },
        () => {},
        "req-1",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("VISION_UNAVAILABLE");
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
      { conversationId: conversation.id, userMessage: "hi" },
      (line) => lines.push(line),
      "req-1",
    );

    // Let the handler subscribe before firing the gate.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const controller = new AbortController();
    const requestPromise = gate.request(
      { id: "tc-approval", name: "notes.create", args: { path: "x.md" } },
      "safe",
      "preview",
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    gate.resolve("tc-approval", { approved: true });
    await requestPromise;
    releaseGate();
    await sendPromise;

    const events = lines.map((line) => JSON.parse(line));
    expect(events.some((event) => event.event === "loop:approval_pending")).toBe(true);
    expect(events.some((event) => event.event === "loop:approval_resolved")).toBe(true);
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
      { conversationId: conversation.id, userMessage: "hi" },
      (line) => lines.push(line),
      "req-1",
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
      { conversationId: conversation.id, userMessage: "hi" },
      (line) => lines.push(line),
      "req-1",
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
      { conversationId: conversation.id, userMessage: "hi" },
      (line) => lines.push(line),
      "req-1",
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
