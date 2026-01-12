/**
 * Index Manager
 *
 * Unified management of vector index and note state tracking.
 * OWNS ALL FILE I/O - VectorStore implementations are pure in-memory.
 *
 * Responsibilities:
 * - Discover existing index files on disk
 * - Load index data and populate VectorStore
 * - Save VectorStore data to disk (with debouncing)
 * - Track which notes are indexed and their state
 * - Handle model switching and index migration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { generateNoteId } from "../core/indexer/simpleChunker";
import type { Kernel } from "../core/kernel";
import type { EmbeddedChunk, NoteChunk, StoredChunk } from "../types/indexer";
import type { ChunkSearchResult, SearchOptions } from "../types/search";
import { atomicWriteFile } from "../utils/atomicWrite";
import { ChunkStore } from "./chunkStore";
import { formatIndexTimestamp, parseIndexTimestamp } from "./storagePaths";
import type { VectorStore } from "./vectorStore";

/** Index file version - must match VectorStore implementations */
const INDEX_VERSION = 3;

/** Regex to parse v3 index filename: idx_{timestamp}_v{version}_{model}_{dim}d.json */
const V3_INDEX_PATTERN = /^idx_(\d{8}T\d{6})_v(\d+)_(.+)_(\d+)d\.json$/;
/** Regex to parse v2 index filename: idx_{timestamp}_{vaultHash}_{model}_{dim}d.json */
const V2_INDEX_PATTERN = /^idx_(\d{8}T\d{6})_([a-f0-9]{4})_(.+)_(\d+)d\.json$/;
/** Regex to parse legacy index filename: index-{model}-{dim}d.json */
const LEGACY_INDEX_PATTERN = /^index-(.+)-(\d+)d\.json$/;

/** Parsed index filename metadata */
interface ParsedIndexName {
  timestamp: string | null;
  vaultHash: string | null;
  modelKey: string;
  dimension: number;
  version: number | null;
  format: "v3" | "v2" | "legacy";
}

/** Simple stable hash (FNV-1a 32-bit) for deriving cache keys without crypto deps */
function hashStringFNV1a32Hex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/** Rich metadata for discovered indices - used by UI surfaces */
export interface DiscoveredIndex {
  path: string;
  modelKey: string;
  dimension: number;
  docCount: number;
  source: "plugin" | "vault";
  createdAt: Date | null;
  updatedAt: Date | null;
  vaultHash: string | null;
  isLegacy: boolean;
  displayName: string;
}

