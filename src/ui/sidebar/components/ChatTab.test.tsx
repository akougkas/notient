import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import type { Conversation } from "../../../core/chat/types";
import {
  activeConversation,
  chatError,
  contextUsage,
  draftInput,
  drawerOpen,
  liveAssistantBuffer,
  liveReasoningBuffer,
  pendingApprovals,
  persistReasoning,
  pinnedContext,
  resetChatState,
  turnInFlight,
} from "../chat-state";
import { ChatTab } from "./ChatTab";

function buildConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    notePath: "Notient/conversations/conv-1.md",
    model: "mini",
    pinnedContext: [],
    approvalMode: "safe",
    topic: "Daily review",
    summary: "",
    summaryEmbeddingB64: null,
    messageCount: 0,
    createdAt: 0,
    updatedAt: 0,
    messages: [],
    ...overrides,
  };
}

describe("ChatTab", () => {
  test("renders empty state when no conversation is active", () => {
    resetChatState();
    const html = render(<ChatTab />);
    expect(html).toContain("notient-tab-body--chat");
    expect(html).toContain("Talk to your second brain");
    expect(html).toContain("Start new conversation");
  });

  test("renders header with topic and context usage", () => {
    resetChatState();
    activeConversation.value = buildConversation({ topic: "Daily review" });
    contextUsage.value = { used: 8000, budget: 32000 };
    const html = render(<ChatTab />);
    expect(html).toContain("notient-chat-header");
    expect(html).toContain("Daily review");
    expect(html).toContain("25%");
    expect(html).toContain("Safe");
    expect(html).toContain("notient-chat-header__mode--safe");
  });

  test("renders yolo approval mode toggle state", () => {
    resetChatState();
    activeConversation.value = buildConversation({ approvalMode: "yolo" });
    const html = render(<ChatTab />);
    expect(html).toContain("Yolo");
    expect(html).toContain("notient-chat-header__mode--yolo");
  });

  test("shows the drawer when drawerOpen is true", () => {
    resetChatState();
    activeConversation.value = buildConversation();
    drawerOpen.value = true;
    const html = render(<ChatTab />);
    expect(html).toContain("notient-chat-drawer");
    expect(html).toContain("New chat");
  });

  test("renders conversation messages and pinned context chips", () => {
    resetChatState();
    activeConversation.value = buildConversation({
      messages: [
        { id: "u-1", role: "user", content: "What is X?", createdAt: 1 },
        { id: "a-1", role: "assistant", content: "X is Y", createdAt: 2 },
      ],
    });
    pinnedContext.value = ["notes/x.md"];
    const html = render(<ChatTab />);
    expect(html).toContain("notient-chat-message--user");
    expect(html).toContain("notient-chat-message--assistant");
    expect(html).toContain("What is X?");
    expect(html).toContain("X is Y");
    expect(html).toContain("notes/x.md");
  });

  test("renders the live assistant buffer while a turn is in flight", () => {
    resetChatState();
    activeConversation.value = buildConversation();
    turnInFlight.value = true;
    liveAssistantBuffer.value = "streaming...";
    const html = render(<ChatTab />);
    expect(html).toContain("notient-chat-message--live");
    expect(html).toContain("streaming...");
    expect(html).toContain("Press Esc to abort");
  });

  test("renders reasoning block while streaming when persistence is enabled", () => {
    resetChatState();
    activeConversation.value = buildConversation();
    turnInFlight.value = true;
    persistReasoning.value = true;
    liveReasoningBuffer.value = "step 1";
    const html = render(<ChatTab />);
    expect(html).toContain("notient-chat-reasoning");
  });

  test("surfaces chat errors", () => {
    resetChatState();
    activeConversation.value = buildConversation();
    chatError.value = "model offline";
    const html = render(<ChatTab />);
    expect(html).toContain("notient-chat-error");
    expect(html).toContain("model offline");
  });

  test("disables the send button when the draft is empty", () => {
    resetChatState();
    activeConversation.value = buildConversation();
    draftInput.value = "";
    const html = render(<ChatTab />);
    expect(html).toContain("notient-chat-input__send");
    const sendDisabled = /class="notient-chat-input__send"[^>]*disabled/.test(html);
    expect(sendDisabled).toBe(true);
  });

  test("renders pending approval cards", () => {
    resetChatState();
    activeConversation.value = buildConversation();
    pendingApprovals.value = [
      {
        callId: "tc-1",
        toolName: "notes.create",
        args: { path: "notes/new.md", content: "hi" },
        preview: "+ new content",
        resolve: () => undefined,
      },
    ];
    const html = render(<ChatTab />);
    expect(html).toContain("notient-chat-approval");
    expect(html).toContain("notes.create");
    expect(html).toContain("+ new content");
  });
});
