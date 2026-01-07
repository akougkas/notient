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
} from "./types";

// Core components
export { ChatSession } from "./session";
export { ConversationStore } from "./conversationStore";
export type { ChatRetentionConfig } from "./conversationStore";

// Streaming utilities
export {
  createStreamController,
  mergeStreams,
  collectStream,
  collectStringStream,
} from "./streaming";
export type { StreamController } from "./streaming";
