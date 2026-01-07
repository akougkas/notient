/**
 * Conversation Store
 *
 * Persists chat conversations across sessions, keyed by note path.
 * Handles note renames by updating conversation keys.
 */

import * as fs from "fs";
import type { StoragePaths } from "../../services/storagePaths";
import type { ExtendedChatMessage } from "./types";

/** Schema version for migration support */
const SCHEMA_VERSION = 1;

/** Default retention settings */
const DEFAULT_MAX_MESSAGES_PER_NOTE = 50;
const DEFAULT_MAX_AGE_DAYS = 30;
const FLUSH_DEBOUNCE_MS = 500;

/**
 * Serializable format for a single conversation
 */
interface SerializedConversation {
  notePath: string;
  messages: SerializedMessage[];
  createdAt: string;
  lastAccessedAt: string;
}

/**
 * Serializable message format (Date -> ISO string)
 */
interface SerializedMessage {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
  timestamp: string;
  attachments?: Array<{
    id: string;
    type: "rag-citation" | "user-attached";
    filename: string;
    path: string;
  }>;
}

/**
 * Root storage schema
 */
interface ConversationStorage {
  version: number;
  conversations: Record<string, SerializedConversation>;
}

/**
 * Retention configuration
 */
export interface ChatRetentionConfig {
  maxMessagesPerNote: number;
  maxAgeDays: number;
}

/**
 * Manages conversation persistence across sessions
 */
export class ConversationStore {
  private conversations: Map<string, ExtendedChatMessage[]> = new Map();
  private conversationMeta: Map<string, { createdAt: Date; lastAccessedAt: Date }> = new Map();
  private dirty = false;
  private flushTimeout: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;

  constructor(
    private storagePaths: StoragePaths,
    private retention: ChatRetentionConfig = {
      maxMessagesPerNote: DEFAULT_MAX_MESSAGES_PER_NOTE,
      maxAgeDays: DEFAULT_MAX_AGE_DAYS,
    }
  ) {}

  /**
   * Load conversations from disk
   */
  async load(): Promise<void> {
    if (this.loaded) return;

    const filePath = this.storagePaths.conversations;

    try {
      const exists = await this.fileExists(filePath);
      if (!exists) {
        this.loaded = true;
        return;
      }

      const content = await fs.promises.readFile(filePath, "utf-8");
      const storage: ConversationStorage = JSON.parse(content);

      // Handle schema migrations here if needed
      if (storage.version !== SCHEMA_VERSION) {
        console.warn(`[ConversationStore] Schema migration needed from v${storage.version} to v${SCHEMA_VERSION}`);
        // Future: add migration logic
      }

      // Deserialize conversations
      for (const [notePath, serialized] of Object.entries(storage.conversations)) {
        const messages = serialized.messages.map(this.deserializeMessage);
        this.conversations.set(notePath, messages);
        this.conversationMeta.set(notePath, {
          createdAt: new Date(serialized.createdAt),
          lastAccessedAt: new Date(serialized.lastAccessedAt),
        });
      }

      this.loaded = true;
      console.log(`[ConversationStore] Loaded ${this.conversations.size} conversations`);
    } catch (error) {
      console.error("[ConversationStore] Failed to load:", error);
      this.loaded = true; // Mark as loaded even on error to prevent retries
    }
  }

  /**
   * Flush conversations to disk (debounced)
   */
  async flush(): Promise<void> {
    if (!this.dirty) return;

    // Clear any pending debounce
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }

    const filePath = this.storagePaths.conversations;

