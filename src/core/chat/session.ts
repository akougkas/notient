/**
 * Chat Session
 *
 * Manages a chat session - history, context window, etc.
 * Reusable between TaskModal, potential future chat views.
 */

import type { ChatMessage } from "../llm/types";
import type { ChatConfig, ExtendedChatMessage, ChatAttachment } from "./types";

const DEFAULT_CONFIG: Required<ChatConfig> = {
  maxHistoryLength: 100,
  maxLLMMessages: 10,
};

/**
 * Manages a chat session with history and context window
 */
export class ChatSession {
  private history: ExtendedChatMessage[] = [];
  private config: Required<ChatConfig>;

  constructor(config?: ChatConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Add a user message to the session
   * @param content - The message content
   * @param attachments - Optional attachments
   * @returns The created message
   */
  addUserMessage(
    content: string,
    attachments?: ChatAttachment[]
  ): ExtendedChatMessage {
    const message: ExtendedChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      timestamp: new Date(),
      attachments,
    };

    this.history.push(message);
    this.trimHistory();

    return message;
  }

  /**
   * Add an assistant message to the session
   * @param content - The message content
   * @param attachments - Optional attachments (e.g., RAG citations)
   * @returns The created message
   */
  addAssistantMessage(
    content: string,
    attachments?: ChatAttachment[]
  ): ExtendedChatMessage {
    const message: ExtendedChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content,
      timestamp: new Date(),
      attachments,
    };

    this.history.push(message);
    this.trimHistory();

    return message;
  }

  /**
   * Add a system message to the session
   * @param content - The message content
   * @returns The created message
   */
  addSystemMessage(content: string): ExtendedChatMessage {
    const message: ExtendedChatMessage = {
      id: crypto.randomUUID(),
      role: "system",
      content,
      timestamp: new Date(),
    };

    this.history.push(message);
    this.trimHistory();

    return message;
  }

  /**
   * Get all messages in the session
   */
  getMessages(): ExtendedChatMessage[] {
    return [...this.history];
  }

  /**
   * Get messages for sending to the LLM (sliding window)
   * @returns ChatMessages without extended metadata
   */
  getMessagesForLLM(): ChatMessage[] {
    return this.history.slice(-this.config.maxLLMMessages).map((m) => ({
      role: m.role,
      content: m.content,
    }));
  }

  /**
   * Get the N most recent messages
   * @param n - Number of messages to return
   */
  getRecentMessages(n: number): ExtendedChatMessage[] {
    return this.history.slice(-n);
  }

  /**
   * Get the last user message
   */
  getLastUserMessage(): ExtendedChatMessage | undefined {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].role === "user") {
        return this.history[i];
      }
    }
    return undefined;
  }

  /**
   * Get the last assistant message
   */
  getLastAssistantMessage(): ExtendedChatMessage | undefined {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].role === "assistant") {
        return this.history[i];
      }
    }
    return undefined;
  }

  /**
   * Clear all messages
   */
  clear(): void {
    this.history = [];
  }

  /**
   * Import messages (e.g., from persisted storage)
   * @param messages - Messages to import
   */
  importMessages(messages: ExtendedChatMessage[]): void {
    this.history = [...messages];
    this.trimHistory();
  }

  /**
   * Import from simple ChatMessage array
   * @param messages - Simple chat messages
   */
  importFromChatMessages(messages: ChatMessage[]): void {
    this.history = messages.map((m) => ({
      ...m,
      id: crypto.randomUUID(),
      timestamp: new Date(),
    }));
    this.trimHistory();
  }

  /**
   * Export messages for persistence
   */
  exportMessages(): ExtendedChatMessage[] {
    return [...this.history];
  }

  /**
   * Get the message count
   */
  get length(): number {
    return this.history.length;
  }

  /**
   * Check if the session is empty
   */
  get isEmpty(): boolean {
    return this.history.length === 0;
  }

  /**
   * Trim history to max length
   */
  private trimHistory(): void {
    if (this.history.length > this.config.maxHistoryLength) {
      this.history = this.history.slice(-this.config.maxHistoryLength);
    }
  }
}
