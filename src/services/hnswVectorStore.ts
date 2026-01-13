/**
 * HNSW Vector Store
 *
 * High-performance vector store using HNSW (Hierarchical Navigable Small World)
 * algorithm via Web Worker. Provides O(log N) search instead of O(N) brute-force.
 *
 * Design:
 * - Worker manages HNSW index (integer labels <-> embeddings)
 * - Main thread stores document metadata (text, noteId, etc.) in Maps
 * - Bridge handles communication
 *
 * Performance targets:
 * - Search 10k chunks < 50ms (vs brute-force ~500ms)
 * - Main thread non-blocking
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { VectorWorkerBridge } from "../core/vector/workerBridge";
import type { Kernel } from "../core/kernel";
import { ParaDetector } from "../core/para/detector";
import type { ChunkKind, ChunkTier, EmbeddedChunk, NoteChunk } from "../types/indexer";
import type { ChunkSearchResult, ParaType, SearchOptions } from "../types/search";
import { atomicWriteFile } from "../utils/atomicWrite";
import type { VectorStore, VectorStoreInitOptions } from "./vectorStore";

// ============================================================================
// HNSW Configuration
// ============================================================================

/** HNSW algorithm parameters - tuned for vault-size datasets (10k-100k chunks) */
const HNSW_CONFIG = {
  /** Number of bi-directional links per node (12-48 recommended) */
  M: 16,
  /** Index construction quality (higher = better quality, slower build) */
  efConstruction: 200,
  /** Default search quality (higher = more accurate, slower search) */
  efSearch: 100,
  /** Distance metric: 'l2' (euclidean) or 'cosine' */
  metric: "cosine" as const,
  /** Max elements to initialize with (can grow) */
  initialMaxElements: 50000,
};

/** Index file version - must match IndexManager expectations (v3) */
const INDEX_VERSION = 3;

// ============================================================================
// Types
// ============================================================================

/** Document metadata stored alongside HNSW index */
interface StoredDoc {
  chunkId: string;
  noteId: string;
  path: string;
  title: string;
  headingPath: string[];
  tier: ChunkTier;
  kind: ChunkKind;
  parentChunkId: string | null;
  blockRef: string | null;
  startLine: number | null;
  endLine: number | null;
  tokenEstimate: number;
  importance?: number;
  chunkIndex: number;
  text: string;
  mtimeMs: number;
  contentHash: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
}

/** Persisted doc format with embedding */
type PersistedDoc = StoredDoc & { embedding: number[]; label?: number };

/** Note state for tracking indexed notes */
interface NoteState {
  path: string;
  mtimeMs: number;
  contentHash: string;
  chunkCount: number;
  embeddedAt: number;
}

/** Persisted state format */
interface PersistedState {
  lastFullIndexAt: number | null;
  notes: Record<string, NoteState>;
}

/** Persisted index format */
interface PersistedIndex {
  meta: {
    version: number;
    modelKey: string;
    dimension: number;
    docCount: number;
    createdAt: number;
    updatedAt: number;
    hnswConfig: typeof HNSW_CONFIG;
    chunker: { name: string; version: number };
    tiers: { note: boolean; section: boolean; block: boolean };
    state: PersistedState;
  };
  docs: PersistedDoc[];
}

// ============================================================================
// HNSW Vector Store Implementation
// ============================================================================

/**
 * High-performance vector store using HNSW algorithm via Web Worker.
 */
export class HNSWVectorStore implements VectorStore {
  private bridge: VectorWorkerBridge;
  private docs: Map<string, StoredDoc> = new Map(); // chunkId -> Doc
  private noteIdToChunkIds: Map<string, Set<string>> = new Map();
  // We don't store embeddings in main thread anymore to save memory,
  // unless we need them for export.
  // BUT: exportData() requires them.
  // So we MUST store them or request them from worker (which is slow/complex).
  // For now, let's keep them in main thread for export support, but they are duplicated in worker.
  private embeddings: Map<string, Float32Array> = new Map();

