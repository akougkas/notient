/**
 * Index Manager
 *
 * Unified management of vector index and note state tracking.
 * Provides a clean interface for the indexer to work with.
 *
 * Responsibilities:
 * - Track which notes are indexed and their state
 * - Delegate vector operations to the underlying store
 * - Handle model switching and index migration
 * - Persistence coordination
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { generateNoteId } from "../core/indexer/simpleChunker";
import type { Kernel } from "../core/kernel";
import type { EmbeddedChunk, NoteChunk } from "../types/indexer";
import type { ChunkSearchResult, SearchOptions } from "../types/search";
import { atomicWriteFile } from "../utils/atomicWrite";
import { formatIndexTimestamp, parseIndexTimestamp } from "./storagePaths";
import type { VectorStore } from "./vectorStore";

/** Regex to parse new index filename format: idx_{timestamp}_{vaultHash}_{model}_{dim}d.json */
const NEW_INDEX_PATTERN = /^idx_(\d{8}T\d{6})_([a-f0-9]{4})_(.+)_(\d+)d\.json$/;
/** Regex to parse legacy index filename format: index-{model}-{dim}d.json */
const LEGACY_INDEX_PATTERN = /^index-(.+)-(\d+)d\.json$/;

/** Parsed index filename metadata */
interface ParsedIndexName {
  timestamp: string | null;
  vaultHash: string | null;
  modelKey: string;
  dimension: number;
  isLegacy: boolean;
}

/** Rich metadata for discovered indices - used by UI surfaces */
export interface DiscoveredIndex {
  /** Full file path */
  path: string;
  /** Model key (e.g., "nomic-embed-text") */
  modelKey: string;
  /** Embedding dimension */
  dimension: number;
  /** Number of chunks in index */
  docCount: number;
  /** Source: plugin-managed or external vault */
  source: "plugin" | "vault";
  /** Creation timestamp from filename (null for legacy) */
  createdAt: Date | null;
  /** Last updated timestamp from index metadata */
  updatedAt: Date | null;
  /** Short vault hash from filename (null for legacy) */
  vaultHash: string | null;
  /** Whether this uses the legacy naming format */
  isLegacy: boolean;
  /** Display-friendly name derived from filename */
  displayName: string;
}

/** Parse an index filename into its components */
function parseIndexFilename(filename: string): ParsedIndexName | null {
  const baseName = path.basename(filename);

  // Try new format first
  const newMatch = baseName.match(NEW_INDEX_PATTERN);
  if (newMatch) {
    return {
      timestamp: newMatch[1],
      vaultHash: newMatch[2],
      modelKey: newMatch[3],
      dimension: parseInt(newMatch[4], 10),
      isLegacy: false,
    };
  }

  // Try legacy format
  const legacyMatch = baseName.match(LEGACY_INDEX_PATTERN);
  if (legacyMatch) {
    return {
      timestamp: null,
      vaultHash: null,
      modelKey: legacyMatch[1],
      dimension: parseInt(legacyMatch[2], 10),
      isLegacy: true,
    };
  }

  return null;
}

/** State for a single indexed note */
export interface NoteState {
  path: string;
  mtimeMs: number;
  contentHash: string;
  chunkCount: number;
  embeddedAt: number;
}

/** Persisted state file format */
interface StateFile {
  version: number;
  modelKey: string;
  lastFullIndexAt: number | null;
  indexingInProgress: boolean;
  indexingStartedAt: number | null;
  notes: Record<string, NoteState>;
}

/** Index completion state */
export type IndexState =
  | "none" // No index exists for this model
  | "complete" // Index exists and all vault notes are indexed
  | "incomplete" // Index exists but some notes missing
  | "crashed" // Previous indexing was interrupted
  | "stale"; // Index exists but may have outdated entries