/** Parse an index filename into its components */
function parseIndexFilename(filename: string): ParsedIndexName | null {
  const baseName = path.basename(filename);

  // Try v3 format first
  const v3Match = baseName.match(V3_INDEX_PATTERN);
  if (v3Match) {
    return {
      timestamp: v3Match[1],
      vaultHash: null,
      modelKey: v3Match[3],
      dimension: Number.parseInt(v3Match[4], 10),
      version: Number.parseInt(v3Match[2], 10),
      format: "v3",
    };
  }

  // Try v2 format
  const v2Match = baseName.match(V2_INDEX_PATTERN);
  if (v2Match) {
    return {
      timestamp: v2Match[1],
      vaultHash: v2Match[2],
      modelKey: v2Match[3],
      dimension: Number.parseInt(v2Match[4], 10),
      version: null,
      format: "v2",
    };
  }

  // Try legacy format
  const legacyMatch = baseName.match(LEGACY_INDEX_PATTERN);
  if (legacyMatch) {
    return {
      timestamp: null,
      vaultHash: null,
      modelKey: legacyMatch[1],
      dimension: Number.parseInt(legacyMatch[2], 10),
      version: null,
      format: "legacy",
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

/** Index completion state */
export type IndexState =
  | "none" // No index exists for this model
  | "complete" // Index exists and all vault notes are indexed
  | "incomplete" // Index exists but some notes missing
  | "stale"; // Index exists but may have outdated entries

/** Exported index state for UI */
export interface IndexStats {
  exists: boolean;
  modelKey: string | null;
  noteCount: number;
  chunkCount: number;
  vaultNoteCount: number;
  lastFullIndexAt: number | null;
  state: IndexState;
  completionPercent: number;
}

/**
 * Index Manager - coordinates vector store and OWNS all file I/O.
 */
export class IndexManager {
  private modelKey = "";
  private dimension = 0;
  private isUserProvidedIndex = false;
  private activeIndexPath: string | null = null;
  private errorPaths: Set<string> = new Set();

  // Save scheduling
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveDebounceMs = 10000; // 10s debounce

  // Discovery caching to prevent repeated filesystem scans
  private discoveryCache: { indices: DiscoveredIndex[]; timestamp: number } | null = null;
  private static readonly DISCOVERY_CACHE_TTL_MS = 30000; // 30s

  // Phase 2: Chunk/Embedding separation
  private chunkStore: ChunkStore;
  private useNewStructure = false;

  constructor(
    private kernel: Kernel,
    private vectorStore: VectorStore,
  ) {
    this.chunkStore = new ChunkStore(kernel.storagePaths);
  }

  private getHnswFilenameForIndexPath(indexPath: string): string {
    const base = path.basename(indexPath, ".json");
    const vaultKey = this.kernel.storagePaths.pluginRoot;
    const vaultHash = hashStringFNV1a32Hex(vaultKey);
    return `notient-hnsw-${vaultHash}-${base}.dat`;
  }

  async initialize(): Promise<void> {
    const startTime = performance.now();
    const activePath = this.kernel.settings.indexing.activeIndexPath;

    // Determine if this is a user-provided external index (read-only)
    this.isUserProvidedIndex = activePath
      ? activePath.includes("system/index") || activePath.includes("system\\index")
      : false;

    // Stage 1: Get model info
    console.log("[IndexManager] Stage 1/4: Getting model info...");
    const ollama = this.kernel.getService<{
      getModelKey(): string;
      getDimension(): Promise<number>;
    }>("ollama");

    if (!ollama) {
      throw new Error("Ollama service not available");
    }

    this.modelKey = ollama.getModelKey();
    this.dimension = await ollama.getDimension();

    console.log(`[IndexManager] Model: ${this.modelKey}, dim=${this.dimension}`);

    // Set model config on VectorStore
    this.vectorStore.setModelConfig?.(this.modelKey, this.dimension);

    // Stage 2: Load chunks
    console.log("[IndexManager] Stage 2/4: Loading chunk store...");
    this.useNewStructure = this.kernel.storagePaths.hasNewStructure();
    if (this.useNewStructure) {
      await this.chunkStore.loadAll();
    }

    // Check for legacy index and migrate if needed
    if (!this.useNewStructure && (await this.hasLegacyIndex())) {
      console.log("[IndexManager] Detected legacy index, will migrate...");
      await this.migrateLegacyIndex();
      this.useNewStructure = true;
    }

    // Stage 3: Load vector index
    console.log("[IndexManager] Stage 3/4: Loading vector index...");
    if (activePath) {
      // User specified a path in settings
      this.activeIndexPath = activePath;
      await this.loadIndexFromPath(activePath);
    } else {
      // Discover existing index
      const discovered = await this.discoverBestIndex();
      if (discovered) {
        this.activeIndexPath = discovered;
        await this.loadIndexFromPath(discovered);
      } else {
        // No existing index - generate path for new one
        this.activeIndexPath = this.generateIndexPath();
        console.log(`[IndexManager] No index found, will create new`);
      }
    }

    // Stage 4: Initialize vector store
    console.log("[IndexManager] Stage 4/4: Initializing vector store...");
    await this.vectorStore.initialize();

    // Cache metadata in settings for UI
    this.kernel.settings.indexing.activeIndexMeta = {
      modelKey: this.modelKey,
      dimension: this.dimension,
      isUserProvided: this.isUserProvidedIndex,
    };

    // Clean up old files from .deleted folder (background)
    this.cleanupDeletedFolder().catch(() => {});

    const noteCount = this.vectorStore.getIndexedNoteCount?.() ?? 0;
    const elapsed = Math.round(performance.now() - startTime);
    console.log(
      `[IndexManager] Initialized: ${noteCount} notes in ${elapsed}ms`,
    );
  }

  // ============ Index Discovery ============

  /**
   * Discover the best matching index for current model/dimension.
   * Returns the path to the best match, or null if none found.
   */
  private async discoverBestIndex(): Promise<string | null> {
    const sanitizedKey = this.modelKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    const pluginRoot = this.kernel.storagePaths.pluginRoot;

    console.log(
      `[IndexManager] Discovering indices for modelKey=${sanitizedKey}, dim=${this.dimension}`,
    );

    try {
      const files = await fs.promises.readdir(pluginRoot);
      const indexFiles = files.filter(
        (f) => (f.startsWith("idx_") || f.startsWith("index-")) && f.endsWith(".json"),
      );
      console.log("[IndexManager] Found index files:", indexFiles);

      const matches: Array<{
        path: string;
        format: "v3" | "v2" | "legacy";
        timestamp?: string;
        version?: number;
      }> = [];

      for (const file of indexFiles) {
        const parsed = parseIndexFilename(file);
        if (!parsed) continue;

        // Must match model key and dimension
        if (parsed.modelKey !== sanitizedKey || parsed.dimension !== this.dimension) {
          continue;
        }

        matches.push({
          path: path.join(pluginRoot, file),
          format: parsed.format,
          timestamp: parsed.timestamp ?? undefined,
          version: parsed.version ?? undefined,
        });
        console.log(`[IndexManager] Matched (${parsed.format}): ${file}`);
      }

      if (matches.length === 0) {
        console.log("[IndexManager] No matching indices found");
        return null;
      }

      // Sort: v3 > v2 > legacy, then by timestamp (newest first)
      const formatPriority = { v3: 0, v2: 1, legacy: 2 };
      matches.sort((a, b) => {
        if (a.format !== b.format) return formatPriority[a.format] - formatPriority[b.format];
        if (a.timestamp && b.timestamp) return b.timestamp.localeCompare(a.timestamp);
        return 0;
      });

      console.log(`[IndexManager] Selected: ${matches[0].path}`);
      return matches[0].path;
    } catch (e) {
      console.warn("[IndexManager] Discovery failed:", e);
      return null;
    }
  }

  // ============ Index Loading ============

  /**
   * Load index from a specific path.
   * Handles v2 and v3 formats, migrates v2 to v3.
   */
  private async loadIndexFromPath(indexPath: string): Promise<boolean> {
    console.log(`[IndexManager] Loading index from: ${indexPath}`);

    try {
      // Wait for vector store to be ready before loading data
      // This prevents race condition where WASM hasn't finished loading
      await this.vectorStore.waitForReady?.();

      const exists = await fs.promises
        .access(indexPath)
        .then(() => true)
        .catch(() => false);

      if (!exists) {
        console.log(`[IndexManager] Index file not found: ${indexPath}`);
        return false;
      }

      const raw = await fs.promises.readFile(indexPath, "utf-8");

      // Yield to event loop before heavy JSON parsing
      // This lets UI show "Loading..." instead of freezing
      await new Promise((resolve) => setTimeout(resolve, 0));

      const data = JSON.parse(raw) as {
        meta: {
          version?: number;
          modelKey: string;
          dimension: number;
          docCount: number;
          createdAt: number;
          updatedAt: number;
          state?: {
            lastFullIndexAt: number | null;
            notes: Record<string, unknown>;
          };
        };
        docs: unknown[];
      };

      console.log(
        `[IndexManager] Found index: version=${data.meta.version}, model=${data.meta.modelKey}, dim=${data.meta.dimension}, docs=${data.meta.docCount}`,
      );

      // Validate model key and dimension
      const sanitizedKey = this.modelKey.replace(/[^a-zA-Z0-9_-]/g, "_");
      if (data.meta.modelKey !== sanitizedKey) {
        console.log(
          `[IndexManager] Model key mismatch: file=${data.meta.modelKey}, current=${sanitizedKey}`,
        );
        return false;
      }

      if (data.meta.dimension !== this.dimension) {
        console.log(
          `[IndexManager] Dimension mismatch: file=${data.meta.dimension}, current=${this.dimension}`,
        );
        return false;
      }

      // Check version - support v2 and v3
      const version = data.meta.version ?? 2;
      if (version !== 2 && version !== 3) {
        console.log(`[IndexManager] Unsupported index version: ${version}`);
        await this.moveToDeleted(indexPath, `v${version}`);
        return false;
      }

      // For v2, try to migrate state from separate state file
      let state = data.meta.state;
      if (version === 2 && !state) {
        state = (await this.loadV2State()) ?? undefined;
      }

      // Load into VectorStore
      const hnswFilename = this.getHnswFilenameForIndexPath(indexPath);
      const payload = {
        meta: {
          modelKey: data.meta.modelKey,
          dimension: data.meta.dimension,
          createdAt: data.meta.createdAt,
          updatedAt: data.meta.updatedAt,
        },
        // biome-ignore lint/suspicious/noExplicitAny: Legacy v2/v3 index format compatibility
        docs: data.docs as any,
        // biome-ignore lint/suspicious/noExplicitAny: HNSW state is opaque binary data
        state: state as any,
      };

      if (this.vectorStore.loadFromDataAsync) {
        await this.vectorStore.loadFromDataAsync(
          // biome-ignore lint/suspicious/noExplicitAny: Legacy v2/v3 index format compatibility
          payload as any,
          { hnswFilename },
        );
      } else {
        this.vectorStore.loadFromData?.(
          // biome-ignore lint/suspicious/noExplicitAny: Legacy v2/v3 index format compatibility
          payload as any,
        );
      }

      // If we migrated from v2, mark dirty to save as v3
      if (version === 2) {
        console.log("[IndexManager] Migrated from v2, will save as v3");
        // Generate new v3 filename
        this.activeIndexPath = this.generateIndexPath();
        this.scheduleSave();
      }

      return true;
    } catch (error) {
      console.error("[IndexManager] Failed to load index:", error);
      await this.moveToDeleted(indexPath, "corrupt").catch(() => {});
      return false;
    }
  }

  /**
   * Load state from v2 separate state file (for migration).
   */
  private async loadV2State(): Promise<{
    lastFullIndexAt: number | null;
    notes: Record<string, unknown>;
  } | null> {
    const statePath = path.join(
      this.kernel.storagePaths.pluginRoot,
      `state-${this.modelKey.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`,
    );

    try {
      const exists = await fs.promises
        .access(statePath)
        .then(() => true)
        .catch(() => false);

      if (!exists) {
        console.log("[IndexManager] No v2 state file to migrate");
        return null;
      }

      const raw = await fs.promises.readFile(statePath, "utf-8");
      const stateData = JSON.parse(raw) as {
        lastFullIndexAt: number | null;
        notes: Record<string, unknown>;
      };

      console.log(
        `[IndexManager] Migrated ${Object.keys(stateData.notes).length} notes from v2 state`,
      );

      // Move old state file to .deleted
      await this.moveToDeleted(statePath, "migrated-to-v3");

      return stateData;
    } catch (error) {
      console.warn("[IndexManager] Failed to migrate v2 state:", error);
      return null;
    }
  }

  // ============ Index Saving ============

  /**
   * Schedule a save operation (debounced).
   */
  scheduleSave(): void {
    if (this.isUserProvidedIndex) return;

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveIndex().catch((error) => {
        console.error("[IndexManager] Scheduled save failed:", error);
        this.kernel.eventBus.emit("index:error", { error: String(error), source: "indexManager" });
      });
    }, this.saveDebounceMs);
  }

  /**
   * Save index to disk immediately.
   */
  async saveIndex(): Promise<void> {
    if (this.isUserProvidedIndex) {
      console.log("[IndexManager] Skipping save: read-only index");
      return;
    }

    if (!this.activeIndexPath) {
      console.warn("[IndexManager] No active index path, cannot save");
      return;
    }

    if (!this.vectorStore.isDirty?.()) {
      return; // Nothing to save
    }

    try {
      const data = this.vectorStore.exportData?.();
      if (!data) {
        console.warn("[IndexManager] VectorStore.exportData() returned nothing");
        return;
      }

      await atomicWriteFile(this.activeIndexPath, JSON.stringify(data));
      this.vectorStore.clearDirty?.();

      const hnswFilename = this.getHnswFilenameForIndexPath(this.activeIndexPath);
      await this.vectorStore
        .persistNativeIndex?.({ hnswFilename })
        .catch((error) => console.warn("[IndexManager] Native index persist failed:", error));

      console.log(
        `[IndexManager] Saved ${data.meta.docCount} chunks, ${Object.keys(data.meta.state.notes).length} notes to ${path.basename(this.activeIndexPath)}`,
      );
    } catch (error) {
      console.error("[IndexManager] Failed to save index:", error);
      throw error;
    }
  }

  // ============ Path Management ============

  /**
   * Generate a new index path with v3 naming format.
   * Format: idx_{timestamp}_v{version}_{model}_{dim}d.json
   */
  private generateIndexPath(): string {
    const sanitizedKey = this.modelKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    const timestamp = formatIndexTimestamp();
    return path.join(
      this.kernel.storagePaths.pluginRoot,
      `idx_${timestamp}_v${INDEX_VERSION}_${sanitizedKey}_${this.dimension}d.json`,
    );
  }

  /** Get the active index path */
  getActiveIndexPath(): string | null {
    return this.activeIndexPath;
  }

  // ============ State Tracking (delegates to VectorStore) ============

  getNoteState(notePath: string): NoteState | null {
    return this.vectorStore.getNoteState?.(notePath) ?? null;
  }

  setNoteState(notePath: string, state: NoteState): void {
    this.vectorStore.setNoteState?.(notePath, state);
    this.scheduleSave();
  }

  removeNoteState(notePath: string): void {
    this.vectorStore.removeNoteState?.(notePath);
    this.scheduleSave();
  }

  needsReindex(notePath: string, mtimeMs: number, contentHash: string): boolean {
    const state = this.vectorStore.getNoteState?.(notePath);
    if (!state) return true;
    if (state.contentHash !== contentHash) return true;
    if (mtimeMs > state.embeddedAt) return true;
    return false;
  }

  getIndexedPaths(): string[] {
    return this.vectorStore.getIndexedPaths?.() ?? [];
  }

  getIndexedCount(): number {
    return this.vectorStore.getIndexedNoteCount?.() ?? 0;
  }

  isNoteIndexed(notePath: string): boolean {
    return this.vectorStore.isNoteIndexed?.(notePath) ?? false;
  }

  recordFullIndex(): void {
    this.vectorStore.recordFullIndex?.();
    this.scheduleSave();
  }

  getLastFullIndexAt(): number | null {
    return this.vectorStore.getLastFullIndexAt?.() ?? null;
  }

  getErrorCount(): number {
    return this.errorPaths.size;
  }

  recordError(notePath: string): void {
    this.errorPaths.add(notePath);
  }

  clearErrors(): void {
    this.errorPaths.clear();
  }

  async getStats(): Promise<IndexStats> {
    const chunkCount = await this.countChunks();
    const noteCount = this.getIndexedCount();
    const vaultNoteCount = this.kernel.obsidian.getMarkdownFiles().length;
    const lastFullIndexAt = this.getLastFullIndexAt();

    let state: IndexState;
    if (noteCount === 0 && chunkCount === 0) {
      state = "none";
    } else if (noteCount >= vaultNoteCount) {
      state = "complete";
    } else if (noteCount > 0) {
      state = "incomplete";
    } else {
      state = "stale";
    }

    const completionPercent =
      vaultNoteCount > 0 ? Math.round((noteCount / vaultNoteCount) * 100) : 0;

    return {
      exists: noteCount > 0 || chunkCount > 0,
      modelKey: this.modelKey || null,
      noteCount,
      chunkCount,
      vaultNoteCount,
      lastFullIndexAt,
      state,
      completionPercent,
    };
  }

  // ============ Vector Operations (delegates to store) ============

  async addChunks(chunks: EmbeddedChunk[]): Promise<void> {
    if (this.isUserProvidedIndex) {
      console.warn("[IndexManager] Cannot add chunks: read-only index");
      return;
    }
    await this.vectorStore.upsertChunks(chunks);
    this.scheduleSave();
  }

  async removeNote(notePath: string, noteId: string): Promise<void> {
    if (this.isUserProvidedIndex) {
      console.warn("[IndexManager] Cannot remove note: read-only index");
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

  isReadOnly(): boolean {
    return this.isUserProvidedIndex;
  }

  getDimension(): number {
    return this.dimension;
  }

  getActiveModelKey(): string {
    return this.modelKey;
  }

  // ============ Bulk Operations ============

  beginBulkUpdate(): void {
    if (this.isUserProvidedIndex) return;
    this.vectorStore.beginBulkUpdate?.();
  }

  async endBulkUpdate(): Promise<void> {
    if (this.isUserProvidedIndex) return;
    await this.vectorStore.endBulkUpdate?.();
    this.scheduleSave();
  }

  async clearAll(): Promise<void> {
    if (this.isUserProvidedIndex) {
      console.warn("[IndexManager] Cannot clear: read-only index");
      return;
    }
    await this.vectorStore.clearAll?.();
    this.vectorStore.clearState?.();
    this.scheduleSave();
  }

  // ============ Persistence ============

  async save(): Promise<void> {
    await this.saveIndex();
  }

  async dispose(): Promise<void> {
    // Cancel pending save
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    // Final save if dirty
    if (this.vectorStore.isDirty?.()) {
      await this.saveIndex();
    }

    await this.vectorStore.dispose();
  }

  // ============ Multi-Model Support ============

  /**
   * Discover available indices from plugin storage and system/index.
   * Static version for use during setup before full service initialization.
   */
  static async discoverIndices(storagePaths: {
    pluginRoot: string;
    systemIndex: string;
  }): Promise<DiscoveredIndex[]> {
    const results: DiscoveredIndex[] = [];

    const processIndexFile = async (
      filePath: string,
      source: "plugin" | "vault",
    ): Promise<DiscoveredIndex | null> => {
      const meta = await IndexManager.readIndexMeta(filePath);
      if (!meta) return null;

      const filename = path.basename(filePath);
      const parsed = parseIndexFilename(filename);

      let createdAt: Date | null = null;
      if (parsed?.timestamp) {
        createdAt = parseIndexTimestamp(parsed.timestamp);
      } else if (meta.createdAt) {
        createdAt = new Date(meta.createdAt);
      }

      let displayName: string;
      if (parsed && parsed.format !== "legacy") {
        const dateStr = createdAt
          ? createdAt.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })
          : "Unknown";
        displayName = `${meta.modelKey} (${dateStr})`;
      } else {
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
        isLegacy: parsed?.format === "legacy",
        displayName,
      };
    };

    // Scan Plugin Storage
    try {
      const pluginFiles = await fs.promises.readdir(storagePaths.pluginRoot);
      const indexFiles = pluginFiles.filter(
        (f) => (f.startsWith("idx_") || f.startsWith("index-")) && f.endsWith(".json"),
      );

      for (const file of indexFiles) {
        const filePath = path.join(storagePaths.pluginRoot, file);
        const idx = await processIndexFile(filePath, "plugin");
        if (idx) results.push(idx);
      }
    } catch (e) {
      console.warn("[IndexManager] Failed to scan plugin storage:", e);
    }

    // Scan Vault System Storage
    try {
      const sysPath = storagePaths.systemIndex;
      const dirExists = await fs.promises
        .access(sysPath)
        .then(() => true)
        .catch(() => false);

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

    // Sort: v3 > v2 > legacy, then by date
    results.sort((a, b) => {
      if (a.isLegacy !== b.isLegacy) return a.isLegacy ? 1 : -1;
      const aTime = a.createdAt?.getTime() ?? 0;
      const bTime = b.createdAt?.getTime() ?? 0;
      if (aTime !== bTime) return bTime - aTime;
      return a.modelKey.localeCompare(b.modelKey);
    });

    return results;
  }

  async discoverIndices(): Promise<DiscoveredIndex[]> {
    // Use cached results if available and fresh
    const now = Date.now();
    if (
      this.discoveryCache &&
      now - this.discoveryCache.timestamp < IndexManager.DISCOVERY_CACHE_TTL_MS
    ) {
      return this.discoveryCache.indices;
    }

    const indices = await IndexManager.discoverIndices(this.kernel.storagePaths);
    this.discoveryCache = { indices, timestamp: now };
    return indices;
  }

  /**
   * Clear the discovery cache (call after index operations that change the file list).
   */
  clearDiscoveryCache(): void {
    this.discoveryCache = null;
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
      // ignore
    }
    return null;
  }

  /**
   * Switch to a specific index path.
   */
  async switchToIndex(indexPath: string): Promise<void> {
    const meta = await IndexManager.readIndexMeta(indexPath);
    if (!meta) {
      this.kernel.obsidian.notice("Cannot switch: Index file not readable");
      return;
    }

    const isUserProvided =
      indexPath.includes("system/index") || indexPath.includes("system\\index");

    this.kernel.settings.indexing.activeIndexPath = indexPath;
    this.kernel.settings.indexing.activeIndexMeta = {
      modelKey: meta.modelKey,
      dimension: meta.dimension,
      isUserProvided,
    };
    await this.kernel.saveSettings();

    const label = isUserProvided ? `${meta.modelKey} (external)` : meta.modelKey;
    this.kernel.obsidian.notice(`Switching to ${label} index. Reloading plugin...`, 5000);

    setTimeout(() => {
      const app = this.kernel.obsidian.getApp();
      const pluginId = "notient";
      // @ts-expect-error - Obsidian internal API
      app.plugins.disablePlugin(pluginId).then(() => {
        // @ts-expect-error - Obsidian internal API
        app.plugins.enablePlugin(pluginId);
      });
    }, 500);
  }

  /**
   * Delete a specific index by its file path.
   */
  async deleteIndexByPath(indexPath: string): Promise<boolean> {
    const isExternal = indexPath.includes("system/index") || indexPath.includes("system\\index");
    if (isExternal) {
      console.warn("[IndexManager] Cannot delete user-provided index");
      return false;
    }

    if (this.activeIndexPath === indexPath) {
      await this.clearAll();
      this.clearDiscoveryCache();
      return true;
    }

    try {
      const exists = await fs.promises
        .access(indexPath)
        .then(() => true)
        .catch(() => false);

      if (exists) {
        await this.moveToDeleted(indexPath, "deleted");
      }

      this.clearDiscoveryCache();
      return true;
    } catch (error) {
      console.error("[IndexManager] Failed to delete index:", error);
      return false;
    }
  }

  /**
   * Trim stale entries - remove vectors for notes that no longer exist.
   */
  async trimIndex(): Promise<{ removed: number }> {
    if (this.isUserProvidedIndex) {
      return { removed: 0 };
    }

    const currentPaths = new Set(this.kernel.obsidian.getMarkdownFiles().map((f) => f.path));
    const indexedPaths = this.getIndexedPaths();

    let removed = 0;
    const stalePaths: string[] = [];

    for (const notePath of indexedPaths) {
      if (!currentPaths.has(notePath)) {
        stalePaths.push(notePath);
      }
    }

    for (const notePath of stalePaths) {
      const noteId = generateNoteId(notePath);
      await this.vectorStore.deleteByNoteId(noteId);
      this.vectorStore.removeNoteState?.(notePath);
      removed++;
    }

    if (removed > 0) {
      this.scheduleSave();
    }

    console.log(`[IndexManager] Trimmed ${removed} stale entries`);
    return { removed };
  }

  // ============ Export / Import ============

  async exportIndex(): Promise<string> {
    if (!this.activeIndexPath) {
      throw new Error("No active index to export");
    }

    const data = this.vectorStore.exportData?.();
    if (!data) {
      throw new Error("Failed to export index data");
    }

    return JSON.stringify({
      exportedAt: Date.now(),
      index: data,
    });
  }

  async importIndex(jsonData: string): Promise<{ modelKey: string; noteCount: number }> {
    try {
      const data = JSON.parse(jsonData) as {
        exportedAt: number;
        index: {
          meta: {
            modelKey: string;
            dimension: number;
            version?: number;
            state?: { lastFullIndexAt: number | null; notes: Record<string, unknown> };
          };
          docs: unknown[];
        };
        state?: { notes: Record<string, unknown> };
      };

      const importedModelKey = data.index.meta.modelKey;
      const importedDimension = data.index.meta.dimension;

      if (importedDimension && this.dimension && importedDimension !== this.dimension) {
        throw new Error(
          `Dimension mismatch: imported=${importedDimension}d, current=${this.dimension}d`,
        );
      }

      // Ensure state is embedded
      if (!data.index.meta.state && data.state) {
        data.index.meta.state = {
          lastFullIndexAt: null,
          notes: data.state.notes || {},
        };
        data.index.meta.version = INDEX_VERSION;
      }

      // Generate new filename
      const sanitizedKey = importedModelKey.replace(/[^a-zA-Z0-9_-]/g, "_");
      const timestamp = formatIndexTimestamp();
      const indexPath = path.join(
        this.kernel.storagePaths.pluginRoot,
        `idx_${timestamp}_v${INDEX_VERSION}_${sanitizedKey}_${importedDimension}d.json`,
      );

      await atomicWriteFile(indexPath, JSON.stringify(data.index));

      const noteCount = data.index.meta.state?.notes
        ? Object.keys(data.index.meta.state.notes).length
        : 0;

      this.clearDiscoveryCache();
      console.log(`[IndexManager] Imported index at ${indexPath}`);
      return { modelKey: importedModelKey, noteCount };
    } catch (error) {
      throw new Error(`Failed to import index: ${error}`);
    }
  }

  // ============ Private Methods ============

  private async moveToDeleted(filePath: string, reason: string): Promise<void> {
    if (this.isUserProvidedIndex) return;

    try {
      const deletedDir = path.join(this.kernel.storagePaths.pluginRoot, ".deleted");
      await fs.promises.mkdir(deletedDir, { recursive: true });
      const base = path.basename(filePath).replace(/\.json$/, "");
      const target = path.join(deletedDir, `${base}-${reason}-${Date.now()}.json`);
      await fs.promises.rename(filePath, target);
      console.log(`[IndexManager] Moved ${filePath} -> ${target}`);
    } catch (error) {
      console.warn("[IndexManager] Failed to move file:", error);
    }
  }

  // ============ Phase 2: Chunk/Embedding Separation ============

  /** Get the ChunkStore instance */
  getChunkStore(): ChunkStore {
    return this.chunkStore;
  }

  /** Check if using new separated structure */
  isUsingNewStructure(): boolean {
    return this.useNewStructure;
  }

  /**
   * Index a note with separated chunk and embedding storage.
   * Used by SimpleIndexer in Phase 2.
   */
  async indexNoteSeparated(
    noteId: string,
    notePath: string,
    mtimeMs: number,
    contentHash: string,
    chunks: NoteChunk[],
    embeddings: Array<{ chunkId: string; embedding: number[] }>,
  ): Promise<void> {
    if (this.isUserProvidedIndex) {
      console.warn("[IndexManager] Cannot index: read-only index");
      return;
    }

    // 1. Save chunks (model-agnostic) - strip runtime fields
    const storedChunks: StoredChunk[] = chunks.map(
      ({ mtimeMs: _m, contentHash: _c, ...rest }) => rest,
    );
    await this.chunkStore.saveNoteChunks(noteId, notePath, mtimeMs, contentHash, storedChunks);

    // 2. Save embeddings (model-specific) - build map for O(1) lookup
    const embeddingMap = new Map(embeddings.map((e) => [e.chunkId, e.embedding]));
    const embeddedChunks: EmbeddedChunk[] = chunks.map((chunk) => ({
      ...chunk,
      embedding: embeddingMap.get(chunk.chunkId) ?? [],
      modelKey: this.modelKey,
    }));

    await this.vectorStore.upsertChunks(embeddedChunks);
    this.scheduleSave();
  }

  /**
   * Remove a note using separated storage
   */
  async removeNoteSeparated(notePath: string, noteId: string): Promise<void> {
    if (this.isUserProvidedIndex) {
      console.warn("[IndexManager] Cannot remove note: read-only index");
      return;
    }

    // 1. Remove from vector store
    await this.vectorStore.deleteByNoteId(noteId);

    // 2. Remove chunks (moves to _deleted)
    await this.chunkStore.removeNoteChunks(noteId);

    // 3. Remove state
    this.removeNoteState(notePath);
  }

  // ============ Legacy Migration ============

  /** Check for legacy index files (idx_*.json in plugin root) */
  private async hasLegacyIndex(): Promise<boolean> {
    const pluginRoot = this.kernel.storagePaths.pluginRoot;
    try {
      const files = await fs.promises.readdir(pluginRoot);
      return files.some((f) => f.startsWith("idx_") && f.endsWith(".json"));
    } catch {
      return false;
    }
  }

  /** Find the best legacy index file */
  private async findLegacyIndex(): Promise<string | null> {
    const pluginRoot = this.kernel.storagePaths.pluginRoot;
    const sanitizedKey = this.modelKey.replace(/[^a-zA-Z0-9_-]/g, "_");

    try {
      const files = await fs.promises.readdir(pluginRoot);
      const indexFiles = files.filter((f) => f.startsWith("idx_") && f.endsWith(".json"));

      // Find best match for current model
      for (const file of indexFiles) {
        if (file.includes(sanitizedKey) && file.includes(`${this.dimension}d`)) {
          return path.join(pluginRoot, file);
        }
      }

      // Return any index if no model match
      if (indexFiles.length > 0) {
        return path.join(pluginRoot, indexFiles[0]);
      }
    } catch {
      // Ignore
    }

    return null;
  }

  /** Migrate legacy single-file index to new separated structure */
  private async migrateLegacyIndex(): Promise<void> {
    const legacyPath = await this.findLegacyIndex();
    if (!legacyPath) {
      console.log("[IndexManager] No legacy index to migrate");
      return;
    }

    console.log(`[IndexManager] Migrating legacy index: ${legacyPath}`);

    try {
      // 1. Read legacy data
      const content = await fs.promises.readFile(legacyPath, "utf-8");
      const legacy = JSON.parse(content) as {
        meta: {
          modelKey: string;
          dimension: number;
          state?: {
            lastFullIndexAt: number | null;
            notes: Record<string, { mtimeMs?: number; contentHash?: string }>;
          };
        };
        docs: Array<{
          chunkId: string;
          noteId: string;
          path: string;
          title: string;
          tier: string;
          kind: string;
          parentChunkId: string | null;
          headingPath: string[];
          text: string;
          blockRef: string | null;
          startLine: number | null;
          endLine: number | null;
          tokenEstimate: number;
          importance?: number;
          chunkIndex: number;
          embedding: number[];
          mtimeMs: number;
          contentHash: string;
          tags: string[];
          frontmatter: Record<string, unknown>;
        }>;
      };

      console.log(`[IndexManager] Legacy index has ${legacy.docs.length} chunks`);

      // 2. Ensure new directories
      await this.kernel.storagePaths.ensureNewDirectories();

      // 3. Group chunks by noteId
      const noteChunksMap = new Map<string, StoredChunk[]>();
      const noteMetaMap = new Map<string, { path: string; mtimeMs: number; contentHash: string }>();

      for (const doc of legacy.docs) {
        // Extract fields for StoredChunk (exclude embedding, mtimeMs, contentHash)
        const {
          embedding: _e,
          mtimeMs: docMtime,
          contentHash: docHash,
          tokenEstimate,
          tags,
          frontmatter,
          tier,
          kind,
          ...rest
        } = doc;

        const storedChunk: StoredChunk = {
          ...rest,
          tier: tier as StoredChunk["tier"],
          kind: kind as StoredChunk["kind"],
          tokenEstimate: tokenEstimate ?? 0,
          tags: tags ?? [],
          frontmatter: frontmatter ?? {},
        };

        if (!noteChunksMap.has(doc.noteId)) {
          noteChunksMap.set(doc.noteId, []);
        }
        noteChunksMap.get(doc.noteId)?.push(storedChunk);

        // Track note metadata (first chunk wins)
        if (!noteMetaMap.has(doc.noteId)) {
          const noteState = legacy.meta.state?.notes?.[doc.path];
          noteMetaMap.set(doc.noteId, {
            path: doc.path,
            mtimeMs: noteState?.mtimeMs ?? docMtime ?? Date.now(),
            contentHash: noteState?.contentHash ?? docHash ?? "",
          });
        }
      }

      // 4. Write chunk files
      console.log(`[IndexManager] Writing ${noteChunksMap.size} chunk files...`);
      for (const [noteId, chunks] of noteChunksMap) {
        const meta = noteMetaMap.get(noteId);
        if (!meta) continue; // Skip if metadata missing (shouldn't happen)
        await this.chunkStore.saveNoteChunks(
          noteId,
          meta.path,
          meta.mtimeMs,
          meta.contentHash,
          chunks,
        );
      }

      // 5. Move legacy file to archived
      const archivedPath = this.kernel.storagePaths.getArchivedEmbeddingPath(
        legacy.meta.modelKey,
        legacy.meta.dimension,
        formatIndexTimestamp(),
      );
      await fs.promises.mkdir(path.dirname(archivedPath), { recursive: true });
      await fs.promises.rename(legacyPath, archivedPath);
      console.log(`[IndexManager] Archived legacy index to: ${archivedPath}`);

      console.log("[IndexManager] Migration complete");
    } catch (error) {
      console.error("[IndexManager] Migration failed:", error);
      // Don't throw - let the system continue with existing index
    }
  }

  private async cleanupDeletedFolder(maxAgeDays = 7): Promise<void> {
    const deletedDir = path.join(this.kernel.storagePaths.pluginRoot, ".deleted");

    try {
      const exists = await fs.promises
        .access(deletedDir)
        .then(() => true)
        .catch(() => false);

      if (!exists) return;

      const files = await fs.promises.readdir(deletedDir);
      const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
      const now = Date.now();
      let cleaned = 0;

      for (const file of files) {
        const filePath = path.join(deletedDir, file);
        try {
          const stat = await fs.promises.stat(filePath);
          if (now - stat.mtimeMs > maxAgeMs) {
            await fs.promises.unlink(filePath);
            cleaned++;
          }
        } catch {
          // ignore
        }
      }

      if (cleaned > 0) {
        console.log(`[IndexManager] Cleaned ${cleaned} old files from .deleted`);
      }
    } catch {
      // ignore
    }
  }
}
