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

import * as fs from "fs";
import * as path from "path";
import type { Kernel } from "../core/kernel";
import type { VectorStore } from "./vectorStore";
import type { EmbeddedChunk, NoteChunk } from "../types/indexer";
import type { ChunkSearchResult, SearchOptions } from "../types/search";

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

/** Exported index state for UI */
export interface IndexStats {
  exists: boolean;
  modelKey: string | null;
  noteCount: number;
  chunkCount: number;
  lastFullIndexAt: number | null;
  indexingInProgress: boolean;
  indexingStartedAt: number | null;
  needsRecovery: boolean; // True if crash detected
}

/**
 * Index Manager - coordinates vector store and state tracking
 */
export class IndexManager {
  private states: Map<string, NoteState> = new Map();
  private modelKey: string = "";
  private lastFullIndexAt: number | null = null;
  private indexingInProgress = false;
  private indexingStartedAt: number | null = null;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private kernel: Kernel,
    private vectorStore: VectorStore
  ) {}

  async initialize(): Promise<void> {
    // Get model key from Ollama service
    const ollama = this.kernel.getService<{ getModelKey(): string }>("ollama");
    if (!ollama) {
      throw new Error("Ollama service not available");
    }
    this.modelKey = ollama.getModelKey();

    // Initialize vector store
    await this.vectorStore.initialize();

    // Load state file
    await this.loadState();
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

  /** Get index statistics for UI */
  async getStats(): Promise<IndexStats> {
    const chunkCount = await this.countChunks();
    
    // Detect crash: indexing was in progress but took > 30 minutes (stuck)
    const CRASH_THRESHOLD_MS = 30 * 60 * 1000;
    const needsRecovery = this.indexingInProgress && 
      this.indexingStartedAt !== null &&
      (Date.now() - this.indexingStartedAt) > CRASH_THRESHOLD_MS;

    return {
      exists: this.states.size > 0 || chunkCount > 0,
      modelKey: this.modelKey || null,
      noteCount: this.states.size,
      chunkCount,
      lastFullIndexAt: this.lastFullIndexAt,
      indexingInProgress: this.indexingInProgress,
      indexingStartedAt: this.indexingStartedAt,
      needsRecovery,
    };
  }

  // ============ Vector Operations (delegates to store) ============

  async addChunks(chunks: EmbeddedChunk[]): Promise<void> {
    await this.vectorStore.upsertChunks(chunks);
  }

  async removeNote(notePath: string, noteId: string): Promise<void> {
    await this.vectorStore.deleteByNoteId(noteId);
    this.removeNoteState(notePath);
  }

  async search(
    embedding: number[],
    options: SearchOptions
  ): Promise<ChunkSearchResult[]> {
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
    this.vectorStore.beginBulkUpdate?.();
  }

  async endBulkUpdate(): Promise<void> {
    await this.vectorStore.endBulkUpdate?.();
    await this.saveState();
  }

  async clearAll(): Promise<void> {
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

  listAvailableIndices(): string[] {
    try {
      const files = fs.readdirSync(this.kernel.storagePaths.pluginRoot);
      return files
        .filter((f) => f.startsWith("index-") && f.endsWith(".json"))
        .map((f) => f.replace("index-", "").replace(".json", ""));
    } catch {
      return [];
    }
  }

  // ============ Private Methods ============

  private getStatePath(): string {
    return path.join(
      this.kernel.storagePaths.pluginRoot,
      `state-${this.modelKey}.json`
    );
  }

  private async loadState(): Promise<void> {
    const statePath = this.getStatePath();

    try {
      const exists = await fs.promises
        .access(statePath)
        .then(() => true)
        .catch(() => false);
      if (!exists) return;

      const raw = await fs.promises.readFile(statePath, "utf-8");
      const data: StateFile = JSON.parse(raw);

      // Validate model key
      if (data.modelKey !== this.modelKey) {
        console.log("[IndexManager] Model key mismatch, starting fresh");
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
        console.log(`[IndexManager] Detected interrupted indexing from ${new Date(this.indexingStartedAt ?? 0).toISOString()}`);
      }

      console.log(`[IndexManager] Loaded state for ${this.states.size} notes`);
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
      await fs.promises.writeFile(statePath, JSON.stringify(data, null, 2));
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
}
