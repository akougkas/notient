/**
 * Conversation Store (SQLite-backed)
 *
 * Per-note conversation storage using SQLite messages table.
 *
 * Key features:
 * - Lazy loading: loads conversation when accessed
 * - Status tracking: success/failed/cancelled for audit trail
 * - In-memory caching with SQLite persistence
 */

import type { Kysely } from "kysely";
import type { Database } from "../db/schema";
import { generateNoteId } from "../indexer/simpleChunker";
import type { ExtendedChatMessage, StoredChatMessage } from "./types";

/** Default retention settings */
const DEFAULT_MAX_MESSAGES_PER_NOTE = 50;
const DEFAULT_MAX_AGE_DAYS = 30;
const FLUSH_DEBOUNCE_MS = 500;

/**
 * Retention configuration
 */
export interface ChatRetentionConfig {
  maxMessagesPerNote: number;
  maxAgeDays: number;
}

/** In-memory conversation metadata */
interface ConversationMeta {
  notePath: string;
  createdAt: Date;
  lastAccessedAt: Date;
}

/**
 * Manages per-note conversation persistence using SQLite
 */
export class ConversationStore {
  /** Loaded conversations keyed by noteId */
  private loaded: Map<string, StoredChatMessage[]> = new Map();
  /** Metadata for loaded conversations */
  private meta: Map<string, ConversationMeta> = new Map();
  /** noteIds with unsaved changes */
  private dirty: Set<string> = new Set();
  /** Debounced flush timer */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private db: Kysely<Database>,
    private retention: ChatRetentionConfig = {
      maxMessagesPerNote: DEFAULT_MAX_MESSAGES_PER_NOTE,
      maxAgeDays: DEFAULT_MAX_AGE_DAYS,
    },
  ) {}

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Initialize store (no-op, SQLite is already initialized)
   */
  async initialize(): Promise<void> {
    // SQLite is already initialized via DatabaseService
  }


  /**
   * Load conversation for a specific note (lazy)
   */
  async loadConversation(noteId: string): Promise<StoredChatMessage[]> {
    // Check cache first
    const cached = this.loaded.get(noteId);
    if (cached) {
      return cached;
    }

    // Load from SQLite
    const rows = await this.db
      .selectFrom("messages")
      .selectAll()
      .where("note_path", "=", noteId)
      .orderBy("created_at", "asc")
      .execute();

    const messages: StoredChatMessage[] = rows.map((row) => ({
      id: row.id,
      role: row.role as "system" | "user" | "assistant",
      content: row.content,
      timestamp: new Date(row.created_at).toISOString(),
      attachments: row.attachments ? JSON.parse(row.attachments) : undefined,
      status: row.status as StoredChatMessage["status"],
      reasoningSummary: row.reasoning_summary ?? undefined,
      actionRef: row.action_ref ?? undefined,
    }));

    this.loaded.set(noteId, messages);
    if (messages.length > 0) {
      this.meta.set(noteId, {
        notePath: noteId, // We use noteId as path reference
        createdAt: new Date(rows[0].created_at),
        lastAccessedAt: new Date(),
      });
    }

    return messages;
  }

  /**
   * Get conversation history for a note
   * Returns from cache, or empty array if not loaded.
   */
  getHistory(notePath: string): ExtendedChatMessage[] {
    const noteId = generateNoteId(notePath);
    const messages = this.loaded.get(noteId);
    if (!messages) return [];

    // Update last accessed time
    const existingMeta = this.meta.get(noteId);
    if (existingMeta) {
      existingMeta.lastAccessedAt = new Date();
    }

    // Convert StoredChatMessage to ExtendedChatMessage
    return messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: new Date(message.timestamp),
      attachments: message.attachments,
    }));
  }

  /**
   * Append a message to a conversation
   * Stores in cache and schedules disk flush.
   *
   * @param notePath - Note path (required)
   * @param message - Message to append
   */
  appendMessage(notePath: string, message: ExtendedChatMessage): void {
    const noteId = generateNoteId(notePath);

    let messages = this.loaded.get(noteId);
    if (!messages) {
      messages = [];
      this.loaded.set(noteId, messages);
      this.meta.set(noteId, {
        notePath,
        createdAt: new Date(),
        lastAccessedAt: new Date(),
      });
    }

    // Determine status based on content
    const status =
      message.role === "assistant" ? (message.content ? "success" : "failed") : undefined;

    // Create stored message
    const stored: StoredChatMessage = {
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp.toISOString(),
      attachments: message.attachments,
      status,
    };

    messages.push(stored);

    // Enforce per-note message limit
    if (messages.length > this.retention.maxMessagesPerNote) {
      const excess = messages.length - this.retention.maxMessagesPerNote;
      messages.splice(0, excess);
    }

    // Update meta
    const conversationMeta = this.meta.get(noteId);
    if (conversationMeta) {
      conversationMeta.notePath = notePath;
      conversationMeta.lastAccessedAt = new Date();
    }

    this.dirty.add(noteId);
    this.scheduleFlush();
  }

  /**
   * Handle note rename - update stored path
   */
  handleRename(oldPath: string, newPath: string): void {
    const oldNoteId = generateNoteId(oldPath);
    const newNoteId = generateNoteId(newPath);

    const messages = this.loaded.get(oldNoteId);
    const meta = this.meta.get(oldNoteId);

    if (messages && meta) {
      if (oldNoteId !== newNoteId) {
        // Move to new noteId
        this.loaded.delete(oldNoteId);
        this.loaded.set(newNoteId, messages);
        this.meta.delete(oldNoteId);
        meta.notePath = newPath;
        meta.lastAccessedAt = new Date();
        this.meta.set(newNoteId, meta);
        this.dirty.delete(oldNoteId);
        this.dirty.add(newNoteId);

        // Update in SQLite - delete old and reinsert
        void this.updateNotePathInDb(oldNoteId, newNoteId);
      } else {
        meta.notePath = newPath;
        meta.lastAccessedAt = new Date();
      }
    }
  }

  /**
   * Delete conversation for a note
   */
  deleteConversation(notePath: string): void {
    const noteId = generateNoteId(notePath);
    this.loaded.delete(noteId);
    this.meta.delete(noteId);
    this.dirty.delete(noteId);

    // Delete from SQLite
    void this.db.deleteFrom("messages").where("note_path", "=", noteId).execute();
  }

  /**
   * Check if a conversation exists for a note (in cache)
   */
  hasConversation(notePath: string): boolean {
    const noteId = generateNoteId(notePath);
    return this.loaded.has(noteId);
  }

  /**
   * Get all loaded note IDs
   */
  getLoadedNoteIds(): string[] {
    return Array.from(this.loaded.keys());
  }

  /**
   * Flush all dirty conversations to SQLite
   */
  async flush(): Promise<void> {
    if (this.dirty.size === 0) return;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const toSave = Array.from(this.dirty);
    this.dirty.clear();

    for (const noteId of toSave) {
      try {
        await this.saveConversation(noteId);
      } catch (error) {
        console.error(`[ConversationStore] Failed to save ${noteId}:`, error);
        this.dirty.add(noteId); // Re-add for retry
      }
    }
  }

  /**
   * Prune old conversations based on retention policy
   */
  async prune(): Promise<void> {
    const now = Date.now();
    const maxAge = this.retention.maxAgeDays * 24 * 60 * 60 * 1000;
    const cutoff = now - maxAge;

    // Delete old messages from SQLite
    const result = await this.db
      .deleteFrom("messages")
      .where("created_at", "<", cutoff)
      .executeTakeFirst();

    if (result.numDeletedRows && result.numDeletedRows > 0n) {
      console.log(`[ConversationStore] Pruned ${result.numDeletedRows} old messages`);
    }

    // Clear from cache if expired
    for (const [noteId, meta] of this.meta) {
      if (now - meta.lastAccessedAt.getTime() > maxAge) {
        this.loaded.delete(noteId);
        this.meta.delete(noteId);
        this.dirty.delete(noteId);
      }
    }
  }

  /**
   * Clear all conversations
   */
  clear(): void {
    this.loaded.clear();
    this.meta.clear();
    this.dirty.clear();
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
   * Get loaded conversation count
   */
  get count(): number {
    return this.loaded.size;
  }

  /**
   * Dispose - ensure final flush
   */
  async dispose(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    this.loaded.clear();
    this.meta.clear();
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Schedule a debounced flush
   */
  private scheduleFlush(): void {
    if (this.flushTimer) return;

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  /**
   * Save a specific conversation to SQLite
   */
  private async saveConversation(noteId: string): Promise<void> {
    const messages = this.loaded.get(noteId);
    if (!messages) return;

    // Delete existing messages for this note
    await this.db.deleteFrom("messages").where("note_path", "=", noteId).execute();

    // Insert all messages
    if (messages.length > 0) {
      const rows = messages.map((msg) => ({
        id: msg.id,
        note_path: noteId,
        role: msg.role,
        content: msg.content,
        thinking: null,
        created_at: new Date(msg.timestamp).getTime(),
        attachments: msg.attachments ? JSON.stringify(msg.attachments) : null,
        status: msg.status ?? null,
        reasoning_summary: msg.reasoningSummary ?? null,
        action_ref: msg.actionRef ?? null,
      }));

      // Insert in batches
      const chunkSize = 100;
      for (let i = 0; i < rows.length; i += chunkSize) {
        await this.db
          .insertInto("messages")
          .values(rows.slice(i, i + chunkSize))
          .execute();
      }
    }
  }

  /**
   * Update note_path in SQLite when a note is renamed
   */
  private async updateNotePathInDb(oldNoteId: string, newNoteId: string): Promise<void> {
    await this.db
      .updateTable("messages")
      .set({ note_path: newNoteId })
      .where("note_path", "=", oldNoteId)
      .execute();
  }
}
