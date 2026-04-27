import { describe, expect, test } from "bun:test";
import type { VaultAdapter } from "../../adapters/vaultAdapter";
import { ApprovalGate } from "../../core/chat/approvalGate";
import type { ChatService } from "../../core/chat/chatService";
import type { Conversation } from "../../core/chat/types";
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
      { type: "turn:start", conversationId: conversation.id, userMessage: { role: "user", content: "hi" } },
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
      { type: "turn:start", conversationId: conversation.id, userMessage: { role: "user", content: "hi" } },
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
    });
    const lines: string[] = [];
    await handlers.send(
      { conversationId: conversation.id, userMessage: "hi" },
      (line) => lines.push(line),
      "req-1",
    );
    const events = lines.map((line) => JSON.parse(line));
    expect(events.some((event) => event.event === "loop:tool_call_error")).toBe(
      true,
    );
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
    expect(events.some((event) => event.event === "loop:approval_pending")).toBe(
      true,
    );
    expect(events.some((event) => event.event === "loop:approval_resolved")).toBe(
      true,
    );
  });
});