    try {
      const storage: ConversationStorage = {
        version: SCHEMA_VERSION,
        conversations: {},
      };

      for (const [notePath, messages] of this.conversations.entries()) {
        const meta = this.conversationMeta.get(notePath);
        storage.conversations[notePath] = {
          notePath,
          messages: messages.map(this.serializeMessage),
          createdAt: meta?.createdAt.toISOString() ?? new Date().toISOString(),
          lastAccessedAt: meta?.lastAccessedAt.toISOString() ?? new Date().toISOString(),
        };
      }

      await fs.promises.writeFile(filePath, JSON.stringify(storage, null, 2), "utf-8");
      this.dirty = false;
      console.log(`[ConversationStore] Flushed ${this.conversations.size} conversations`);
    } catch (error) {
      console.error("[ConversationStore] Failed to flush:", error);
    }
  }

  /**
   * Schedule a debounced flush
   */
  private scheduleFlush(): void {
    this.dirty = true;

    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
    }

    this.flushTimeout = setTimeout(() => {
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  /**
   * Get conversation history for a note
   * @param notePath - Normalized path to the note
   */
  getHistory(notePath: string): ExtendedChatMessage[] {
    const messages = this.conversations.get(notePath);
    if (!messages) return [];

    // Update last accessed time
    const meta = this.conversationMeta.get(notePath);
    if (meta) {
      meta.lastAccessedAt = new Date();
      this.scheduleFlush();
    }

    return [...messages];
  }

  /**
   * Append a message to a conversation
   * @param notePath - Normalized path to the note
   * @param message - Message to append
   */
  appendMessage(notePath: string, message: ExtendedChatMessage): void {
    let messages = this.conversations.get(notePath);

    if (!messages) {
      messages = [];
      this.conversations.set(notePath, messages);
      this.conversationMeta.set(notePath, {
        createdAt: new Date(),
        lastAccessedAt: new Date(),
      });
    }

    messages.push(message);

    // Enforce per-note message limit
    if (messages.length > this.retention.maxMessagesPerNote) {
      const excess = messages.length - this.retention.maxMessagesPerNote;
      messages.splice(0, excess);
    }

    // Update last accessed time
    const meta = this.conversationMeta.get(notePath);
    if (meta) {
      meta.lastAccessedAt = new Date();
    }

    this.scheduleFlush();
  }

  /**
   * Handle note rename - update conversation key
   * @param oldPath - Previous path
   * @param newPath - New path
   */
  handleRename(oldPath: string, newPath: string): void {
    const messages = this.conversations.get(oldPath);
    const meta = this.conversationMeta.get(oldPath);

    if (messages) {
      this.conversations.delete(oldPath);
      this.conversations.set(newPath, messages);

      if (meta) {
        this.conversationMeta.delete(oldPath);
        meta.lastAccessedAt = new Date();
        this.conversationMeta.set(newPath, meta);
      }

      this.scheduleFlush();
      console.log(`[ConversationStore] Renamed conversation: ${oldPath} -> ${newPath}`);
    }
  }

  /**
   * Delete conversation for a note
   * @param notePath - Path to the note
   */
  deleteConversation(notePath: string): void {
    if (this.conversations.has(notePath)) {
      this.conversations.delete(notePath);
      this.conversationMeta.delete(notePath);
      this.scheduleFlush();
      console.log(`[ConversationStore] Deleted conversation: ${notePath}`);
    }
  }

  /**
   * Check if a conversation exists for a note
   */
  hasConversation(notePath: string): boolean {
    return this.conversations.has(notePath);
  }

  /**
   * Get all note paths with conversations
   */
  getConversationPaths(): string[] {
    return Array.from(this.conversations.keys());
  }

  /**
   * Prune old conversations based on retention policy
   */
  prune(): void {
    const now = Date.now();
    const maxAge = this.retention.maxAgeDays * 24 * 60 * 60 * 1000;
    let pruned = 0;

    for (const [notePath, meta] of this.conversationMeta.entries()) {
      const age = now - meta.lastAccessedAt.getTime();
      if (age > maxAge) {
        this.conversations.delete(notePath);
        this.conversationMeta.delete(notePath);
        pruned++;
      }
    }

    if (pruned > 0) {
      this.scheduleFlush();
      console.log(`[ConversationStore] Pruned ${pruned} old conversations`);
    }
  }

  /**
   * Clear all conversations
   */
  clear(): void {
    this.conversations.clear();
    this.conversationMeta.clear();
    this.scheduleFlush();
  }

  /**
   * Update retention configuration
   */
  updateRetention(config: Partial<ChatRetentionConfig>): void {
    if (config.maxMessagesPerNote !== undefined) {
      this.retention.maxMessagesPerNote = config.maxMessagesPerNote;
    }
    if (config.maxAgeDays !== undefined) {
      this.retention.maxAgeDays = config.maxAgeDays;
    }
  }

  /**
   * Get conversation count
   */
  get count(): number {
    return this.conversations.size;
  }

  /**
   * Dispose - ensure final flush
   */
  async dispose(): Promise<void> {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }
    await this.flush();
  }

  // ============ Private Helpers ============

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private serializeMessage(msg: ExtendedChatMessage): SerializedMessage {
    return {
      id: msg.id,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp.toISOString(),
      attachments: msg.attachments,
    };
  }

  private deserializeMessage(msg: SerializedMessage): ExtendedChatMessage {
    return {
      id: msg.id,
      role: msg.role,
      content: msg.content,
      timestamp: new Date(msg.timestamp),
      attachments: msg.attachments,
    };
  }
}
