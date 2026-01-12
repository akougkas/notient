/**
 * HNSW Vector Store
 *
 * High-performance vector store using HNSW (Hierarchical Navigable Small World)
 * algorithm via WebAssembly. Provides O(log N) search instead of O(N) brute-force.
 *
 * Design:
 * - HNSW index stores embeddings with integer labels
 * - Separate Map stores document metadata (text, noteId, etc.)
 * - Both serialized together for persistence
 *
 * Performance targets:
 * - Search 10k chunks < 50ms (vs brute-force ~500ms)
 * - Memory overhead ~2x embedding size for graph structure
 */

import type { Kernel } from "../core/kernel";
import { ParaDetector } from "../core/para/detector";
import type { ChunkKind, ChunkTier, EmbeddedChunk, NoteChunk } from "../types/indexer";
import type { ChunkSearchResult, ParaType, SearchOptions } from "../types/search";
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

/** Note state for tracking indexed notes */
interface NoteState {
  path: string;
  mtimeMs: number;
  contentHash: string;
  chunkCount: number;
  embeddedAt: number;
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
    state: {
      lastFullIndexAt: number | null;
      notes: Record<string, NoteState>;
    };
  };
  docs: Array<StoredDoc & { embedding: number[]; label: number }>;
}

// ============================================================================
// HNSW Library Types (from hnswlib-wasm)
// ============================================================================

// Import types from hnswlib-wasm
import type { HierarchicalNSW, HnswlibModule } from "hnswlib-wasm";

type HNSWIndex = HierarchicalNSW;
type HNSWLib = HnswlibModule;

// ============================================================================
// HNSW Vector Store Implementation
// ============================================================================

/**
 * High-performance vector store using HNSW algorithm.
 * Provides O(log N) search via WebAssembly-based HNSW index.
 */
export class HNSWVectorStore implements VectorStore {
  private lib: HNSWLib | null = null;
  private index: HNSWIndex | null = null;
  private docs: Map<number, StoredDoc> = new Map();
  private chunkIdToLabel: Map<string, number> = new Map();
  private labelToChunkId: Map<number, string> = new Map();
  private noteIdToLabels: Map<string, Set<number>> = new Map();
  private embeddings: Map<number, Float32Array> = new Map();

  private dimension = 0;
  private modelKey = "";
  private createdAt = Date.now();
  private disposed = false;
  private dirty = false;
  private bulkDepth = 0;
  private paraDetector: ParaDetector;
  private initialized = false;

  // HNSW library ready state (async WASM loading)
  private isLibraryReady = false;
  private libraryReadyResolve!: () => void;
  private libraryReadyReject!: (error: Error) => void;
  private libraryReadyPromise: Promise<void>;

  // Note states
  private noteStates: Map<string, NoteState> = new Map();
  private lastFullIndexAt: number | null = null;

