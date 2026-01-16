/**
 * Chat Module Exports
 *
 * Clean public API for the chat system.
 */

// Types
export type {
  ChatConfig,
  ExtendedChatMessage,
  ChatAttachment,
  ChatSessionState,
  // Enhanced chat types
  ChatStreamEvent,
  ActivityPhase,
  ChatStatistics,
  DelegationDetection,
  ChatNoteContext,
  ThinkingConfig,
  ThinkingParseResult,
  ChatServiceConfig,
  DelegationKeywordConfig,
} from "./types";

export { DEFAULT_CHAT_CONFIG } from "./types";

// Core components
export { ChatSession } from "./session";
export { ConversationStore } from "./conversationStore";
export type { ChatRetentionConfig } from "./conversationStore";

// Enhanced chat service
export { ChatService } from "./chatService";

// Thinking parser utilities
export {
  ThinkingParser,
  parseThinkingFromComplete,
  estimateTokenCount,
  DEFAULT_THINKING_CONFIG,
} from "./thinkingParser";

// Streaming utilities
export {
  createStreamController,
  mergeStreams,
  collectStream,
  collectStringStream,
} from "./streaming";
export type { StreamController } from "./streaming";
