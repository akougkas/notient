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

// Streaming utilities
export {
  createStreamController,
  mergeStreams,
  collectStream,
  collectStringStream,
} from "./streaming";
export type { StreamController } from "./streaming";
