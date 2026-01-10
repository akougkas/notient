/**
 * Storage paths management
 *
 * Provides the single source of truth for all disk paths used by Notient.
 * Uses the Obsidian FileSystemAdapter to get the absolute vault path (desktop only).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type App, FileSystemAdapter } from "obsidian";
import { PLUGIN_ID, STORAGE_PATHS } from "../core/constants";

/**
 * Generate a short vault hash (4 hex chars) for use in index filenames.
 * Deterministic: same vault path always produces same hash.
 */
function computeVaultHash(vaultPath: string): string {
  return crypto.createHash("sha256").update(vaultPath).digest("hex").slice(0, 4);
}

/**
 * Format a timestamp for index filename: YYYYMMDDTHHMMSS
 * Uses UTC to ensure consistency across timezones.
 */
export function formatIndexTimestamp(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  const s = String(date.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${d}T${h}${min}${s}`;
}

/**
 * Parse index timestamp from filename back to Date.
 * Returns null if format doesn't match.
 */
export function parseIndexTimestamp(ts: string): Date | null {
  const match = ts.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, y, m, d, h, min, s] = match;
  return new Date(Date.UTC(+y, +m - 1, +d, +h, +min, +s));
}

export interface StoragePathsConfig {
  // Core paths
  /** Vault root absolute path */
  vaultRoot: string;
  /** Short vault hash (4 hex chars) for index filenames */
  vaultHash: string;
  /** Plugin data folder */
  pluginRoot: string;
  /** System index directory (vault/system/index) */
  systemIndex: string;

  // New structure root
  /** Root data folder */
  data: string;

  // Chunks (model-agnostic)
  /** Chunks root folder */
  chunks: string;
  /** Chunks metadata file */
  chunksMeta: string;
  /** Per-note chunk files folder */
  chunksNotes: string;

  // Embeddings (model-scoped)
  /** Embeddings root folder */
  embeddings: string;
  /** Active embedding indices folder */
  embeddingsActive: string;
  /** Rebuilding embedding indices folder */
  embeddingsRebuilding: string;
  /** Archived embedding indices folder */
  embeddingsArchived: string;

  // Intelligence (tag-keyed)
  /** Intelligence root folder */
  intelligence: string;
  /** Intelligence metadata file */
  intelligenceMeta: string;
  /** Intelligence topics folder */
  intelligenceTopics: string;

  // Conversations (per-note)
  /** Conversations root folder */
  conversations: string;
  /** Per-note conversation files folder */
  conversationsNotes: string;
  /** Conversation rollups folder */
  conversationsRollups: string;
  /** Root conversation file (notes outside PARA) */
  conversationsRoot: string;

  // Actions (time-bucketed)
  /** Actions root folder */
  actions: string;
  /** Hot actions folder */
  actionsHot: string;
  /** Current hot actions file */
  actionsCurrent: string;
  /** Actions archive folder */
  actionsArchive: string;

  // Profile
  /** Profile folder */
  profile: string;
  /** Profile data file */
  profileFile: string;

  // Operational (volatile)
  /** Operational root folder */
  operational: string;
  /** Lock files folder */
  locks: string;
  /** Cache folder */
  cache: string;
  /** Temp folder */
  temp: string;
  /** Incomplete operations temp folder */
  tempIncomplete: string;
  /** Invalid data temp folder */
  tempInvalid: string;
  /** Deleted data temp folder */
  tempDeleted: string;
  /** Logs folder */
  logs: string;

  // Legacy paths (for migration detection)
  /** Legacy index state file path */
  legacyIndexState: string;
  /** Legacy conversations file path */
  legacyConversations: string;
  /** Legacy actions file path */
  legacyActions: string;
  /** Legacy profile file path */
  legacyProfile: string;
  /** Legacy cache folder */
  legacyCache: string;
  /** Legacy locks folder */
  legacyLocks: string;
  /** Legacy logs folder */
  legacyLogs: string;
}

/**
 * Resolves and manages all storage paths for the plugin
 */
export class StoragePaths {
  private config: StoragePathsConfig;

  constructor(app: App) {
    const adapter = app.vault.adapter;

    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("Notient requires desktop Obsidian with file system access");
    }

    const vaultRoot = adapter.getBasePath();
    const vaultHash = computeVaultHash(vaultRoot);
    const pluginRoot = path.join(vaultRoot, ".obsidian", "plugins", PLUGIN_ID);

    this.config = {
      // Core paths
      vaultRoot,
      vaultHash,
      pluginRoot,
      systemIndex: path.join(vaultRoot, "system", "index"),

      // New structure root
      data: path.join(pluginRoot, STORAGE_PATHS.DATA),

      // Chunks (model-agnostic)
      chunks: path.join(pluginRoot, STORAGE_PATHS.CHUNKS),
      chunksMeta: path.join(pluginRoot, STORAGE_PATHS.CHUNKS_META),
      chunksNotes: path.join(pluginRoot, STORAGE_PATHS.CHUNKS_NOTES),

      // Embeddings (model-scoped)
      embeddings: path.join(pluginRoot, STORAGE_PATHS.EMBEDDINGS),
      embeddingsActive: path.join(pluginRoot, STORAGE_PATHS.EMBEDDINGS_ACTIVE),
      embeddingsRebuilding: path.join(pluginRoot, STORAGE_PATHS.EMBEDDINGS_REBUILDING),
      embeddingsArchived: path.join(pluginRoot, STORAGE_PATHS.EMBEDDINGS_ARCHIVED),

      // Intelligence (tag-keyed)
      intelligence: path.join(pluginRoot, STORAGE_PATHS.INTELLIGENCE),
      intelligenceMeta: path.join(pluginRoot, STORAGE_PATHS.INTELLIGENCE_META),
      intelligenceTopics: path.join(pluginRoot, STORAGE_PATHS.INTELLIGENCE_TOPICS),

      // Conversations (per-note)
      conversations: path.join(pluginRoot, STORAGE_PATHS.CONVERSATIONS),
      conversationsNotes: path.join(pluginRoot, STORAGE_PATHS.CONVERSATIONS_NOTES),
      conversationsRollups: path.join(pluginRoot, STORAGE_PATHS.CONVERSATIONS_ROLLUPS),
      conversationsRoot: path.join(pluginRoot, STORAGE_PATHS.CONVERSATIONS_ROOT),

      // Actions (time-bucketed)
      actions: path.join(pluginRoot, STORAGE_PATHS.ACTIONS),
      actionsHot: path.join(pluginRoot, STORAGE_PATHS.ACTIONS_HOT),
      actionsCurrent: path.join(pluginRoot, STORAGE_PATHS.ACTIONS_CURRENT),
      actionsArchive: path.join(pluginRoot, STORAGE_PATHS.ACTIONS_ARCHIVE),

      // Profile
      profile: path.join(pluginRoot, STORAGE_PATHS.PROFILE),
      profileFile: path.join(pluginRoot, STORAGE_PATHS.PROFILE_FILE),

      // Operational (volatile)
      operational: path.join(pluginRoot, STORAGE_PATHS.OPERATIONAL),
      locks: path.join(pluginRoot, STORAGE_PATHS.LOCKS),
      cache: path.join(pluginRoot, STORAGE_PATHS.CACHE),
      temp: path.join(pluginRoot, STORAGE_PATHS.TEMP),
      tempIncomplete: path.join(pluginRoot, STORAGE_PATHS.TEMP_INCOMPLETE),
      tempInvalid: path.join(pluginRoot, STORAGE_PATHS.TEMP_INVALID),
      tempDeleted: path.join(pluginRoot, STORAGE_PATHS.TEMP_DELETED),
      logs: path.join(pluginRoot, STORAGE_PATHS.LOGS),

      // Legacy paths (for migration detection)
      legacyIndexState: path.join(pluginRoot, STORAGE_PATHS.LEGACY_INDEX_STATE),
      legacyConversations: path.join(pluginRoot, STORAGE_PATHS.LEGACY_CONVERSATIONS),
      legacyActions: path.join(pluginRoot, STORAGE_PATHS.LEGACY_ACTIONS),
      legacyProfile: path.join(pluginRoot, STORAGE_PATHS.LEGACY_PROFILE),
      legacyCache: path.join(pluginRoot, STORAGE_PATHS.LEGACY_CACHE),
      legacyLocks: path.join(pluginRoot, STORAGE_PATHS.LEGACY_LOCKS),
      legacyLogs: path.join(pluginRoot, STORAGE_PATHS.LEGACY_LOGS),
    };
  }

  /**
   * Ensure all required directories exist (legacy structure)
   * For new structure, use ensureNewDirectories()
   */
  async ensureDirectories(): Promise<void> {
    // Use legacy paths during migration period
    const dirs = [this.config.legacyCache, this.config.legacyLocks, this.config.legacyLogs];

    for (const dir of dirs) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
  }

  /**
   * Ensure all new directory structure exists
   */
  async ensureNewDirectories(): Promise<void> {
    const dirs = [
      this.config.data,
      this.config.chunks,
      this.config.chunksNotes,
      this.config.embeddings,
      this.config.embeddingsActive,
      this.config.embeddingsRebuilding,
      this.config.embeddingsArchived,
      this.config.intelligence,
      this.config.intelligenceTopics,
      this.config.conversations,
      this.config.conversationsNotes,
      this.config.conversationsRollups,
      this.config.actions,
      this.config.actionsHot,
      this.config.actionsArchive,
      this.config.profile,
      this.config.operational,
      this.config.locks,
      this.config.cache,
      this.config.temp,
      this.config.tempIncomplete,
      this.config.tempInvalid,
      this.config.tempDeleted,
      this.config.logs,
    ];

    for (const dir of dirs) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Migration Detection
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Check if legacy (pre-restructure) data exists
   */
  hasLegacyData(): boolean {
    return (
      fs.existsSync(this.config.legacyConversations) ||
      fs.existsSync(this.config.legacyActions) ||
      fs.existsSync(this.config.legacyProfile) ||
      fs.existsSync(this.config.legacyIndexState)
    );
  }

  /**
   * Check if new structure exists
   */
  hasNewStructure(): boolean {
    return fs.existsSync(this.config.data);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Core Path Getters
  // ─────────────────────────────────────────────────────────────────────────────

  get vaultRoot(): string {
    return this.config.vaultRoot;
  }

  get vaultHash(): string {
    return this.config.vaultHash;
  }

  get pluginRoot(): string {
    return this.config.pluginRoot;
  }

  get systemIndex(): string {
    return this.config.systemIndex;
  }

  get data(): string {
    return this.config.data;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Chunks (Model-Agnostic)
  // ─────────────────────────────────────────────────────────────────────────────

  get chunks(): string {
    return this.config.chunks;
  }

  get chunksMeta(): string {
    return this.config.chunksMeta;
  }

  get chunksNotes(): string {
    return this.config.chunksNotes;
  }

  /**
   * Get path for a specific note's chunk file
   */
  getChunkPath(noteId: string): string {
    return path.join(this.config.chunksNotes, `${noteId}.json`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Embeddings (Model-Scoped)
  // ─────────────────────────────────────────────────────────────────────────────

  get embeddings(): string {
    return this.config.embeddings;
  }

  get embeddingsActive(): string {
    return this.config.embeddingsActive;
  }

  get embeddingsRebuilding(): string {
    return this.config.embeddingsRebuilding;
  }

  get embeddingsArchived(): string {
    return this.config.embeddingsArchived;
  }

  /**
   * Get path for embedding index (current model)
   */
  getEmbeddingIndexPath(modelKey: string, dimension: number): string {
    const sanitized = modelKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.config.embeddingsActive, `${sanitized}-${dimension}d.json`);
  }

  /**
   * Get path for rebuilding embedding index
   */
  getRebuildingEmbeddingPath(modelKey: string, dimension: number): string {
    const sanitized = modelKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.config.embeddingsRebuilding, `${sanitized}-${dimension}d.json`);
  }

  /**
   * Get path for archived embedding index
   */
  getArchivedEmbeddingPath(modelKey: string, dimension: number, timestamp: string): string {
    const sanitized = modelKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.config.embeddingsArchived, `${sanitized}-${dimension}d-${timestamp}.json`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Intelligence (Tag-Keyed)
  // ─────────────────────────────────────────────────────────────────────────────

  get intelligence(): string {
    return this.config.intelligence;
  }

  get intelligenceMeta(): string {
    return this.config.intelligenceMeta;
  }

  get intelligenceTopics(): string {
    return this.config.intelligenceTopics;
  }

  /**
   * Get path for an intelligence topic file
   */
  getIntelligenceTopicPath(tag: string): string {
    // Sanitize tag for filename: remove leading #, replace invalid chars
    const sanitized = tag.replace(/^#/, "").replace(/[/\\:*?"<>|]/g, "-");
    return path.join(this.config.intelligenceTopics, `${sanitized}.json`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Conversations (Per-Note)
  // ─────────────────────────────────────────────────────────────────────────────

  get conversations(): string {
    return this.config.conversations;
  }

  get conversationsNotes(): string {
    return this.config.conversationsNotes;
  }

  get conversationsRollups(): string {
    return this.config.conversationsRollups;
  }

  get conversationsRoot(): string {
    return this.config.conversationsRoot;
  }

  /**
   * Get path for a specific note's conversation file
   */
  getConversationPath(noteId: string): string {
    return path.join(this.config.conversationsNotes, `${noteId}.json`);
  }

  /**
   * Get path for a conversation rollup (PARA folder)
   */
  getConversationRollupPath(paraFolder: string): string {
    // Sanitize folder path for filename
    const sanitized = paraFolder.replace(/[/\\]/g, "-").replace(/^-|-$/g, "");
    return path.join(this.config.conversationsRollups, `${sanitized}.json`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Actions (Time-Bucketed)
  // ─────────────────────────────────────────────────────────────────────────────

  get actions(): string {
    return this.config.actions;
  }

  get actionsHot(): string {
    return this.config.actionsHot;
  }

  get actionsCurrent(): string {
    return this.config.actionsCurrent;
  }

  get actionsArchive(): string {
    return this.config.actionsArchive;
  }

  /**
   * Get path for monthly action archive
   */
  getActionArchivePath(yearMonth: string): string {
    return path.join(this.config.actionsArchive, `${yearMonth}.json`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Profile
  // ─────────────────────────────────────────────────────────────────────────────

  get profile(): string {
    return this.config.profile;
  }

  get profileFile(): string {
    return this.config.profileFile;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Operational (Volatile)
  // ─────────────────────────────────────────────────────────────────────────────

  get operational(): string {
    return this.config.operational;
  }

  get locks(): string {
    return this.config.locks;
  }

  get cache(): string {
    return this.config.cache;
  }

  get temp(): string {
    return this.config.temp;
  }

  get tempIncomplete(): string {
    return this.config.tempIncomplete;
  }

  get tempInvalid(): string {
    return this.config.tempInvalid;
  }

  get tempDeleted(): string {
    return this.config.tempDeleted;
  }

  get logs(): string {
    return this.config.logs;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Legacy Paths (For Migration)
  // ─────────────────────────────────────────────────────────────────────────────

  get legacyIndexState(): string {
    return this.config.legacyIndexState;
  }

  get legacyConversations(): string {
    return this.config.legacyConversations;
  }

  get legacyActions(): string {
    return this.config.legacyActions;
  }

  get legacyProfile(): string {
    return this.config.legacyProfile;
  }

  get legacyCache(): string {
    return this.config.legacyCache;
  }

  get legacyLocks(): string {
    return this.config.legacyLocks;
  }

  get legacyLogs(): string {
    return this.config.legacyLogs;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Utility Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Convert a vault-relative path to absolute path
   */
  toAbsolute(vaultPath: string): string {
    return path.join(this.config.vaultRoot, vaultPath);
  }

  /**
   * Convert an absolute path to vault-relative path
   */
  toVaultPath(absolutePath: string): string {
    return path.relative(this.config.vaultRoot, absolutePath);
  }

  /**
   * Get all paths as config object
   */
  getConfig(): Readonly<StoragePathsConfig> {
    return { ...this.config };
  }
}
