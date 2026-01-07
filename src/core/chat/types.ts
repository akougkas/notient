/**
 * Chat Type Definitions
 *
 * Types for the reusable chat system.
 */

import type { ChatMessage } from "../llm/types";

/**
 * Configuration for a chat session
 */
export interface ChatConfig {
  /** Maximum messages to retain in history */
  maxHistoryLength?: number;
  /** Maximum messages to send to LLM (sliding window) */
  maxLLMMessages?: number;
}

/**
 * A message with metadata for the UI
 */
export interface ExtendedChatMessage extends ChatMessage {
  /** Unique identifier */
  id: string;
  /** When the message was created */
  timestamp: Date;
  /** Optional attachments (citations, files, etc.) */
  attachments?: ChatAttachment[];
}

/**
 * An attachment on a chat message
 */
export interface ChatAttachment {
  id: string;
  type: "rag-citation" | "user-attached";
  filename: string;
  path: string;
}

/**
 * State of the chat session
 */
export interface ChatSessionState {
  /** All messages in the session */
  messages: ExtendedChatMessage[];
  /** Whether streaming is active */
  isStreaming: boolean;
  /** Content being streamed (partial response) */
  streamingContent: string;
}