/** Exported index state for UI */
export interface IndexStats {
  exists: boolean;
  modelKey: string | null;
  noteCount: number;
  chunkCount: number;
  vaultNoteCount: number;
  lastFullIndexAt: number | null;
  indexingInProgress: boolean;
  indexingStartedAt: number | null;
  needsRecovery: boolean; // True if crash detected
  state: IndexState;
  completionPercent: number;
}

/**
 * Index Manager - coordinates vector store and state tracking
 *
 * Identity Strategy (Index-First Architecture):
 * - modelKey and dimension are derived from the LOADED INDEX FILE's metadata
 * - NOT from Ollama's current model (which may differ)
 * - This enables true multi-model index switching
 *
 * Index Types:
 * - Plugin indices (.obsidian/plugins/notient/): Notient-managed, FULL capability
 * - User-provided indices (vault/system/index/): External RAG data, READ-ONLY
 */
export class IndexManager {
  private states: Map<string, NoteState> = new Map();
  private modelKey = "";
  private dimension = 0;
  private isUserProvidedIndex = false; // User-provided indices (system/index/) are read-only
  private lastFullIndexAt: number | null = null;
  private indexingInProgress = false;
  private indexingStartedAt: number | null = null;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Resolved active index path (used to derive state path) */
  private activeIndexPath: string | null = null;

  constructor(
    private kernel: Kernel,
    private vectorStore: VectorStore,
  ) { }

  async initialize(): Promise<void> {
    const activePath = this.kernel.settings.indexing.activeIndexPath;

    // Determine if this is a user-provided external index (read-only)
    // User-provided indices live in vault/system/index/ and are for RAG expansion
    this.isUserProvidedIndex = activePath
      ? activePath.includes("system/index") || activePath.includes("system\\index")
      : false;

    if (activePath) {
      // INDEX-FIRST: Derive identity from the index file's metadata
      console.log(`[IndexManager] Loading index from override path: ${activePath}`);
      this.activeIndexPath = activePath;

      const meta = await IndexManager.readIndexMeta(activePath);
      if (meta) {
        this.modelKey = meta.modelKey;
        this.dimension = meta.dimension;
        console.log(`[IndexManager] Identity from index file: modelKey=${this.modelKey}, dim=${this.dimension}, userProvided=${this.isUserProvidedIndex}`);

        // Cache the metadata in settings for UI access
        this.kernel.settings.indexing.activeIndexMeta = {
          modelKey: this.modelKey,
          dimension: this.dimension,
          isUserProvided: this.isUserProvidedIndex,
        };
      } else {
        // Index file unreadable - fall back to Ollama
        console.warn(`[IndexManager] Could not read index metadata from ${activePath}, falling back to Ollama`);
        await this.deriveIdentityFromOllama();
      }

      // Pass isReadOnly to vectorStore so it knows not to persist changes to external indices
      await this.vectorStore.initialize({
        indexOverridePath: activePath,
        isReadOnly: this.isUserProvidedIndex,
      });
    } else {
      // No override - use Ollama's current model for identity
      await this.deriveIdentityFromOllama();
      await this.vectorStore.initialize({ isReadOnly: false });

      // After vectorStore initializes, it may have discovered/created an index path
      // We need to get the resolved path for state file naming
      // For now, generate the expected path (vectorStore uses same logic)
      this.activeIndexPath = this.generateIndexPath();
    }

    // Load state file (matched to active index)
    await this.loadState();

    console.log(`[IndexManager] Initialized: modelKey=${this.modelKey}, notes=${this.states.size}, userProvided=${this.isUserProvidedIndex}, indexPath=${this.activeIndexPath}`);
  }