  private dimension = 0;
  private modelKey = "";
  private createdAt = Date.now();
  private disposed = false;
  private dirty = false;
  private bulkDepth = 0;
  private paraDetector: ParaDetector;
  private initialized = false;

  // Note states
  private noteStates: Map<string, NoteState> = new Map();
  private lastFullIndexAt: number | null = null;

  constructor(private kernel: Kernel) {
    this.paraDetector = new ParaDetector(kernel.settings);
    this.bridge = new VectorWorkerBridge();
  }

  // ============ Internal Helpers ============

  /** Clear all document maps */
  private clearMaps(): void {
    this.docs.clear();
    this.noteIdToChunkIds.clear();
    this.embeddings.clear();
  }

  /** Extract StoredDoc fields from a source object */
  private extractStoredDoc(source: StoredDoc | EmbeddedChunk): StoredDoc {
    return {
      chunkId: source.chunkId,
      noteId: source.noteId,
      path: source.path,
      title: source.title,
      headingPath: source.headingPath,
      tier: source.tier,
      kind: source.kind,
      parentChunkId: source.parentChunkId,
      blockRef: source.blockRef,
      startLine: source.startLine,
      endLine: source.endLine,
      tokenEstimate: source.tokenEstimate,
      importance: source.importance,
      chunkIndex: source.chunkIndex,
      text: source.text,
      mtimeMs: source.mtimeMs,
      contentHash: source.contentHash,
      tags: source.tags,
      frontmatter: source.frontmatter,
    };
  }

  /** Store a doc in maps */
  private storeDoc(doc: StoredDoc, embedding: Float32Array): void {
    this.docs.set(doc.chunkId, doc);
    this.embeddings.set(doc.chunkId, embedding);

    let chunkIds = this.noteIdToChunkIds.get(doc.noteId);
    if (!chunkIds) {
      chunkIds = new Set();
      this.noteIdToChunkIds.set(doc.noteId, chunkIds);
    }
    chunkIds.add(doc.chunkId);
  }

  // ============ Configuration ============

  setModelConfig(modelKey: string, dimension: number): void {
    this.modelKey = modelKey;
    this.dimension = dimension;
    console.log(`[HNSWVectorStore] Model config set: ${modelKey}, ${dimension}d`);
  }

  // ============ State API ============

  getNoteState(notePath: string): NoteState | null {
    return this.noteStates.get(notePath) ?? null;
  }

  setNoteState(notePath: string, state: NoteState): void {
    this.noteStates.set(notePath, state);
    this.dirty = true;
  }

  removeNoteState(notePath: string): void {
    this.noteStates.delete(notePath);
    this.dirty = true;
  }

  getIndexedPaths(): string[] {
    return Array.from(this.noteStates.keys());
  }

  getIndexedNoteCount(): number {
    return this.noteStates.size;
  }

  isNoteIndexed(notePath: string): boolean {
    return this.noteStates.has(notePath);
  }

  getLastFullIndexAt(): number | null {
    return this.lastFullIndexAt;
  }

  recordFullIndex(): void {
    this.lastFullIndexAt = Date.now();
    this.dirty = true;
  }

  clearState(): void {
    this.noteStates.clear();
    this.lastFullIndexAt = null;
    this.dirty = true;
  }

  // ============ Dirty Tracking ============

  isDirty(): boolean {
    return this.dirty;
  }

  clearDirty(): void {
    this.dirty = false;
  }

  // ============ Initialization ============

  async initialize(_options?: VectorStoreInitOptions): Promise<void> {
    if (this.disposed) return;
    if (this.initialized) return;

    try {
      await this.bridge.init(HNSW_CONFIG);
      this.initialized = true;
      console.log("[HNSWVectorStore] Worker initialized");
    } catch (error) {
      console.error("[HNSWVectorStore] Failed to initialize worker:", error);
      throw error;
    }
  }

  async waitForReady(): Promise<void> {
    // Bridge init handles waiting
    if (!this.initialized) {
      await this.initialize();
    }
  }

  // ============ Data Transfer API ============

