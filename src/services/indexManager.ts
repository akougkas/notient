import type { DatabaseService } from "../core/db/database";
import type { Kernel } from "../core/kernel";
import type { EmbeddedChunk, NoteChunk } from "../types/indexer";
import type { ChunkSearchResult, SearchOptions } from "../types/search";
import type { VectorStore } from "./vectorStore";

/** Exported index state for UI */
export interface IndexStats {
  exists: boolean;
  modelKey: string | null;
  noteCount: number;
  chunkCount: number;
  vaultNoteCount: number;
  lastFullIndexAt: number | null;
  state: "none" | "complete" | "incomplete" | "stale";
  completionPercent: number;
}

/**
 * Index Manager - coordinates vector store and database.
 */
export class IndexManager {
  private modelKey = "";
  private dimension = 0;
  private db: DatabaseService;
  private errorPaths: Set<string> = new Set();

  // Save scheduling
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveDebounceMs = 10000; // 10s debounce

  constructor(
    private kernel: Kernel,
    private vectorStore: VectorStore,
  ) {
    const db = kernel.getService<DatabaseService>("database");
    if (!db) throw new Error("DatabaseService not available");
    this.db = db;
  }

  async initialize(): Promise<void> {
    const startTime = performance.now();

    // Stage 1: Get model info
    console.log("[IndexManager] Stage 1/3: Getting model info...");
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

    // Stage 2: Initialize vector store (load native or rehydrate)
    console.log("[IndexManager] Stage 2/3: Loading vector index...");
    await this.vectorStore.initialize();

    // Try loading native HNSW index
    const nativeFilename = "hnsw.bin";

    await this.vectorStore.loadFromDataAsync?.(
      {
        meta: {
          modelKey: this.modelKey,
          dimension: this.dimension,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        docs: [],
      },
      { hnswFilename: nativeFilename },
    );

    // Check if store is populated
    const chunkCount = await this.vectorStore.countChunks();
    if (chunkCount === 0) {
      const dbCount = await this.countEmbeddingsInDb();
      if (dbCount > 0) {
        console.log(
          `[IndexManager] Native index empty, but DB has ${dbCount} embeddings. Rehydrating...`,
        );
        await this.rehydrateFromDb();
      }
    }

    // Stage 3: Ready
    const noteCount = this.vectorStore.getIndexedNoteCount?.() ?? 0;
    const elapsed = Math.round(performance.now() - startTime);
    console.log(`[IndexManager] Initialized: ${noteCount} notes in ${elapsed}ms`);
  }

  private async countEmbeddingsInDb(): Promise<number> {
    const res = await this.db.db
      .selectFrom("embeddings")
      .select(this.db.db.fn.count("chunk_id").as("count"))
      .where("model_key", "=", this.modelKey)
      .executeTakeFirst();
    return Number(res?.count || 0);
  }

  private async rehydrateFromDb(): Promise<void> {
    const BATCH_SIZE = 2000;
    let offset = 0;

    while (true) {
      const rows = await this.db.db
        .selectFrom("embeddings")
        .select(["chunk_id", "vector"])
        .where("model_key", "=", this.modelKey)
        .limit(BATCH_SIZE)
        .offset(offset)
        .execute();

      if (rows.length === 0) break;

      // biome-ignore lint/suspicious/noExplicitAny: wrapper format
      const docs = rows.map((row) => ({
        chunkId: row.chunk_id,
        embedding: Array.from(row.vector),
        noteId: "",
        path: "",
        text: "",
        tier: "block",
        kind: "paragraph",
        headingPath: [],
        mtimeMs: 0,
        contentHash: "",
        tags: [],
        frontmatter: {},
      }));

      await this.vectorStore.loadFromDataAsync?.({
        meta: { modelKey: this.modelKey, dimension: this.dimension, createdAt: 0, updatedAt: 0 },
        docs: docs as any,
      });

      offset += rows.length;
      console.log(`[IndexManager] Rehydrated ${offset} vectors...`);
    }

    await this.vectorStore.persistNativeIndex?.({ hnswFilename: "hnsw.bin" });
  }

  // ============ Index Saving ============

  scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveIndex().catch((error) => {
        console.error("[IndexManager] Scheduled save failed:", error);
      });
    }, this.saveDebounceMs);
  }

  async saveIndex(): Promise<void> {
    if (!this.vectorStore.isDirty?.()) {
      return;
    }

    try {
      console.log("[IndexManager] Saving index...");
      await this.db.save();
      await this.vectorStore.persistNativeIndex?.({ hnswFilename: "hnsw.bin" });
      this.vectorStore.clearDirty?.();
      console.log("[IndexManager] Save complete");
    } catch (error) {
      console.error("[IndexManager] Failed to save index:", error);
      throw error;
    }
  }

  // ============ State Tracking ============

  // biome-ignore lint/suspicious/noExplicitAny: State type
  getNoteState(notePath: string): any | null {
    return this.vectorStore.getNoteState?.(notePath) ?? null;
  }

  // biome-ignore lint/suspicious/noExplicitAny: State type
  setNoteState(notePath: string, state: any): void {
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
    if (Math.abs(state.mtimeMs - mtimeMs) > 1000) return true;
    if (state.contentHash !== contentHash) return true;
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

  // ============ Stats & Export ============

  async getStats(): Promise<IndexStats> {
    const chunkCount = await this.countChunks();
    const noteCount = this.getIndexedCount();
    const vaultNoteCount = this.kernel.obsidian.getMarkdownFiles().length;
    const lastFullIndexAt = this.getLastFullIndexAt();

    let state: IndexStats["state"];
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

  async exportIndex(): Promise<string> {
    return JSON.stringify({
      exportedAt: Date.now(),
      info: "Binary index export not supported in JSON format",
    });
  }

  async importIndex(jsonData: string): Promise<{ modelKey: string; noteCount: number }> {
    throw new Error("JSON import not supported with SQLite backend");
  }

  // ============ Vector Operations ============

  async addChunks(chunks: EmbeddedChunk[]): Promise<void> {
    await this.vectorStore.upsertChunks(chunks);
    this.scheduleSave();
  }

  async removeNote(notePath: string, _noteId: string): Promise<void> {
    await this.vectorStore.deleteByPath(notePath);
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
    return false;
  }

  getDimension(): number {
    return this.dimension;
  }

  getActiveModelKey(): string {
    return this.modelKey;
  }

  // ============ Bulk Operations ============

  beginBulkUpdate(): void {
    this.vectorStore.beginBulkUpdate?.();
  }

  async endBulkUpdate(): Promise<void> {
    await this.vectorStore.endBulkUpdate?.();
    this.scheduleSave();
  }

  async clearAll(): Promise<void> {
    await this.vectorStore.clearAll?.();
    this.vectorStore.clearState?.();
    this.scheduleSave();
  }

  // ============ Persistence ============

  async save(): Promise<void> {
    await this.saveIndex();
  }

  async dispose(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.vectorStore.isDirty?.()) {
      await this.saveIndex();
    }
    // vectorStore disposed by Kernel
  }

  // ============ Compatibility / Error Tracking ============

  getErrorCount(): number {
    return this.errorPaths.size;
  }

  recordError(path: string): void {
    this.errorPaths.add(path);
  }

  clearErrors(): void {
    this.errorPaths.clear();
  }

  isUsingNewStructure(): boolean {
    return true;
  }

  async indexNoteSeparated(
    _noteId: string,
    _notePath: string,
    _mtimeMs: number,
    _contentHash: string,
    chunks: NoteChunk[],
    embeddings: Array<{ chunkId: string; embedding: number[] }>,
  ): Promise<void> {
    // Map embeddings to chunks
    const embeddingMap = new Map(embeddings.map((e) => [e.chunkId, e.embedding]));
    const embeddedChunks: EmbeddedChunk[] = chunks.map((chunk) => ({
      ...chunk,
      embedding: embeddingMap.get(chunk.chunkId) ?? [],
      modelKey: this.modelKey,
    }));
    await this.vectorStore.upsertChunks(embeddedChunks);
    this.scheduleSave();
  }

  async removeNoteSeparated(notePath: string, noteId: string): Promise<void> {
    await this.removeNote(notePath, noteId);
  }

  // ============ Compatibility Stubs ============
  // These methods exist for UI compatibility but return empty results
  // since SQLite backend has no JSON indices to discover or switch between.

  static async discoverIndices(_storagePaths: unknown): Promise<never[]> {
    return [];
  }

  async discoverIndices(): Promise<never[]> {
    return [];
  }

  async switchToIndex(_indexPath: string): Promise<void> {
    // No-op: SQLite backend has single unified index
  }

  async trimIndex(): Promise<{ removed: number }> {
    return { removed: 0 };
  }

  async deleteIndexByPath(_path: string): Promise<boolean> {
    return false;
  }
}