  /** Derive identity from Ollama service (default behavior for plugin indices) */
  private async deriveIdentityFromOllama(): Promise<void> {
    const ollama = this.kernel.getService<{
      getModelKey(): string;
      getDimension(): Promise<number>;
    }>("ollama");

    if (!ollama) {
      throw new Error("Ollama service not available");
    }

    this.modelKey = ollama.getModelKey();
    this.dimension = await ollama.getDimension();
    this.isUserProvidedIndex = false;

    // Cache in settings
    this.kernel.settings.indexing.activeIndexMeta = {
      modelKey: this.modelKey,
      dimension: this.dimension,
      isUserProvided: false, // Plugin indices are NOT user-provided
    };
  }

  /**
   * Switch to a specific index path.
   * DESIGN: No hot-swapping. Index switching requires a clean plugin reload
   * to ensure all services (agents, chat, search) are using consistent state.
   */
  async switchToIndex(indexPath: string): Promise<void> {
    // Read metadata from the target index to validate it exists
    const meta = await IndexManager.readIndexMeta(indexPath);
    if (!meta) {
      this.kernel.obsidian.notice("Cannot switch: Index file not readable");
      return;
    }

    // User-provided indices (in system/index/) are read-only RAG expansion
    const isUserProvided = indexPath.includes("system/index") || indexPath.includes("system\\index");

    // Update settings with new active index
    this.kernel.settings.indexing.activeIndexPath = indexPath;
    this.kernel.settings.indexing.activeIndexMeta = {
      modelKey: meta.modelKey,
      dimension: meta.dimension,
      isUserProvided: isUserProvided,
    };
    await this.kernel.saveSettings();

    // Trigger plugin reload for clean state
    const label = isUserProvided ? `${meta.modelKey} (external)` : meta.modelKey;
    this.kernel.obsidian.notice(
      `Switching to ${label} index. Reloading plugin...`,
      5000
    );

    // Give the notice time to display, then reload
    setTimeout(() => {
      // Reload the plugin by disabling and re-enabling
      const app = this.kernel.obsidian.getApp();
      const pluginId = "notient";
      // @ts-expect-error - accessing internal Obsidian API
      app.plugins.disablePlugin(pluginId).then(() => {
        // @ts-expect-error - accessing internal Obsidian API
        app.plugins.enablePlugin(pluginId);
      });
    }, 500);
  }

  /** Check if the current index is read-only (user-provided external index) */
  isReadOnly(): boolean {
    return this.isUserProvidedIndex;
  }

  /** Get the dimension of the current index */
  getDimension(): number {
    return this.dimension;
  }

  // ============ State Tracking ============

  /** Get state for a note */
  getNoteState(notePath: string): NoteState | null {
    return this.states.get(notePath) ?? null;
  }

  /** Update state for a note */
  setNoteState(notePath: string, state: NoteState): void {
    this.states.set(notePath, state);
    this.dirty = true;
    this.scheduleSave();
  }

  /** Remove state for a note */
  removeNoteState(notePath: string): void {
    this.states.delete(notePath);
    this.dirty = true;
    this.scheduleSave();
  }

  /** Check if a note needs reindexing */
  needsReindex(notePath: string, mtimeMs: number, contentHash: string): boolean {
    const state = this.states.get(notePath);
    if (!state) return true;

    // Content changed
    if (state.contentHash !== contentHash) return true;

    // File modified after indexing
    if (mtimeMs > state.embeddedAt) return true;

    return false;
  }

  /** Get all indexed note paths */
  getIndexedPaths(): string[] {
    return Array.from(this.states.keys());
  }

  /** Get count of indexed notes */
  getIndexedCount(): number {
    return this.states.size;
  }

  /** Check if a specific note is indexed */
  isNoteIndexed(notePath: string): boolean {
    return this.states.has(notePath);
  }

  /** Record that a full index completed */
  recordFullIndex(): void {
    this.lastFullIndexAt = Date.now();
    this.indexingInProgress = false;
    this.indexingStartedAt = null;
    this.dirty = true;
    this.scheduleSave();
  }

  /** Get last full index timestamp */
  getLastFullIndexAt(): number | null {
    return this.lastFullIndexAt;
  }

