import { signal } from "@preact/signals";
import type { PendingApproval } from "../../core/chat/approvalGate";
import type { ChatStreamEvent } from "../../core/chat/chatService";
import type { Conversation } from "../../core/chat/types";

/**
 * ChatTab state. Pure signals plus an injected runner so the dispatcher is
 * testable without booting the ChatService kernel slice. Mirrors the SearchView
 * pattern from Task 8: main.ts (Task 16) calls {@link setChatRunner} with a
 * thin adapter over `ChatService.sendMessage`; tests stub it via a fake
 * generator and assert the resulting signal mutations.
 */

export interface ConversationSummary {
  id: string;
  notePath: string;
  topic: string;
  updatedAt: number;
}

export const activeConversation = signal<Conversation | null>(null);
export const conversationsList = signal<ConversationSummary[]>([]);
export const draftInput = signal<string>("");
export const turnInFlight = signal<boolean>(false);
export const liveAssistantBuffer = signal<string>("");
export const liveReasoningBuffer = signal<string>("");
export const pendingApprovals = signal<PendingApproval[]>([]);
export const drawerOpen = signal<boolean>(false);
export const contextUsage = signal<{ used: number; budget: number }>({
  used: 0,
  budget: 32000,
});
export const pinnedContext = signal<string[]>([]);
export const persistReasoning = signal<boolean>(false);
export const chatError = signal<string | null>(null);

export interface ChatActions {
  newConversation: () => Promise<void>;
  loadConversation: (notePath: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  abort: () => void;
  pinNote: (notePath: string) => void;
  unpinNote: (notePath: string) => void;
  resolveApproval: (callId: string, approved: boolean, reason?: string) => void;
  toggleYolo: () => Promise<void>;
  openLink: (linkText: string) => void;
  undoLastWrite: (historyId: string) => Promise<void>;
}

export const chatActions = signal<ChatActions | null>(null);

/**
 * Pure runner signature used by {@link dispatchChat}. Mirrors
 * `ChatService.sendMessage` but lets tests inject a fake generator.
 */
export type ChatRunner = (
  conversation: Conversation,
  userMessage: string,
  signal: AbortSignal,
) => AsyncIterable<ChatStreamEvent>;

let activeRunner: ChatRunner | null = null;
let activeAbort: AbortController | null = null;

export function setChatRunner(runner: ChatRunner | null): void {
  activeRunner = runner;
}

export function getChatRunner(): ChatRunner | null {
  return activeRunner;
}

/**
 * Reset every chat-related signal to its empty state. Used between tests and
 * when the sidebar tears down.
 */
export function resetChatState(): void {
  activeConversation.value = null;
  conversationsList.value = [];
  draftInput.value = "";
  turnInFlight.value = false;
  liveAssistantBuffer.value = "";
  liveReasoningBuffer.value = "";
  pendingApprovals.value = [];
  drawerOpen.value = false;
  contextUsage.value = { used: 0, budget: 32000 };
  pinnedContext.value = [];
  persistReasoning.value = false;
  chatError.value = null;
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
}

/**
 * Drive a single chat turn through the injected runner, mutating signals as
 * stream events arrive. Returns once the stream completes. A second call
 * aborts the in-flight turn before starting a new one.
 */
export async function dispatchChat(userMessage: string): Promise<void> {
  const runner = activeRunner;
  if (!runner) {
    chatError.value = "Chat runner not configured.";
    return;
  }
  const conversation = activeConversation.value;
  if (!conversation) {
    chatError.value = "No active conversation.";
    return;
  }
  const trimmed = userMessage.trim();
  if (trimmed.length === 0) {
    return;
  }
  if (activeAbort) {
    activeAbort.abort();
  }
  const controller = new AbortController();
  activeAbort = controller;
  turnInFlight.value = true;
  liveAssistantBuffer.value = "";
  liveReasoningBuffer.value = "";
  chatError.value = null;
  try {
    const iterable = runner(conversation, trimmed, controller.signal);
    for await (const event of iterable) {
      applyChatEvent(event);
      if (
        event.type === "turn:complete" ||
        event.type === "turn:aborted" ||
        event.type === "loop:error"
      ) {
        break;
      }
    }
  } catch (error) {
    chatError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (activeAbort === controller) {
      activeAbort = null;
    }
    turnInFlight.value = false;
    liveAssistantBuffer.value = "";
    liveReasoningBuffer.value = "";
  }
}

export function cancelDispatch(): void {
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
  turnInFlight.value = false;
}

function applyChatEvent(event: ChatStreamEvent): void {
  switch (event.type) {
    case "loop:assistant-token":
      liveAssistantBuffer.value = liveAssistantBuffer.value + event.delta;
      break;
    case "loop:reasoning-token":
      liveReasoningBuffer.value = liveReasoningBuffer.value + event.delta;
      break;
    case "loop:approval-pending":
      // The actual PendingApproval entry is emitted by the ApprovalGate
      // events hook wired in Task 16. The loop event only carries the call
      // shape; we use it as a hint to keep the UI responsive.
      break;
    case "turn:complete":
      activeConversation.value = event.conversation;
      break;
    case "turn:aborted":
      chatError.value = event.reason;
      break;
    case "loop:error":
      chatError.value = event.message;
      break;
    default:
      break;
  }
}
