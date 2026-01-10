/**
 * Conversation Store
 *
 * Per-note conversation storage with lazy loading.
 * Files stored at: data/conversations/notes/{noteId}.json
 *
 * Key features:
 * - Lazy loading: only loads conversation when accessed
 * - Status tracking: success/failed/cancelled for audit trail
 * - Reasoning summary: stores <think> summary, not full content
 * - Migration: auto-migrates legacy conversations.json
 * - Rollups: on-demand folder summaries for PARA
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { StoragePaths } from "../../services/storagePaths";
import { atomicWriteFile } from "../../utils/atomicWrite";
import { generateNoteId } from "../indexer/simpleChunker";
import type {
  ConversationFile,
  ExtendedChatMessage,
  StoredChatMessage,
} from "./types";

/** Schema version for per-note files */
const CONVERSATION_VERSION = 2;

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
 * Manages per-note conversation persistence
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
  /** Whether migration has been checked */
  private migrationChecked = false;

  constructor(
    private storagePaths: StoragePaths,
    private retention: ChatRetentionConfig = {
      maxMessagesPerNote: DEFAULT_MAX_MESSAGES_PER_NOTE,
      maxAgeDays: DEFAULT_MAX_AGE_DAYS,
    },
  ) {}

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Initialize store and run migration if needed
   * @alias load() - backward compatible
   */
  async initialize(): Promise<void> {
    await this.migrateIfNeeded();
  }

  /**
   * Backward-compatible load method
   * @deprecated Use initialize() instead
   */
  async load(): Promise<void> {
    await this.initialize();
  }

  /**
   * Load conversation for a specific note (lazy)
   */
  async loadConversation(noteId: string): Promise<StoredChatMessage[]> {
    // Check cache first
    if (this.loaded.has(noteId)) {
      return this.loaded.get(noteId)!;
    }

    const filePath = this.storagePaths.getConversationPath(noteId);

    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const data: ConversationFile = JSON.parse(content);

      this.loaded.set(noteId, data.messages);
      this.meta.set(noteId, {
        notePath: data.notePath,
        createdAt: new Date(data.createdAt),
        lastAccessedAt: new Date(data.lastAccessedAt),
      });

      return data.messages;
    } catch {
      // No conversation yet - return empty
      return [];
    }
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
      this.dirty.add(noteId);
      this.scheduleFlush();
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
    const status = message.role === "assistant" ? (message.content ? "success" : "failed") : undefined;

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
   *
   * @param oldPath - Old note path
   * @param newPath - New note path
   */
  handleRename(oldPath: string, newPath: string): void {
    // For rename, we need to handle two cases:
    // 1. The noteId is derived from oldPath - we need to migrate to newPath-based noteId
    // 2. The conversation is in memory - update the notePath in meta

    const oldNoteId = generateNoteId(oldPath);
    const newNoteId = generateNoteId(newPath);

    // Check if we have a conversation for the old path
    const messages = this.loaded.get(oldNoteId);
    const meta = this.meta.get(oldNoteId);

    if (messages && meta) {
      // If noteId changed, we need to move the data
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

        // Schedule file migration (old file will be deleted after save)
        this.scheduleFlush();

        // Also delete the old file asynchronously
        const oldFilePath = this.storagePaths.getConversationPath(oldNoteId);
        fs.promises.unlink(oldFilePath).catch(() => {
          // File might not exist - that's OK
        });
      } else {
        // Same noteId (case-only change), just update path
        meta.notePath = newPath;
        meta.lastAccessedAt = new Date();
        this.dirty.add(oldNoteId);
        this.scheduleFlush();
      }
    }
  }

  /**
   * Delete conversation for a note (takes notePath for backward compatibility)
   *
   * @param notePath - Note path
   */
  deleteConversation(notePath: string): void {
    const noteId = generateNoteId(notePath);
    this.loaded.delete(noteId);
    this.meta.delete(noteId);
    this.dirty.delete(noteId);

    const filePath = this.storagePaths.getConversationPath(noteId);

    // Move to _deleted for audit trail (async, fire-and-forget)
    fs.promises.mkdir(this.storagePaths.tempDeleted, { recursive: true })
      .then(() => {
        const deletedPath = path.join(
          this.storagePaths.tempDeleted,
          `conversation-${noteId}-${Date.now()}.json`,
        );
        return fs.promises.rename(filePath, deletedPath);
      })
      .catch(() => {
        // File might not exist - that's OK
      });
  }

  /**
   * Check if a conversation exists for a note (in cache)
   *
   * @param notePath - Note path
   */
  hasConversation(notePath: string): boolean {
    const noteId = generateNoteId(notePath);
    return this.loaded.has(noteId);
  }

  /**
   * Get all note paths with loaded conversations
   * @deprecated Use getLoadedNoteIds() for noteIds or iterate meta for paths
   */
  getConversationPaths(): string[] {
    return Array.from(this.meta.values()).map((m) => m.notePath);
  }

  /**
   * Get all loaded note IDs
   */
  getLoadedNoteIds(): string[] {
    return Array.from(this.loaded.keys());
  }

  /**
   * Flush all dirty conversations to disk
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
    const notesDir = this.storagePaths.conversationsNotes;
    const now = Date.now();
    const maxAge = this.retention.maxAgeDays * 24 * 60 * 60 * 1000;
    let pruned = 0;

    let files: string[] = [];
    try {
      files = await fs.promises.readdir(notesDir);
    } catch {
      return; // Directory doesn't exist
    }

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      const noteId = file.replace(".json", "");
      const filePath = path.join(notesDir, file);

      try {
        const content = await fs.promises.readFile(filePath, "utf-8");
        const data: ConversationFile = JSON.parse(content);

        const age = now - new Date(data.lastAccessedAt).getTime();
        if (age > maxAge) {
          // Remove from cache
          this.loaded.delete(noteId);
          this.meta.delete(noteId);
          this.dirty.delete(noteId);

          // Move to _deleted
          const deletedPath = path.join(
            this.storagePaths.tempDeleted,
            `conversation-pruned-${noteId}-${Date.now()}.json`,
          );
          await fs.promises.mkdir(this.storagePaths.tempDeleted, { recursive: true });
          await fs.promises.rename(filePath, deletedPath);
          pruned++;
        }
      } catch {
        // Skip unreadable files
      }
    }

    if (pruned > 0) {
      console.log(`[ConversationStore] Pruned ${pruned} old conversations`);
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
   * Save a specific conversation to disk
   */
  private async saveConversation(noteId: string): Promise<void> {
    const messages = this.loaded.get(noteId);
    const conversationMeta = this.meta.get(noteId);
    if (!messages || !conversationMeta) return;

    const filePath = this.storagePaths.getConversationPath(noteId);
    const data: ConversationFile = {
      version: CONVERSATION_VERSION,
      noteId,
      notePath: conversationMeta.notePath,
      messages,
      createdAt: conversationMeta.createdAt.toISOString(),
      lastAccessedAt: conversationMeta.lastAccessedAt.toISOString(),
    };

    // Ensure directory exists
    await fs.promises.mkdir(this.storagePaths.conversationsNotes, { recursive: true });
    await atomicWriteFile(filePath, JSON.stringify(data, null, 2));
  }

  /**
   * Migrate legacy conversations.json to per-note files
   */
  private async migrateIfNeeded(): Promise<void> {
    if (this.migrationChecked) return;
    this.migrationChecked = true;

    const legacyPath = this.storagePaths.legacyConversations;

    try {
      // Check if legacy file exists
      await fs.promises.access(legacyPath);
    } catch {
      // No legacy file - nothing to migrate
      return;
    }

    // Check if already migrated (new directory has files)
    try {
      const newDir = this.storagePaths.conversationsNotes;
      await fs.promises.access(newDir);
      const files = await fs.promises.readdir(newDir);
      if (files.length > 0) {
        // Already migrated - don't overwrite
        return;
      }
    } catch {
      // Directory doesn't exist yet - proceed with migration
    }

    console.log("[ConversationStore] Migrating legacy conversations...");

    try {
      // Read legacy file
      const content = await fs.promises.readFile(legacyPath, "utf-8");
      const legacy = JSON.parse(content) as {
        version?: number;
        conversations?: Record<
          string,
          {
            notePath: string;
            messages: Array<{
              id: string;
              role: "system" | "user" | "assistant";
              content: string;
              timestamp: string;
              attachments?: StoredChatMessage["attachments"];
            }>;
            createdAt: string;
            lastAccessedAt: string;
          }
        >;
      };

      // Ensure new directory
      await fs.promises.mkdir(this.storagePaths.conversationsNotes, { recursive: true });

      // Migrate each conversation
      let migratedCount = 0;
      for (const [notePath, conversation] of Object.entries(legacy.conversations ?? {})) {
        const noteId = generateNoteId(notePath);

        // Convert messages to new format
        const messages: StoredChatMessage[] = (conversation.messages ?? []).map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          timestamp: message.timestamp,
          attachments: message.attachments,
          status: message.content ? ("success" as const) : ("failed" as const),
        }));

        // Create per-note file
        const data: ConversationFile = {
          version: CONVERSATION_VERSION,
          noteId,
          notePath,
          messages,
          createdAt: conversation.createdAt,
          lastAccessedAt: conversation.lastAccessedAt,
        };

        const filePath = this.storagePaths.getConversationPath(noteId);
        await atomicWriteFile(filePath, JSON.stringify(data, null, 2));
        migratedCount++;
      }

      // Move legacy file to _deleted for audit trail
      const deletedPath = path.join(
        this.storagePaths.tempDeleted,
        `conversations-legacy-${Date.now()}.json`,
      );
      await fs.promises.mkdir(this.storagePaths.tempDeleted, { recursive: true });
      await fs.promises.rename(legacyPath, deletedPath);

      console.log(
        `[ConversationStore] Migration complete: ${migratedCount} conversations migrated`,
      );
    } catch (error) {
      console.error("[ConversationStore] Migration failed:", error);
    }
  }
}