  /** Mark that indexing has started (for crash recovery detection) */
  beginIndexing(): void {
    this.indexingInProgress = true;
    this.indexingStartedAt = Date.now();
    this.dirty = true;
    void this.saveState(); // Save immediately
  }

  /** Mark that indexing has completed */
  endIndexing(): void {
    this.indexingInProgress = false;
    this.indexingStartedAt = null;
    this.dirty = true;
    this.scheduleSave();
  }

  /** Check if indexing is currently in progress (for lock checking) */
  isIndexing(): boolean {
    return this.indexingInProgress;
  }

  /** Get index statistics for UI */
  async getStats(): Promise<IndexStats> {
    const chunkCount = await this.countChunks();
    const vaultNoteCount = this.kernel.obsidian.getMarkdownFiles().length;

    // Detect crash: indexing was in progress but took > 30 minutes (stuck)
    const CRASH_THRESHOLD_MS = 30 * 60 * 1000;
    const needsRecovery =
      this.indexingInProgress &&
      this.indexingStartedAt !== null &&
      Date.now() - this.indexingStartedAt > CRASH_THRESHOLD_MS;

    // Determine index state
    let state: IndexState;
    if (this.states.size === 0 && chunkCount === 0) {
      state = "none";
    } else if (needsRecovery) {
      state = "crashed";
    } else if (this.states.size >= vaultNoteCount) {
      state = "complete";
    } else if (this.states.size > 0) {
      state = "incomplete";
    } else {
      state = "stale"; // Has chunks but no state tracking
    }

    const completionPercent =
      vaultNoteCount > 0 ? Math.round((this.states.size / vaultNoteCount) * 100) : 0;

    return {
      exists: this.states.size > 0 || chunkCount > 0,
      modelKey: this.modelKey || null,
      noteCount: this.states.size,
      chunkCount,
      vaultNoteCount,
      lastFullIndexAt: this.lastFullIndexAt,
      indexingInProgress: this.indexingInProgress,
      indexingStartedAt: this.indexingStartedAt,
      needsRecovery,
      state,
      completionPercent,
    };
  }

  // ============ Vector Operations (delegates to store) ============

  async addChunks(chunks: EmbeddedChunk[]): Promise<void> {
    if (this.isUserProvidedIndex) {
      console.warn("[IndexManager] Cannot add chunks: User-provided index is read-only");
      return;
    }
    await this.vectorStore.upsertChunks(chunks);
  }

  async removeNote(notePath: string, noteId: string): Promise<void> {
    if (this.isUserProvidedIndex) {
      console.warn("[IndexManager] Cannot remove note: User-provided index is read-only");
      return;
    }
    await this.vectorStore.deleteByNoteId(noteId);
    this.removeNoteState(notePath);
  }

  async search(embedding: number[], options: SearchOptions): Promise<ChunkSearchResult[]> {
    return this.vectorStore.search(embedding, options);
  }

  async getChunksByNoteId(noteId: string): Promise<NoteChunk[]> {
    return this.vectorStore.getChunksByNoteId(noteId);
  }

  async countChunks(): Promise<number> {
    return this.vectorStore.countChunks();
  }

  async countNotes(): Promise<number> {
    return this.vectorStore.countNotes();
  }

  isReady(): boolean {
    return this.vectorStore.isReady();
  }

  // ============ Bulk Operations ============

  beginBulkUpdate(): void {
    if (this.isUserProvidedIndex) {
      console.warn("[IndexManager] Cannot begin bulk update: User-provided index is read-only");
      return;
    }
    this.vectorStore.beginBulkUpdate?.();
  }

  async endBulkUpdate(): Promise<void> {
    if (this.isUserProvidedIndex) return;
    await this.vectorStore.endBulkUpdate?.();
    await this.saveState();
  }