  constructor(private kernel: Kernel) {
    this.paraDetector = new ParaDetector(kernel.settings);
    // Set up promise that resolves when HNSW lib is ready (or rejects on failure)
    this.libraryReadyPromise = new Promise<void>((resolve, reject) => {
      this.libraryReadyResolve = resolve;
      this.libraryReadyReject = reject;
    });
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
      // Dynamic import of WASM module
      const { loadHnswlib } = await import("hnswlib-wasm");
      this.lib = await loadHnswlib();
      this.initialized = true;
      this.isLibraryReady = true;
      // Resolve the ready promise so waitForReady() callers can proceed
      this.libraryReadyResolve();
      console.log("[HNSWVectorStore] HNSW library loaded");
    } catch (error) {
      console.error("[HNSWVectorStore] Failed to load HNSW library:", error);
      const initError = error instanceof Error ? error : new Error(String(error));
      this.libraryReadyReject(initError);
      throw new Error(`HNSW initialization failed: ${error}`);
    }
  }

  /**
   * Wait for HNSW library to be ready.
   * Used by IndexManager to ensure lib is loaded before calling loadFromData().
   */
  async waitForReady(): Promise<void> {
    if (this.isLibraryReady) return;
    await this.libraryReadyPromise;
  }

  private ensureIndex(mode: "init" | "load" = "init"): void {
    if (!this.lib) {
      throw new Error("HNSW library not initialized");
    }
    if (!this.index && this.dimension > 0) {
      // Constructor: (spaceName, numDimensions, autoSaveFilename)
      // Empty string for autoSaveFilename disables auto-save
      this.index = new this.lib.HierarchicalNSW(HNSW_CONFIG.metric, this.dimension, "");
      if (mode === "init") {
        // initIndex: (maxElements, m, efConstruction, randomSeed)
        this.index.initIndex(
          HNSW_CONFIG.initialMaxElements,
          HNSW_CONFIG.M,
          HNSW_CONFIG.efConstruction,
          100, // random seed
        );
        this.index.setEfSearch(HNSW_CONFIG.efSearch);
        console.log(
          `[HNSWVectorStore] Index created: ${this.dimension}d, M=${HNSW_CONFIG.M}, ef=${HNSW_CONFIG.efSearch}`,
        );
      }
    }
  }

  // ============ Data Transfer API ============

  private async syncFs(read: boolean): Promise<void> {
    if (!this.lib) return;
    await new Promise<void>((resolve, reject) => {
      try {
        this.lib?.EmscriptenFileSystemManager.syncFS(read, () => resolve());
      } catch (error) {
        reject(error);
      }
    });
  }

  async persistNativeIndex(options: { hnswFilename: string }): Promise<void> {
    if (this.disposed) return;
    if (!this.lib || !this.index) return;
    if (!options.hnswFilename) return;

    try {
      console.log(`[HNSWVectorStore] Persisting native index: ${options.hnswFilename}`);
      await this.syncFs(true).catch(() => {});
      await this.index.writeIndex(options.hnswFilename);
      await this.syncFs(false);
      console.log("[HNSWVectorStore] Native index persisted successfully");
    } catch (error) {
      console.warn("[HNSWVectorStore] Failed to persist native index:", error);
    }
  }

  async loadFromDataAsync(
    data: {
      meta: {
        modelKey: string;
        dimension: number;
        createdAt: number;
        updatedAt: number;
      };
      docs: Array<{
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
        embedding: number[];
        label?: number;
        mtimeMs: number;
        contentHash: string;
        tags: string[];
        frontmatter: Record<string, unknown>;
      }>;
      state?: {
        lastFullIndexAt: number | null;
        notes: Record<string, NoteState>;
      };
    },
    options?: { hnswFilename?: string },
  ): Promise<void> {
    this.modelKey = data.meta.modelKey;
    this.dimension = data.meta.dimension;
    this.createdAt = data.meta.createdAt || Date.now();

    // Clear existing data
    this.docs.clear();
    this.chunkIdToLabel.clear();
    this.labelToChunkId.clear();
    this.noteIdToLabels.clear();
    this.embeddings.clear();

    // Reset native index instance so we can readIndex() into a fresh object
    this.index = null;

    const hnswFilename = options?.hnswFilename ?? null;

    // Timing metrics for profiling
    const timings = { syncFs: 0, readIndex: 0, metadata: 0, state: 0 };

    // Attempt fast-path: load HNSW graph from IDBFS, then only hydrate JS-side metadata maps.
    if (hnswFilename && this.lib) {
      try {
        let start = performance.now();
        await this.syncFs(true);
        timings.syncFs = performance.now() - start;

        const exists = this.lib.EmscriptenFileSystemManager.checkFileExists(hnswFilename);
        console.log(`[HNSWVectorStore] Native index check: file=${hnswFilename}, exists=${exists}`);
        if (exists) {
          const index = new this.lib.HierarchicalNSW(HNSW_CONFIG.metric, this.dimension, "");
          this.index = index;
          const maxElements = Math.max(HNSW_CONFIG.initialMaxElements, data.docs.length);

          start = performance.now();
          const ok = await index.readIndex(hnswFilename, maxElements);
          timings.readIndex = performance.now() - start;
          console.log(
            `[HNSWVectorStore] Native index read: ok=${ok}, time=${Math.round(timings.readIndex)}ms`,
          );

          if (ok) {
            index.setEfSearch(HNSW_CONFIG.efSearch);

            // Process metadata in batches to prevent UI freeze
            start = performance.now();
            const BATCH_SIZE = 1000;
            const totalDocs = data.docs.length;

            for (let batchStart = 0; batchStart < totalDocs; batchStart += BATCH_SIZE) {
              const batchEnd = Math.min(batchStart + BATCH_SIZE, totalDocs);

              // Process batch
              for (let i = batchStart; i < batchEnd; i++) {
                const persisted = data.docs[i];
                const embedding = new Float32Array(persisted.embedding);
                const label = typeof persisted.label === "number" ? persisted.label : i;

                const doc: StoredDoc = {
                  chunkId: persisted.chunkId,
                  noteId: persisted.noteId,
                  path: persisted.path,
                  title: persisted.title,
                  headingPath: persisted.headingPath,
                  tier: persisted.tier,
                  kind: persisted.kind,
                  parentChunkId: persisted.parentChunkId,
                  blockRef: persisted.blockRef,
                  startLine: persisted.startLine,
                  endLine: persisted.endLine,
                  tokenEstimate: persisted.tokenEstimate,
                  importance: persisted.importance,
                  chunkIndex: persisted.chunkIndex,
                  text: persisted.text,
                  mtimeMs: persisted.mtimeMs,
                  contentHash: persisted.contentHash,
                  tags: persisted.tags,
                  frontmatter: persisted.frontmatter,
                };

                this.docs.set(label, doc);
                this.chunkIdToLabel.set(persisted.chunkId, label);
                this.labelToChunkId.set(label, persisted.chunkId);
                this.embeddings.set(label, embedding);

                if (!this.noteIdToLabels.has(persisted.noteId)) {
                  this.noteIdToLabels.set(persisted.noteId, new Set());
                }
                this.noteIdToLabels.get(persisted.noteId)?.add(label);
              }

              // Yield to event loop between batches for UI responsiveness
              if (batchEnd < totalDocs) {
                await new Promise((resolve) => setTimeout(resolve, 0));
              }
            }
            timings.metadata = performance.now() - start;

            // Load state
            start = performance.now();
            this.noteStates.clear();
            this.lastFullIndexAt = null;
            if (data.state) {
              this.lastFullIndexAt = data.state.lastFullIndexAt;
              for (const [notePath, state] of Object.entries(data.state.notes)) {
                this.noteStates.set(notePath, state);
              }
            }
            timings.state = performance.now() - start;

            this.dirty = false;
            const total = Math.round(
              timings.syncFs + timings.readIndex + timings.metadata + timings.state,
            );
            console.log(
              `[HNSWVectorStore] Loaded ${this.docs.size} chunks in ${total}ms (syncFs=${Math.round(timings.syncFs)}ms, readIndex=${Math.round(timings.readIndex)}ms, metadata=${Math.round(timings.metadata)}ms, state=${Math.round(timings.state)}ms)`,
            );
            return;
          }
        }
      } catch (error) {
        console.warn("[HNSWVectorStore] Native index load failed, falling back:", error);
      }
    }

    // Slow-path: rebuild from embeddings (synchronous, can block). Kept for compatibility + migration.
    console.log(
      "[HNSWVectorStore] Using slow-path: rebuilding index from embeddings (this will take 30+ seconds)",
    );
    this.index = null;
    this.loadFromData(data);

    // Best-effort persist for the next startup
    if (hnswFilename) {
      await this.persistNativeIndex({ hnswFilename });
    }
  }

  loadFromData(data: {
    meta: {
      modelKey: string;
      dimension: number;
      createdAt: number;
      updatedAt: number;
    };
    docs: Array<{
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
      embedding: number[];
      mtimeMs: number;
      contentHash: string;
      tags: string[];
      frontmatter: Record<string, unknown>;
    }>;
    state?: {
      lastFullIndexAt: number | null;
      notes: Record<string, NoteState>;
    };
  }): void {
    this.modelKey = data.meta.modelKey;
    this.dimension = data.meta.dimension;
    this.createdAt = data.meta.createdAt || Date.now();

    // Clear existing data
    this.docs.clear();
    this.chunkIdToLabel.clear();
    this.labelToChunkId.clear();
    this.noteIdToLabels.clear();
    this.embeddings.clear();

    // Ensure index is created
    this.ensureIndex();

    if (!this.index) {
      console.error("[HNSWVectorStore] Index not available for loading");
      return;
    }

    // Prepare vectors and metadata
    const vectors: Float32Array[] = [];
    const docMetadata: Array<{ persisted: (typeof data.docs)[0]; embedding: Float32Array }> = [];

    for (const persisted of data.docs) {
      const embedding = new Float32Array(persisted.embedding);
      vectors.push(embedding);
      docMetadata.push({ persisted, embedding });
    }

    // Batch add to HNSW index - returns assigned labels
    if (vectors.length > 0) {
      let assignedLabels: number[];
      try {
        assignedLabels = this.index.addItems(vectors, false);
      } catch (error) {
        console.error("[HNSWVectorStore] Failed to load index:", error);
        return;
      }

      // Store metadata with assigned labels
      for (let i = 0; i < docMetadata.length; i++) {
        const { persisted, embedding } = docMetadata[i];
        const label = assignedLabels[i];

        const doc: StoredDoc = {
          chunkId: persisted.chunkId,
          noteId: persisted.noteId,
          path: persisted.path,
          title: persisted.title,
          headingPath: persisted.headingPath,
          tier: persisted.tier,
          kind: persisted.kind,
          parentChunkId: persisted.parentChunkId,
          blockRef: persisted.blockRef,
          startLine: persisted.startLine,
          endLine: persisted.endLine,
          tokenEstimate: persisted.tokenEstimate,
          importance: persisted.importance,
          chunkIndex: persisted.chunkIndex,
          text: persisted.text,
          mtimeMs: persisted.mtimeMs,
          contentHash: persisted.contentHash,
          tags: persisted.tags,
          frontmatter: persisted.frontmatter,
        };

        this.docs.set(label, doc);
        this.chunkIdToLabel.set(persisted.chunkId, label);
        this.labelToChunkId.set(label, persisted.chunkId);
        this.embeddings.set(label, embedding);

        // Track noteId -> labels
        if (!this.noteIdToLabels.has(persisted.noteId)) {
          this.noteIdToLabels.set(persisted.noteId, new Set());
        }
        this.noteIdToLabels.get(persisted.noteId)?.add(label);
      }
    }

    // Load state
    this.noteStates.clear();
    this.lastFullIndexAt = null;

    if (data.state) {
      this.lastFullIndexAt = data.state.lastFullIndexAt;
      for (const [notePath, state] of Object.entries(data.state.notes)) {
        this.noteStates.set(notePath, state);
      }
    }

    this.dirty = false;
    console.log(
      `[HNSWVectorStore] Loaded ${this.docs.size} chunks, ${this.noteStates.size} note states`,
    );
  }

  exportData(): {
    meta: {
      version: number;
      modelKey: string;
      dimension: number;
      docCount: number;
      createdAt: number;
      updatedAt: number;
      chunker: { name: string; version: number };
      tiers: { note: boolean; section: boolean; block: boolean };
      state: {
        lastFullIndexAt: number | null;
        notes: Record<string, NoteState>;
      };
    };
    docs: Array<{
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
      embedding: number[];
      label?: number;
      mtimeMs: number;
      contentHash: string;
      tags: string[];
      frontmatter: Record<string, unknown>;
    }>;
  } {
    const persistedDocs: Array<{
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
      embedding: number[];
      label?: number;
      mtimeMs: number;
      contentHash: string;
      tags: string[];
      frontmatter: Record<string, unknown>;
    }> = [];

    for (const [label, doc] of this.docs) {
      const embedding = this.embeddings.get(label);
      if (!embedding) continue;

      persistedDocs.push({
        ...doc,
        embedding: Array.from(embedding),
        label,
      });
    }

    return {
      meta: {
        version: INDEX_VERSION,
        modelKey: this.modelKey,
        dimension: this.dimension,
        docCount: persistedDocs.length,
        createdAt: this.createdAt,
        updatedAt: Date.now(),
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

    this.ensureIndex();
    if (!this.index) throw new Error("Index not initialized");

    // Remove existing chunks for affected notes (unless in bulk mode)
    if (this.bulkDepth === 0) {
      const noteIds = new Set(chunks.map((c) => c.noteId));
      for (const noteId of noteIds) {
        this.removeNoteChunks(noteId);
      }
    }

    // Grow index if needed
    const currentMax = this.index.getMaxElements();
    const needed = this.docs.size + chunks.length;
    if (needed > currentMax) {
      const newMax = Math.max(needed * 2, currentMax * 2);
      this.index.resizeIndex(newMax);
      console.log(`[HNSWVectorStore] Resized index to ${newMax} elements`);
    }

    // Prepare chunks for batch insert
    const validChunks: Array<{ chunk: EmbeddedChunk; embedding: Float32Array }> = [];
    for (const chunk of chunks) {
      if (!this.validateEmbedding(chunk.embedding)) {
        console.warn(`[HNSWVectorStore] Invalid embedding for ${chunk.path}`);
        continue;
      }
      validChunks.push({ chunk, embedding: new Float32Array(chunk.embedding) });
    }

    if (validChunks.length === 0) return;

    // Batch add embeddings to HNSW index - it returns the labels
    const embeddings = validChunks.map((v) => v.embedding);
    let assignedLabels: number[];
    try {
      // addItems returns the labels assigned to each item
      // replaceDeleted=true allows reusing deleted labels
      assignedLabels = this.index.addItems(embeddings, true);
    } catch (error) {
      console.error("[HNSWVectorStore] Failed to add batch:", error);
      return;
    }

    // Store metadata for each chunk
    for (let i = 0; i < validChunks.length; i++) {
      const { chunk, embedding } = validChunks[i];
      const label = assignedLabels[i];

      const doc: StoredDoc = {
        chunkId: chunk.chunkId,
        noteId: chunk.noteId,
        path: chunk.path,
        title: chunk.title,
        headingPath: chunk.headingPath,
        tier: chunk.tier,
        kind: chunk.kind,
        parentChunkId: chunk.parentChunkId,
        blockRef: chunk.blockRef,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        tokenEstimate: chunk.tokenEstimate,
        importance: chunk.importance,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        mtimeMs: chunk.mtimeMs,
        contentHash: chunk.contentHash,
        tags: chunk.tags,
        frontmatter: chunk.frontmatter,
      };

      // Store in maps
      this.docs.set(label, doc);
      this.chunkIdToLabel.set(chunk.chunkId, label);
      this.labelToChunkId.set(label, chunk.chunkId);
      this.embeddings.set(label, embedding);

      // Track noteId -> labels
      if (!this.noteIdToLabels.has(chunk.noteId)) {
        this.noteIdToLabels.set(chunk.noteId, new Set());
      }
      this.noteIdToLabels.get(chunk.noteId)?.add(label);
    }

    this.dirty = true;
  }

  async deleteByNoteId(noteId: string): Promise<void> {
    if (this.disposed) return;
    this.removeNoteChunks(noteId);
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
      this.removeNoteChunks(noteId);
    }

    this.dirty = true;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Search Helpers
  // ──────────────────────────────────────────────────────────────────────────

  /** Build pre-filter valid labels set */
  private buildValidLabels(options: SearchOptions): Set<number> {
    const allowedTiers = options.tier
      ? new Set(Array.isArray(options.tier) ? options.tier : [options.tier])
      : null;
    const allowedNoteIds = options.noteIds?.length ? new Set(options.noteIds) : null;

    const validLabels = new Set<number>();
    for (const [label, doc] of this.docs) {
      if (allowedTiers && !allowedTiers.has(doc.tier)) continue;
      if (allowedNoteIds && !allowedNoteIds.has(doc.noteId)) continue;
      validLabels.add(label);
    }
    return validLabels;
  }

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

  /** Process a single neighbor and return a result if valid, null otherwise */
  private processNeighbor(
    label: number,
    distance: number,
    queryTerms: string[],
    options: SearchOptions,
    perNoteCounts: Map<string, number>,
  ): ChunkSearchResult | null {
    if (label < 0) return null;

    const doc = this.docs.get(label);
    if (!doc) return null;

    const score = this.calculateBoostedScore(1 - distance, doc, queryTerms);
    if (score < options.minScore) return null;

    const paraType = this.paraDetector.detectType(doc.path);
    if (!this.passesPostFilters(doc, options, paraType)) return null;

    if (typeof options.maxPerNote === "number" && options.maxPerNote > 0) {
      const current = perNoteCounts.get(doc.noteId) ?? 0;
      if (current >= options.maxPerNote) return null;
      perNoteCounts.set(doc.noteId, current + 1);
    }

    return this.buildSearchResult(doc, score, paraType, options.includeContent ?? false);
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
   * Search using HNSW algorithm - O(log N) complexity.
   */
  async search(queryEmbedding: number[], options: SearchOptions): Promise<ChunkSearchResult[]> {
    if (this.disposed || this.docs.size === 0 || !this.index) return [];

    const query = new Float32Array(queryEmbedding);
    const validLabels = this.buildValidLabels(options);
    const filterFn =
      validLabels.size < this.docs.size ? (label: number) => validLabels.has(label) : undefined;
    const searchK = Math.min(options.topK * 3, this.docs.size);

    let neighbors: number[];
    let distances: number[];

    try {
      const result = this.index.searchKnn(query, searchK, filterFn);
      neighbors = result.neighbors;
      distances = result.distances;
    } catch (error) {
      console.warn("[HNSWVectorStore] Search failed:", error);
      return [];
    }

    const queryTerms = this.extractQueryTerms(options.queryText);
    const results: ChunkSearchResult[] = [];
    const perNoteCounts = new Map<string, number>();

    for (let i = 0; i < neighbors.length && results.length < options.topK; i++) {
      const result = this.processNeighbor(
        neighbors[i],
        distances[i],
        queryTerms,
        options,
        perNoteCounts,
      );
      if (result) results.push(result);
    }

    return results;
  }

  async getChunksByNoteId(noteId: string): Promise<NoteChunk[]> {
    if (this.disposed) return [];

    const labels = this.noteIdToLabels.get(noteId);
    if (!labels) return [];

    const chunks: NoteChunk[] = [];
    for (const label of labels) {
      const doc = this.docs.get(label);
      if (doc) {
        chunks.push({
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
          importance: doc.importance,
          chunkIndex: doc.chunkIndex,
          text: doc.text,
          mtimeMs: doc.mtimeMs,
          contentHash: doc.contentHash,
          tags: doc.tags,
          frontmatter: doc.frontmatter,
        });
      }
    }

    return chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  async countChunks(): Promise<number> {
    return this.docs.size;
  }

  async countNotes(): Promise<number> {
    return this.noteIdToLabels.size;
  }

  isReady(): boolean {
    return !this.disposed && this.dimension > 0 && this.initialized;
  }

  beginBulkUpdate(): void {
    this.bulkDepth++;
  }

  async endBulkUpdate(): Promise<void> {
    this.bulkDepth = Math.max(0, this.bulkDepth - 1);
  }

  async clearAll(): Promise<void> {
    this.docs.clear();
    this.chunkIdToLabel.clear();
    this.labelToChunkId.clear();
    this.noteIdToLabels.clear();
    this.embeddings.clear();

    // Recreate index
    if (this.lib && this.dimension > 0) {
      this.index = new this.lib.HierarchicalNSW(HNSW_CONFIG.metric, this.dimension, "");
      this.index.initIndex(
        HNSW_CONFIG.initialMaxElements,
        HNSW_CONFIG.M,
        HNSW_CONFIG.efConstruction,
        100,
      );
      this.index.setEfSearch(HNSW_CONFIG.efSearch);
    }

    this.dirty = true;
  }

  async flush(): Promise<void> {
    // No-op: IndexManager handles persistence
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.docs.clear();
    this.chunkIdToLabel.clear();
    this.labelToChunkId.clear();
    this.noteIdToLabels.clear();
    this.embeddings.clear();
    this.index = null;
    this.lib = null;
  }

  // ============ Private Methods ============

  private removeNoteChunks(noteId: string): void {
    const labels = this.noteIdToLabels.get(noteId);
    if (!labels) return;

    const labelsToDelete: number[] = [];
    for (const label of labels) {
      const doc = this.docs.get(label);
      if (doc) {
        this.chunkIdToLabel.delete(doc.chunkId);
        this.labelToChunkId.delete(label);
      }
      this.docs.delete(label);
      this.embeddings.delete(label);
      labelsToDelete.push(label);
    }

    // Mark as deleted in HNSW (soft delete) - batch delete
    if (this.index && labelsToDelete.length > 0) {
      try {
        this.index.markDeleteItems(labelsToDelete);
      } catch {
        // Try individual deletes if batch fails
        for (const label of labelsToDelete) {
          try {
            this.index.markDelete(label);
          } catch {
            // Label might not exist in index
          }
        }
      }
    }

    this.noteIdToLabels.delete(noteId);
  }

  private validateEmbedding(embedding: number[]): boolean {
    return (
      Array.isArray(embedding) &&
      embedding.length === this.dimension &&
      embedding.every((n) => typeof n === "number" && !Number.isNaN(n))
    );
  }
}