  async persistNativeIndex(options: { hnswFilename: string }): Promise<void> {
    if (this.disposed) return;
    if (!options.hnswFilename) return;

    try {
      console.log(`[HNSWVectorStore] Persisting native index to ${options.hnswFilename}`);
      const data = await this.bridge.save();
      
      const filePath = path.join(this.kernel.storagePaths.pluginRoot, options.hnswFilename);
      // Write buffer to disk
      const tempPath = `${filePath}.tmp`;
      await fs.promises.writeFile(tempPath, new Uint8Array(data));
      await fs.promises.rename(tempPath, filePath);
      
      console.log("[HNSWVectorStore] Native index persisted successfully");
    } catch (error) {
      console.warn("[HNSWVectorStore] Failed to persist native index:", error);
    }
  }

  private hydrateDoc(persisted: PersistedDoc): void {
    const embedding = new Float32Array(persisted.embedding);
    this.storeDoc(this.extractStoredDoc(persisted), embedding);
  }

  private async hydrateDocsAsync(docs: PersistedIndex["docs"]): Promise<void> {
    const BATCH_SIZE = 1000;
    for (let i = 0; i < docs.length; i++) {
      this.hydrateDoc(docs[i]);
      if (i > 0 && i % BATCH_SIZE === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  private loadState(state: PersistedState | undefined): void {
    this.noteStates.clear();
    this.lastFullIndexAt = state?.lastFullIndexAt ?? null;
    if (state?.notes) {
      for (const [path, noteState] of Object.entries(state.notes)) {
        this.noteStates.set(path, noteState);
      }
    }
  }

  private async tryLoadNativeIndex(hnswFilename: string): Promise<boolean> {
    const filePath = path.join(this.kernel.storagePaths.pluginRoot, hnswFilename);
    
    try {
      await fs.promises.access(filePath);
    } catch {
      return false;
    }

    try {
      const buffer = await fs.promises.readFile(filePath);
      // Convert to ArrayBuffer
      const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      
      this.bridge.load(arrayBuffer);
      return true;
    } catch (error) {
      console.warn("[HNSWVectorStore] Native index load failed:", error);
      return false;
    }
  }

  private setMetaFromData(meta: { modelKey: string; dimension: number; createdAt: number }): void {
    this.modelKey = meta.modelKey;
    this.dimension = meta.dimension;
    this.createdAt = meta.createdAt || Date.now();
  }

  async loadFromDataAsync(
    data: {
      meta: { modelKey: string; dimension: number; createdAt: number };
      docs: PersistedDoc[];
      state?: PersistedState;
    },
    options?: { hnswFilename?: string },
  ): Promise<void> {
    this.setMetaFromData(data.meta);
    this.clearMaps();

    // Re-init bridge with new dimension if needed? 
    // The worker handles dimension change on load.
    
    // Initialize metadata first
    await this.hydrateDocsAsync(data.docs);
    this.loadState(data.state);
    
    const hnswFilename = options?.hnswFilename ?? null;

    // Fast path: load native HNSW
    if (hnswFilename) {
      const loaded = await this.tryLoadNativeIndex(hnswFilename);
      if (loaded) {
        this.dirty = false;
        console.log(`[HNSWVectorStore] Fast-path loaded ${this.docs.size} chunks`);
        return;
      }
    }

    // Slow path: rebuild
    console.log("[HNSWVectorStore] Rebuilding index from embeddings...");
    
    const items = data.docs.map(doc => ({
      id: doc.chunkId,
      embedding: new Float32Array(doc.embedding)
    }));
    
    await this.bridge.addItems(items);

    if (hnswFilename) {
      await this.persistNativeIndex({ hnswFilename });
    }
    
    this.dirty = false;
  }

  // Legacy loadFromData support for interface compatibility
  loadFromData(data: any): void {
    // This shouldn't be called if loadFromDataAsync is used by IndexManager
    console.warn("[HNSWVectorStore] Sync loadFromData called - using async fallback");
    this.loadFromDataAsync(data).catch(e => console.error(e));
  }

  exportData(): { meta: PersistedIndex["meta"]; docs: PersistedDoc[] } {
    const persistedDocs: PersistedDoc[] = [];

    for (const [chunkId, doc] of this.docs) {
      const embedding = this.embeddings.get(chunkId);
      if (embedding) {
        persistedDocs.push({ ...doc, embedding: Array.from(embedding) });
      }
    }

    return {
      meta: {
        version: INDEX_VERSION,
        modelKey: this.modelKey,
        dimension: this.dimension,
        docCount: persistedDocs.length,
        createdAt: this.createdAt,
        updatedAt: Date.now(),
        hnswConfig: HNSW_CONFIG,
        chunker: { name: "tiered-semantic", version: 1 },
        tiers: { note: true, section: true, block: true },
        state: {
          lastFullIndexAt: this.lastFullIndexAt,
          notes: Object.fromEntries(this.noteStates),
        },
      },
      docs: persistedDocs,
    };
  }

  // ============ Vector Operations ============

  async upsertChunks(chunks: EmbeddedChunk[]): Promise<void> {
    if (this.disposed) throw new Error("Store disposed");
    if (chunks.length === 0) return;

    // Remove existing chunks for affected notes (unless in bulk mode)
    if (this.bulkDepth === 0) {
      const noteIds = new Set(chunks.map((c) => c.noteId));
      for (const noteId of noteIds) {
        // We can't synchronously remove from worker, but we can mark deleted
        // Or just let the worker handle duplicates? 
        // HNSW doesn't handle duplicates well usually, better to delete old ones.
        // But we don't know the IDs of old chunks for these notes unless we look them up.
        await this.removeNoteChunks(noteId);
      }
    }

    const validChunks = chunks.filter((c) => this.validateEmbedding(c.embedding));
    if (validChunks.length === 0) return;

    // Prepare items for worker
    const items = validChunks.map(c => ({
      id: c.chunkId,
      embedding: new Float32Array(c.embedding)
    }));

    await this.bridge.addItems(items);

    // Store metadata
    for (const chunk of validChunks) {
      this.storeDoc(
        this.extractStoredDoc(chunk),
        new Float32Array(chunk.embedding)
      );
    }

    this.dirty = true;
  }

  async deleteByNoteId(noteId: string): Promise<void> {
    if (this.disposed) return;
    await this.removeNoteChunks(noteId);
    this.dirty = true;
  }

  async deleteByPathPrefix(prefix: string): Promise<void> {
    if (this.disposed) return;

    const noteIdsToRemove = new Set<string>();
    for (const doc of this.docs.values()) {
      if (doc.path.startsWith(prefix)) {
        noteIdsToRemove.add(doc.noteId);
      }
    }

    for (const noteId of noteIdsToRemove) {
      await this.removeNoteChunks(noteId);
    }

    this.dirty = true;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Search Helpers
  // ──────────────────────────────────────────────────────────────────────────

  /** Calculate lexical-boosted score */
  private calculateBoostedScore(baseScore: number, doc: StoredDoc, queryTerms: string[]): number {
    if (queryTerms.length === 0) return baseScore;

    const LEXICAL_BOOST = 0.15;
    const TITLE_BOOST = 0.25;

    const textLower = doc.text.toLowerCase();
    const titleLower = doc.title.toLowerCase();
    const pathLower = doc.path.toLowerCase();

    const titleMatch = queryTerms.some(
      (term) => titleLower.includes(term) || pathLower.includes(term),
    );
    if (titleMatch) return Math.min(0.99, baseScore + TITLE_BOOST);

    const textMatch = queryTerms.some((term) => textLower.includes(term));
    if (textMatch) return Math.min(0.99, baseScore + LEXICAL_BOOST);

    return baseScore;
  }

  /** Check if document passes post-filters */
  private passesPostFilters(doc: StoredDoc, options: SearchOptions, paraType: string): boolean {
    if (options.paraType && paraType !== options.paraType) return false;
    if (options.folderPaths?.length) {
      if (!options.folderPaths.some((p) => doc.path.startsWith(p))) return false;
    }
    if (options.tags?.length) {
      if (!options.tags.some((t) => doc.tags.includes(t))) return false;
    }
    return true;
  }

  /** Build search result from document */
  private buildSearchResult(
    doc: StoredDoc,
    score: number,
    paraType: ParaType,
    includeContent: boolean,
  ): ChunkSearchResult {
    return {
      chunkId: doc.chunkId,
      noteId: doc.noteId,
      path: doc.path,
      title: doc.title,
      headingPath: doc.headingPath,
      tier: doc.tier,
      kind: doc.kind,
      parentChunkId: doc.parentChunkId,
      blockRef: doc.blockRef,
      startLine: doc.startLine,
      endLine: doc.endLine,
      tokenEstimate: doc.tokenEstimate,
      text: includeContent ? doc.text : "",
      score,
      paraType,
    };
  }

  /** Extract query terms from query text */
  private extractQueryTerms(queryText: string | undefined): string[] {
    if (!queryText) return [];
    return queryText
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 2);
  }

  /**
   * Search using HNSW algorithm via worker.
   */
  async search(queryEmbedding: number[], options: SearchOptions): Promise<ChunkSearchResult[]> {
    if (this.disposed) return [];

    const query = new Float32Array(queryEmbedding);
    
    // We request more candidates because we apply post-filtering in main thread
    const k = options.topK * 4; 
    
    const rawResults = await this.bridge.search(query, k);
    
    const queryTerms = this.extractQueryTerms(options.queryText);
    const results: ChunkSearchResult[] = [];
    const perNoteCounts = new Map<string, number>();

    for (const { id, score: rawScore } of rawResults) {
      if (results.length >= options.topK) break;

      const doc = this.docs.get(id);
      if (!doc) continue;

      const score = this.calculateBoostedScore(rawScore, doc, queryTerms);
      if (score < options.minScore) continue;

      const paraType = this.paraDetector.detectType(doc.path);
      if (!this.passesPostFilters(doc, options, paraType)) continue;

      if (typeof options.maxPerNote === "number" && options.maxPerNote > 0) {
        const current = perNoteCounts.get(doc.noteId) ?? 0;
        if (current >= options.maxPerNote) continue;
        perNoteCounts.set(doc.noteId, current + 1);
      }

      results.push(this.buildSearchResult(doc, score, paraType, options.includeContent ?? false));
    }

    return results;
  }

  async getChunksByNoteId(noteId: string): Promise<NoteChunk[]> {
    if (this.disposed) return [];

    const chunkIds = this.noteIdToChunkIds.get(noteId);
    if (!chunkIds) return [];

    const chunks: NoteChunk[] = [];
    for (const id of chunkIds) {
      const doc = this.docs.get(id);
      if (doc) chunks.push(this.extractStoredDoc(doc));
    }

    return chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  async countChunks(): Promise<number> {
    return this.docs.size;
  }

  async countNotes(): Promise<number> {
    return this.noteIdToChunkIds.size;
  }

  isReady(): boolean {
    return !this.disposed && this.initialized;
  }

  beginBulkUpdate(): void {
    this.bulkDepth++;
  }

  async endBulkUpdate(): Promise<void> {
    this.bulkDepth = Math.max(0, this.bulkDepth - 1);
  }

  async clearAll(): Promise<void> {
    this.clearMaps();
    // Re-init worker to clear
    await this.bridge.init(HNSW_CONFIG);
    this.dirty = true;
  }

  async flush(): Promise<void> {
    // No-op: IndexManager handles persistence
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearMaps();
    this.bridge.terminate();
  }

  // ============ Private Methods ============

  private async removeNoteChunks(noteId: string): Promise<void> {
    const chunkIds = this.noteIdToChunkIds.get(noteId);
    if (!chunkIds) return;

    const idsToDelete = Array.from(chunkIds);
    this.bridge.markDeleted(idsToDelete);

    for (const id of idsToDelete) {
      this.docs.delete(id);
      this.embeddings.delete(id);
    }
    this.noteIdToChunkIds.delete(noteId);
  }

  private validateEmbedding(embedding: number[]): boolean {
    return (
      Array.isArray(embedding) &&
      embedding.length === this.dimension &&
      embedding.every((n) => typeof n === "number" && !Number.isNaN(n))
    );
  }
}