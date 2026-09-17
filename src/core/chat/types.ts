/**
 * Conversation contracts shared by the parser, store, agent loop, and UI.
 * Conversations persist as markdown under `<vault>/Notient/conversations/`,
 * and these shapes match the parser's round-trip format.
 */

export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  status: "ok" | "error";
  data?: unknown;
  error?: string;
  durationMs: number;
}

export interface ApprovalRecord {
  callId: string;
  approved: boolean;
  decidedAt: number;
  reason?: string;
}

interface ChatMessageBase {
  id: string;
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  approvals?: ApprovalRecord[];
  reasoningContent?: string;
  createdAt: number;
}

export interface ToolChatMessage extends ChatMessageBase {
  role: "tool";
  /** Assistant tool-call id this persisted result answers. */
  toolCallId: string;
  toolCalls?: never;
  toolResults?: never;
  approvals?: never;
  reasoningContent?: never;
}

export interface ConversationChatMessage extends ChatMessageBase {
  role: Exclude<ChatRole, "tool">;
  toolCallId?: never;
}

export type ChatMessage = ConversationChatMessage | ToolChatMessage;

export type ApprovalMode = "safe" | "yolo";

export interface Conversation {
  id: string;
  notePath: string;
  model: string;
  pinnedContext: string[];
  approvalMode: ApprovalMode;
  topic: string;
  summary: string;
  /** Client identity that started the conversation, stored as `client_identity`. */
  clientIdentity: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}