  async clearAll(): Promise<void> {
    if (this.isUserProvidedIndex) {
      console.warn("[IndexManager] Cannot clear: User-provided index is read-only");
      return;
    }
    await this.vectorStore.clearAll?.();
    this.states.clear();
    this.lastFullIndexAt = null;
    this.dirty = true;
  }

  // ============ Persistence ============

  async save(): Promise<void> {
    await this.vectorStore.flush?.();
    await this.saveState();
  }

  async dispose(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    await this.saveState();
    await this.vectorStore.dispose();
  }

  // ============ Multi-Model Support ============

  getActiveModelKey(): string {
    return this.modelKey;
  }

  /**
   * Discover available indices from plugin storage and system/index.
   * Returns rich metadata for UI display, sorted by creation date (newest first).
   * Static version for use during setup before full service initialization.
   */
  static async discoverIndices(storagePaths: any): Promise<DiscoveredIndex[]> {
    const results: DiscoveredIndex[] = [];

    /**
     * Process a single index file and extract rich metadata
     */
    const processIndexFile = async (
      filePath: string,
      source: "plugin" | "vault"
    ): Promise<DiscoveredIndex | null> => {
      const meta = await IndexManager.readIndexMeta(filePath);
      if (!meta) return null;

      const filename = path.basename(filePath);
      const parsed = parseIndexFilename(filename);

      // Derive createdAt from filename timestamp (new format) or meta (legacy)
      let createdAt: Date | null = null;
      if (parsed?.timestamp) {
        createdAt = parseIndexTimestamp(parsed.timestamp);
      } else if (meta.createdAt) {
        createdAt = new Date(meta.createdAt);
      }

      // Generate display name
      let displayName: string;
      if (parsed && !parsed.isLegacy) {
        // New format: show human-readable date + model
        const dateStr = createdAt
          ? createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
          : "Unknown";
        displayName = `${meta.modelKey} (${dateStr})`;
      } else {
        // Legacy format
        displayName = `${meta.modelKey} (legacy)`;
      }

      return {
        path: filePath,
        modelKey: meta.modelKey,
        dimension: meta.dimension,
        docCount: meta.docCount,
        source,
        createdAt,
        updatedAt: meta.updatedAt ? new Date(meta.updatedAt) : null,
        vaultHash: parsed?.vaultHash ?? null,
        isLegacy: parsed?.isLegacy ?? true,
        displayName,
      };
    };

    // 1. Scan Plugin Storage (.obsidian/plugins/notient/)
    try {
      console.log(`[IndexManager] Scanning plugin storage: ${storagePaths.pluginRoot}`);
      const pluginFiles = await fs.promises.readdir(storagePaths.pluginRoot);
      const indexFiles = pluginFiles.filter(f => (f.startsWith("idx_") || f.startsWith("index-")) && f.endsWith(".json"));
      console.log(`[IndexManager] Found ${indexFiles.length} potential index files:`, indexFiles);

      for (const file of indexFiles) {
        const filePath = path.join(storagePaths.pluginRoot, file);
        const idx = await processIndexFile(filePath, "plugin");
        if (idx) {
          console.log(`[IndexManager] Loaded index: ${file} (${idx.modelKey}, ${idx.dimension}d, ${idx.docCount} docs)`);
          results.push(idx);
        } else {
          console.warn(`[IndexManager] Failed to load index metadata: ${file}`);
        }
      }
    } catch (e) {
      console.warn("[IndexManager] Failed to scan plugin storage:", e);
    }

    // 2. Scan Vault System Storage (system/index/*.json)
    try {
      const sysPath = storagePaths.systemIndex;
      const dirExists = await fs.promises.access(sysPath).then(() => true).catch(() => false);

      if (dirExists) {
        const vaultFiles = await fs.promises.readdir(sysPath);
        for (const file of vaultFiles) {
          if (file.endsWith(".json")) {
            const filePath = path.join(sysPath, file);
            const idx = await processIndexFile(filePath, "vault");
            if (idx) results.push(idx);
          }
        }
      }
    } catch (e) {
      console.warn("[IndexManager] Failed to scan system index:", e);
    }

    // Sort by creation date (newest first), then by model key
    results.sort((a, b) => {
      // Non-legacy before legacy
      if (a.isLegacy !== b.isLegacy) return a.isLegacy ? 1 : -1;
      // Newer before older
      const aTime = a.createdAt?.getTime() ?? 0;
      const bTime = b.createdAt?.getTime() ?? 0;
      if (aTime !== bTime) return bTime - aTime;
      // Alphabetical by model key
      return a.modelKey.localeCompare(b.modelKey);
    });

    return results;
  }

