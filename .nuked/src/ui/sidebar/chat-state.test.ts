import { describe, expect, test } from "bun:test";
import type { ChatStreamEvent } from "../../core/chat/chatService";
import type { Conversation } from "../../core/chat/types";
import {
  activeConversation,
  chatError,
  dispatchChat,
  draftInput,
  liveAssistantBuffer,
  liveReasoningBuffer,
  resetChatState,
  setChatRunner,
  turnInFlight,
} from "./chat-state";

function fakeConversation(): Conversation {
  return {
    id: "conv-1",
    notePath: "Notient/conversations/conv-1.md",
    model: "mini",
    pinnedContext: [],
    approvalMode: "safe",
    topic: "Test topic",
    summary: "",
    summaryEmbeddingB64: null,
    messageCount: 0,
    createdAt: 0,
    updatedAt: 0,
    messages: [],
  };
}

describe("chat-state", () => {
  test("dispatchChat short-circuits when no runner is configured", async () => {
    resetChatState();
    activeConversation.value = fakeConversation();
    await dispatchChat("hello");
    expect(chatError.value).toBe("Chat runner not configured.");
    expect(turnInFlight.value).toBe(false);
  });

  test("dispatchChat refuses when no conversation is active", async () => {
    resetChatState();
    setChatRunner(async function* (): AsyncIterable<ChatStreamEvent> {
      yield { type: "turn:aborted", reason: "should not reach" };
    });
    await dispatchChat("hello");
    expect(chatError.value).toBe("No active conversation.");
    setChatRunner(null);
  });

  test("dispatchChat ignores empty input", async () => {
    resetChatState();
    activeConversation.value = fakeConversation();
    let calls = 0;
    setChatRunner(async function* (): AsyncIterable<ChatStreamEvent> {
      calls += 1;
      yield { type: "turn:aborted", reason: "should not run" };
    });
    await dispatchChat("   ");
    expect(calls).toBe(0);
    setChatRunner(null);
  });

  test("dispatchChat forwards stream events into signals", async () => {
    resetChatState();
    activeConversation.value = fakeConversation();
    const captured: string[] = [];
    setChatRunner(async function* (conversation, userMessage): AsyncIterable<ChatStreamEvent> {
      captured.push(userMessage);
      expect(conversation.id).toBe("conv-1");
      yield {
        type: "turn:start",
        conversationId: "conv-1",
        userMessage: {
          id: "u-1",
          role: "user",
          content: userMessage,
          createdAt: 1,
        },
      };
      yield { type: "loop:assistant-token", delta: "Hel" };
      yield { type: "loop:assistant-token", delta: "lo" };
      yield { type: "loop:reasoning-token", delta: "thinking" };
      yield {
        type: "turn:complete",
        conversation: {
          ...fakeConversation(),
          messages: [
            {
              id: "u-1",
              role: "user",
              content: userMessage,
              createdAt: 1,
            },
            {
              id: "a-1",
              role: "assistant",
              content: "Hello",
              createdAt: 2,
            },
          ],
          updatedAt: 2,
        },
      };
    });
    await dispatchChat("hello world");
    expect(captured).toEqual(["hello world"]);
    expect(turnInFlight.value).toBe(false);
    // liveAssistantBuffer/liveReasoningBuffer reset after the turn closes.
    expect(liveAssistantBuffer.value).toBe("");
    expect(liveReasoningBuffer.value).toBe("");
    expect(activeConversation.value?.messages.length).toBe(2);
    setChatRunner(null);
  });

  test("dispatchChat surfaces loop errors via chatError", async () => {
    resetChatState();
    activeConversation.value = fakeConversation();
    setChatRunner(async function* (): AsyncIterable<ChatStreamEvent> {
      yield { type: "loop:error", message: "boom" };
    });
    await dispatchChat("ping");
    expect(chatError.value).toBe("boom");
    setChatRunner(null);
  });

  test("resetChatState clears every signal", () => {
    activeConversation.value = fakeConversation();
    draftInput.value = "left over";
    liveAssistantBuffer.value = "stale";
    chatError.value = "nope";
    resetChatState();
    expect(activeConversation.value).toBeNull();
    expect(draftInput.value).toBe("");
    expect(liveAssistantBuffer.value).toBe("");
    expect(chatError.value).toBeNull();
  });
});
