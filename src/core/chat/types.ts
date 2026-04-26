/**
 * Phase 4 chat type set. These types form the contract every later chat task
 * (parser, store, index, agent loop, UI) builds on. They live in the chat
 * module so non-chat code can keep its own narrower types.
 *
 * Conversations persist as markdown inside the vault under
 * `<vault>/Notient/conversations/`. The shapes here mirror what the parser
 * roundtrips, so test fixtures and runtime objects stay aligned.
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

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  approvals?: ApprovalRecord[];
  reasoningContent?: string;
  createdAt: number;
}

export type ApprovalMode = "safe" | "yolo";

export interface Conversation {
  id: string;
  notePath: string;
  model: string;
  pinnedContext: string[];
  approvalMode: ApprovalMode;
  topic: string;
  summary: string;
  /**
   * Base64-encoded Float32Array carrying the summary embedding produced by
   * the cross-session memory pipeline (Task 13). The store roundtrips the
   * string verbatim and never computes it.
   */
  summaryEmbeddingB64: string | null;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}