  async discoverIndices(): Promise<DiscoveredIndex[]> {
    return IndexManager.discoverIndices(this.kernel.storagePaths);
  }

  static async readIndexMeta(filePath: string): Promise<{
    modelKey: string;
    dimension: number;
    docCount: number;
    createdAt: number | null;
    updatedAt: number | null;
  } | null> {
    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const data = JSON.parse(content);
      if (data?.meta?.modelKey) {
        return {
          modelKey: data.meta.modelKey,
          dimension: data.meta.dimension || 0,
          docCount: data.meta.docCount || 0,
          createdAt: typeof data.meta.createdAt === "number" ? data.meta.createdAt : null,
          updatedAt: typeof data.meta.updatedAt === "number" ? data.meta.updatedAt : null,
        };
      }
    } catch (e) {
      // ignore invalid json
    }
    return null;
  }

  listAvailableIndices(): string[] {
    // Legacy wrapper - deprecate later
    return [];
  }

  /**
   * Delete a specific index by its file path.
   * Only plugin-created indices can be deleted (not user-provided external indices).
   */
  async deleteIndexByPath(indexPath: string): Promise<boolean> {
    // Prevent deletion of user-provided (vault) indices
    const isExternal = indexPath.includes("system/index") || indexPath.includes("system\\index");
    if (isExternal) {
      console.warn("[IndexManager] Cannot delete user-provided index - it's read-only");
      return false;
    }

    // Check if this is the active index
    const activePath = this.kernel.settings.indexing.activeIndexPath;
    if (activePath === indexPath) {
      // Can't delete active index - clear it instead
      await this.clearAll();
      return true;
    }

    try {
      // Derive state path from index path (same naming convention)
      // index-{modelKey}.json -> state-{modelKey}.json
      const baseName = path.basename(indexPath);
      const modelKeyMatch = baseName.match(/^index-(.+)\.json$/);

      const indexExists = await fs.promises.access(indexPath).then(() => true).catch(() => false);

      if (indexExists) {
        await this.moveToDeleted(indexPath, "deleted");
      }

      // Also delete the state file if it follows the naming convention
      if (modelKeyMatch) {
        const modelKey = modelKeyMatch[1];
        const statePath = path.join(this.kernel.storagePaths.pluginRoot, `state-${modelKey}.json`);
        const stateExists = await fs.promises.access(statePath).then(() => true).catch(() => false);
        if (stateExists) {
          await this.moveToDeleted(statePath, "deleted");
        }
      }

      console.log(`[IndexManager] Deleted index at ${indexPath}`);
      return true;
    } catch (error) {
      console.error(`[IndexManager] Failed to delete index at ${indexPath}:`, error);
      return false;
    }
  }

  /**
   * Delete a specific model's index files (legacy method - use deleteIndexByPath)
   * @deprecated Use deleteIndexByPath instead
   */
  async deleteIndex(modelKey: string): Promise<boolean> {
    const indexPath = path.join(this.kernel.storagePaths.pluginRoot, `index-${modelKey}.json`);
    return this.deleteIndexByPath(indexPath);
  }

  /**
   * Trim stale entries - remove vectors for notes that no longer exist
   */
  async trimIndex(): Promise<{ removed: number }> {
    if (this.isUserProvidedIndex) {
      console.warn("[IndexManager] Cannot trim: User-provided index is read-only");
      return { removed: 0 };
    }

    const currentPaths = new Set(this.kernel.obsidian.getMarkdownFiles().map((f) => f.path));

    let removed = 0;
    const stalePaths: string[] = [];

    for (const notePath of Array.from(this.states.keys())) {
      if (!currentPaths.has(notePath)) {
        stalePaths.push(notePath);
      }
    }

    for (const notePath of stalePaths) {
      const state = this.states.get(notePath);
      if (state) {
        const noteId = generateNoteId(notePath);
        await this.vectorStore.deleteByNoteId(noteId);
        this.states.delete(notePath);
        removed++;
      }
    }

    if (removed > 0) {
      this.dirty = true;
      await this.saveState();
      await this.vectorStore.flush?.();
    }

    console.log(`[IndexManager] Trimmed ${removed} stale entries`);
    return { removed };
  }

  // ============ Export / Import ============

  /**
   * Export index to a portable JSON format
   */
  async exportIndex(): Promise<string> {
    const indexPath = path.join(this.kernel.storagePaths.pluginRoot, `index-${this.modelKey}.json`);

    try {
      const indexData = await fs.promises.readFile(indexPath, "utf-8");
      const stateData: StateFile = {
        version: 1,
        modelKey: this.modelKey,
        lastFullIndexAt: this.lastFullIndexAt,
        indexingInProgress: false,
        indexingStartedAt: null,
        notes: Object.fromEntries(this.states),
      };

      const exportData = {
        exportedAt: Date.now(),
        index: JSON.parse(indexData),
        state: stateData,
      };

      return JSON.stringify(exportData);
    } catch (error) {
      throw new Error(`Failed to export index: ${error}`);
    }
  }

  /**
   * Import index from exported JSON
   * Returns model key of imported index (may differ from current)
   */
  async importIndex(jsonData: string): Promise<{ modelKey: string; noteCount: number }> {
    try {
      const data = JSON.parse(jsonData) as {
        exportedAt: number;
        index: { meta: { modelKey: string; dimension: number }; docs: unknown[] };
        state: StateFile;
      };

      const importedModelKey = data.index.meta.modelKey;

      // Write index file (atomic for crash safety)
      const indexPath = path.join(
        this.kernel.storagePaths.pluginRoot,
        `index-${importedModelKey}.json`,
      );
      await atomicWriteFile(indexPath, JSON.stringify(data.index));

      // Write state file (atomic for crash safety)
      const statePath = path.join(
        this.kernel.storagePaths.pluginRoot,
        `state-${importedModelKey}.json`,
      );
      await atomicWriteFile(statePath, JSON.stringify(data.state, null, 2));

      console.log(`[IndexManager] Imported index for ${importedModelKey}`);

      return {
        modelKey: importedModelKey,
        noteCount: Object.keys(data.state.notes).length,
      };
    } catch (error) {
      throw new Error(`Failed to import index: ${error}`);
    }
  }

  // ============ Private Methods ============

  /**
   * Generate a new index path with the new naming format.
   * Format: idx_{timestamp}_{vaultHash}_{model}_{dim}d.json
   */
  private generateIndexPath(): string {
    const sanitizedKey = this.modelKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    const timestamp = formatIndexTimestamp();
    const vaultHash = this.kernel.storagePaths.vaultHash;
    return path.join(
      this.kernel.storagePaths.pluginRoot,
      `idx_${timestamp}_${vaultHash}_${sanitizedKey}_${this.dimension}d.json`
    );
  }

  /**
   * Get state file path. Derives from active index path when available.
   * New format: state_{timestamp}_{vaultHash}_{model}_{dim}d.json
   * Falls back to legacy format: state-{modelKey}.json
   */
  private getStatePath(): string {
    if (this.activeIndexPath) {
      const parsed = parseIndexFilename(this.activeIndexPath);
      if (parsed && !parsed.isLegacy) {
        // New format: mirror the index filename with state_ prefix
        return path.join(
          this.kernel.storagePaths.pluginRoot,
          `state_${parsed.timestamp}_${parsed.vaultHash}_${parsed.modelKey}_${parsed.dimension}d.json`
        );
      }
    }
    // Legacy fallback
    return path.join(this.kernel.storagePaths.pluginRoot, `state-${this.modelKey}.json`);
  }

  /**
   * Find existing state file, checking both new and legacy patterns.
   */
  private async findExistingStatePath(): Promise<string | null> {
    const newPath = this.getStatePath();

    // Check new format first
    const newExists = await fs.promises.access(newPath).then(() => true).catch(() => false);
    if (newExists) return newPath;

    // Check legacy format
    const legacyPath = path.join(this.kernel.storagePaths.pluginRoot, `state-${this.modelKey}.json`);
    const legacyExists = await fs.promises.access(legacyPath).then(() => true).catch(() => false);
    if (legacyExists) return legacyPath;

    return null;
  }

  private async loadState(): Promise<void> {
    // Find existing state file (supports both new and legacy formats)
    const statePath = await this.findExistingStatePath();

    if (!statePath) {
      console.log(
        `[IndexManager] No state file found for modelKey=${this.modelKey}, starting fresh`,
      );
      return;
    }

    console.log(`[IndexManager] Loading state from: ${statePath}`);

    try {
      const raw = await fs.promises.readFile(statePath, "utf-8");
      const data: StateFile = JSON.parse(raw);

      // Validate model key
      if (data.modelKey !== this.modelKey) {
        console.log(
          `[IndexManager] Model key mismatch: file=${data.modelKey}, current=${this.modelKey}. Starting fresh.`,
        );
        return;
      }

      this.lastFullIndexAt = data.lastFullIndexAt;
      this.indexingInProgress = data.indexingInProgress ?? false;
      this.indexingStartedAt = data.indexingStartedAt ?? null;
      this.states.clear();
      for (const [notePath, state] of Object.entries(data.notes)) {
        this.states.set(notePath, state);
      }

      // Log crash recovery state
      if (this.indexingInProgress) {
        console.log(
          `[IndexManager] Detected interrupted indexing from ${new Date(this.indexingStartedAt ?? 0).toISOString()}`,
        );
      }

      console.log(
        `[IndexManager] Loaded state: ${this.states.size} notes, modelKey=${this.modelKey}`,
      );
    } catch (error) {
      console.warn("[IndexManager] Failed to load state:", error);
    }
  }

  private async saveState(): Promise<void> {
    if (!this.dirty) return;

    const statePath = this.getStatePath();
    const data: StateFile = {
      version: 1,
      modelKey: this.modelKey,
      lastFullIndexAt: this.lastFullIndexAt,
      indexingInProgress: this.indexingInProgress,
      indexingStartedAt: this.indexingStartedAt,
      notes: Object.fromEntries(this.states),
    };

    try {
      // Atomic write: temp file + rename for crash safety
      await atomicWriteFile(statePath, JSON.stringify(data, null, 2));
      this.dirty = false;
    } catch (error) {
      console.error("[IndexManager] Failed to save state:", error);
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveState();
    }, 2000); // Debounce 2s
  }

  private async moveToDeleted(filePath: string, reason: string): Promise<void> {
    const deletedDir = path.join(this.kernel.storagePaths.pluginRoot, ".deleted");
    await fs.promises.mkdir(deletedDir, { recursive: true });

    const base = path.basename(filePath);
    const target = path.join(deletedDir, `${base}.${reason}.${Date.now()}`);
    await fs.promises.rename(filePath, target);
    console.log(`[IndexManager] Moved ${filePath} -> ${target}`);
  }
}
