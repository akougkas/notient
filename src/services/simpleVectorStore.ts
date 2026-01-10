/**
 * Simple Vector Store
 *
 * Lightweight in-memory vector store.
 * Uses brute-force cosine similarity - fast enough for <100K vectors.
 *
 * Design goals:
 * - Zero native dependencies (works in Electron/Obsidian)
 * - Simple API, easy to understand
 * - Fast search (<50ms for 50K vectors)
 * - Pure in-memory - IndexManager handles all file I/O
 * - Multi-model support via separate index files
 */

import type { Kernel } from "../core/kernel";
import { ParaDetector } from "../core/para/detector";
import type { EmbeddedChunk, NoteChunk } from "../types/indexer";
import type { ChunkSearchResult, SearchOptions } from "../types/search";
import type { VectorStore } from "./vectorStore";

/**
 * Index file version. Bump when format changes.
 * v3: Embedded state (no separate state file), new naming schema
 */
const INDEX_VERSION = 3;
const CHUNKER_META = { name: "tiered-semantic", version: 1 } as const;
const TIER_FLAGS = { note: true, section: true, block: true } as const;

/** Internal document structure - stored in memory */
interface StoredDoc {
  chunkId: string;
  noteId: string;
  path: string;
  title: string;
  headingPath: string[];
  tier: NoteChunk["tier"];
  kind: NoteChunk["kind"];
  parentChunkId: string | null;
  blockRef: string | null;
  startLine: number | null;
  endLine: number | null;
  tokenEstimate: number;
  importance?: number;
  chunkIndex: number;
  text: string;
  embedding: Float32Array;
  mtimeMs: number;
  contentHash: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
}

/** Persisted format - embedding as regular array for JSON */
interface PersistedDoc {
  chunkId: string;
  noteId: string;
  path: string;
  title: string;
  headingPath: string[];
  tier: NoteChunk["tier"];
  kind: NoteChunk["kind"];
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
}

/** State for a single indexed note (embedded in index file) */
export interface EmbeddedNoteState {
  path: string;
  mtimeMs: number;
  contentHash: string;
  chunkCount: number;
  embeddedAt: number;
}

/** Embedded state section in index file */
export interface EmbeddedIndexState {
  lastFullIndexAt: number | null;
  notes: Record<string, EmbeddedNoteState>;
}

/**
 * Simple vector store with brute-force cosine similarity.
 * Pure in-memory - IndexManager handles all file I/O.
 */
export class SimpleVectorStore implements VectorStore {
  private docs: Map<string, StoredDoc> = new Map();
  private noteIdToChunkIds: Map<string, Set<string>> = new Map();
  private dimension = 0;
  private modelKey = "";
  private createdAt = Date.now();
  private disposed = false;
  private dirty = false;
  private bulkDepth = 0;
  private paraDetector: ParaDetector;

  // ============ Embedded State (v3) ============
  /** Note states - tracked in memory, persisted by IndexManager */
  private noteStates: Map<string, EmbeddedNoteState> = new Map();
  /** Last full index timestamp */
  private lastFullIndexAt: number | null = null;

  constructor(private kernel: Kernel) {
    this.paraDetector = new ParaDetector(kernel.settings);
  }

  // ============ Configuration ============

  /**
   * Set model configuration (called by IndexManager before loadFromData or for fresh index).
   */
  setModelConfig(modelKey: string, dimension: number): void {
    this.modelKey = modelKey;
    this.dimension = dimension;
    console.log(`[SimpleVectorStore] Model config set: ${modelKey}, ${dimension}d`);
  }

  // ============ State API ============

  /** Get state for a note */
  getNoteState(notePath: string): EmbeddedNoteState | null {
    return this.noteStates.get(notePath) ?? null;
  }

  /** Set state for a note */
  setNoteState(notePath: string, state: EmbeddedNoteState): void {
    this.noteStates.set(notePath, state);
    this.dirty = true;
  }

  /** Remove state for a note */
  removeNoteState(notePath: string): void {
    this.noteStates.delete(notePath);
    this.dirty = true;
  }

  /** Get all indexed note paths */
  getIndexedPaths(): string[] {
    return Array.from(this.noteStates.keys());
  }

  /** Get count of indexed notes */
  getIndexedNoteCount(): number {
    return this.noteStates.size;
  }

  /** Check if a note is indexed */
  isNoteIndexed(notePath: string): boolean {
    return this.noteStates.has(notePath);
  }

  /** Get last full index timestamp */
  getLastFullIndexAt(): number | null {
    return this.lastFullIndexAt;
  }

  /** Record that a full index completed */
  recordFullIndex(): void {
    this.lastFullIndexAt = Date.now();
    this.dirty = true;
  }

  /** Clear all state (for rebuild) */
  clearState(): void {
    this.noteStates.clear();
    this.lastFullIndexAt = null;
    this.dirty = true;
  }

  // ============ Dirty Tracking ============

  /** Check if store needs saving */
  isDirty(): boolean {
    return this.dirty;
  }

  /** Clear dirty flag after successful save */
  clearDirty(): void {
    this.dirty = false;
  }

  // ============ Data Transfer API (for IndexManager) ============

  /**
   * Load data from parsed index file.
   * Called by IndexManager after reading and parsing JSON.
   */
  loadFromData(data: {
    meta: {
      modelKey: string;
      dimension: number;
      createdAt: number;
      updatedAt: number;
    };
    docs: PersistedDoc[];
    state?: EmbeddedIndexState;
  }): void {
    // Set model config from loaded data
    this.modelKey = data.meta.modelKey;
    this.dimension = data.meta.dimension;
    this.createdAt = data.meta.createdAt || Date.now();

    // Load documents
    this.docs.clear();
    this.noteIdToChunkIds.clear();

    for (const persisted of data.docs) {
      const doc: StoredDoc = {
        ...persisted,
        embedding: new Float32Array(persisted.embedding),
      };
      this.docs.set(doc.chunkId, doc);

      if (!this.noteIdToChunkIds.has(doc.noteId)) {
        this.noteIdToChunkIds.set(doc.noteId, new Set());
      }
      this.noteIdToChunkIds.get(doc.noteId)?.add(doc.chunkId);
    }

    // Load embedded state (v3)
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
      `[SimpleVectorStore] Loaded ${this.docs.size} chunks, ${this.noteStates.size} note states`,
    );
  }

  /**
   * Export current data for persistence.
   * Called by IndexManager when saving to disk.
   */
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
      state: EmbeddedIndexState;
    };
    docs: PersistedDoc[];
  } {
    // Convert to persisted format
    const persistedDocs: PersistedDoc[] = [];
    for (const doc of this.docs.values()) {
      persistedDocs.push({
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
        embedding: Array.from(doc.embedding),
        mtimeMs: doc.mtimeMs,
        contentHash: doc.contentHash,
        tags: doc.tags,
        frontmatter: doc.frontmatter,
      });
    }

    // Build embedded state
    const embeddedState: EmbeddedIndexState = {
      lastFullIndexAt: this.lastFullIndexAt,
      notes: Object.fromEntries(this.noteStates),
    };

    return {
      meta: {
        version: INDEX_VERSION,
        modelKey: this.modelKey,
        dimension: this.dimension,
        docCount: persistedDocs.length,
        createdAt: this.createdAt,
        updatedAt: Date.now(),
        chunker: CHUNKER_META,
        tiers: TIER_FLAGS,
        state: embeddedState,
      },
      docs: persistedDocs,
    };
  }

  // ============ Initialization ============

  /**
   * Initialize the vector store.
   * Now simplified - just validates model config is set.
   * File loading is done by IndexManager calling loadFromData().
   */
  async initialize(): Promise<void> {
    if (this.disposed) return;

    // Model config should be set by IndexManager before this
    if (!this.modelKey || !this.dimension) {
      console.log("[SimpleVectorStore] Initialized (empty, waiting for loadFromData)");
    } else {
      console.log(`[SimpleVectorStore] Initialized for ${this.modelKey}, ${this.dimension}d`);
    }
  }

  // ============ Vector Operations ============

  /**
   * Upsert chunks - replaces existing chunks for the same note
   */
  async upsertChunks(chunks: EmbeddedChunk[]): Promise<void> {
    if (this.disposed) throw new Error("Store disposed");
    if (chunks.length === 0) return;

    // Remove existing chunks for affected notes (unless in bulk mode)
    if (this.bulkDepth === 0) {
      const noteIds = new Set(chunks.map((c) => c.noteId));
      for (const noteId of noteIds) {
        this.removeNoteChunks(noteId);
      }
    }

    // Insert new chunks
    for (const chunk of chunks) {
      if (!this.validateEmbedding(chunk.embedding)) {
        console.warn(`[SimpleVectorStore] Invalid embedding for ${chunk.path}`);
        continue;
      }

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
        embedding: new Float32Array(chunk.embedding),
        mtimeMs: chunk.mtimeMs,
        contentHash: chunk.contentHash,
        tags: chunk.tags,
        frontmatter: chunk.frontmatter,
      };

      this.docs.set(chunk.chunkId, doc);

      // Track noteId -> chunkIds mapping
      if (!this.noteIdToChunkIds.has(chunk.noteId)) {
        this.noteIdToChunkIds.set(chunk.noteId, new Set());
      }
      this.noteIdToChunkIds.get(chunk.noteId)?.add(chunk.chunkId);
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

  /**
   * Search using brute-force cosine similarity with hybrid lexical boost.
   * For 50K vectors, this takes ~10-20ms - well within target.
   */
  async search(queryEmbedding: number[], options: SearchOptions): Promise<ChunkSearchResult[]> {
    if (this.disposed || this.docs.size === 0) return [];

    const query = new Float32Array(queryEmbedding);
    const queryNorm = this.magnitude(query);
    if (queryNorm === 0) return [];

    const allowedTiers = options.tier
      ? new Set(Array.isArray(options.tier) ? options.tier : [options.tier])
      : null;
    const allowedNoteIds = options.noteIds?.length ? new Set(options.noteIds) : null;

    // Hybrid search: prepare query terms for lexical matching
    const queryTerms = options.queryText
      ? options.queryText
          .toLowerCase()
          .split(/\s+/)
          .filter((t) => t.length >= 2)
      : [];

    // Score all documents
    const scored: Array<{ doc: StoredDoc; score: number; lexicalMatch: boolean }> = [];

    // Minimum text length for full score - shorter texts get penalized
    const MIN_TEXT_LENGTH = 50;
    const LENGTH_PENALTY_FACTOR = 0.3;

    // Lexical boost for hybrid search
    const LEXICAL_BOOST = 0.15;
    const TITLE_BOOST = 0.25;

    for (const doc of this.docs.values()) {
      // Tier + noteId prefilter (fast reject before cosine)
      if (allowedTiers && !allowedTiers.has(doc.tier)) continue;
      if (allowedNoteIds && !allowedNoteIds.has(doc.noteId)) continue;

      let score = this.cosineSimilarity(query, queryNorm, doc.embedding);
      let lexicalMatch = false;

      // Apply length penalty for very short chunks
      if (doc.text.length < MIN_TEXT_LENGTH) {
        const lengthRatio = doc.text.length / MIN_TEXT_LENGTH;
        const penalty = 1 - LENGTH_PENALTY_FACTOR * (1 - lengthRatio);
        score = score * penalty;
      }

      // Apply lexical boost for hybrid search
      if (queryTerms.length > 0) {
        const textLower = doc.text.toLowerCase();
        const titleLower = doc.title.toLowerCase();
        const pathLower = doc.path.toLowerCase();

        const textMatch = queryTerms.some((term) => textLower.includes(term));
        const titleMatch = queryTerms.some(
          (term) => titleLower.includes(term) || pathLower.includes(term),
        );

        if (titleMatch) {
          score = Math.min(0.99, score + TITLE_BOOST);
          lexicalMatch = true;
        } else if (textMatch) {
          score = Math.min(0.99, score + LEXICAL_BOOST);
          lexicalMatch = true;
        }
      }

      if (score >= options.minScore) {
        scored.push({ doc, score, lexicalMatch });
      }
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Apply filters and build results
    const results: ChunkSearchResult[] = [];
    const perNoteCounts: Map<string, number> = new Map();

    for (const { doc, score } of scored) {
      if (results.length >= options.topK) break;

      const paraType = this.paraDetector.detectType(doc.path);

      // Filter by PARA type
      if (options.paraType && paraType !== options.paraType) continue;

      // Filter by folder paths
      if (options.folderPaths?.length) {
        const matches = options.folderPaths.some((p) => doc.path.startsWith(p));
        if (!matches) continue;
      }

      // Filter by tags
      if (options.tags?.length) {
        const hasTag = options.tags.some((t) => doc.tags.includes(t));
        if (!hasTag) continue;
      }

      // Enforce per-note cap
      if (typeof options.maxPerNote === "number" && options.maxPerNote > 0) {
        const current = perNoteCounts.get(doc.noteId) ?? 0;
        if (current >= options.maxPerNote) continue;
        perNoteCounts.set(doc.noteId, current + 1);
      }

      results.push({
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
        text: options.includeContent ? doc.text : "",
        score,
        paraType,
      });
    }

    return results;
  }

  async getChunksByNoteId(noteId: string): Promise<NoteChunk[]> {
    if (this.disposed) return [];

    const chunkIds = this.noteIdToChunkIds.get(noteId);
    if (!chunkIds) return [];

    const chunks: NoteChunk[] = [];
    for (const chunkId of chunkIds) {
      const doc = this.docs.get(chunkId);
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
    return this.noteIdToChunkIds.size;
  }

  isReady(): boolean {
    return !this.disposed && this.dimension > 0;
  }

  beginBulkUpdate(): void {
    this.bulkDepth++;
  }

  async endBulkUpdate(): Promise<void> {
    this.bulkDepth = Math.max(0, this.bulkDepth - 1);
    // Note: actual save is triggered by IndexManager checking isDirty()
  }

  async clearAll(): Promise<void> {
    this.docs.clear();
    this.noteIdToChunkIds.clear();
    this.dirty = true;
  }

  async flush(): Promise<void> {
    // No-op: IndexManager handles persistence
    // This method exists for interface compatibility
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.docs.clear();
    this.noteIdToChunkIds.clear();
  }

  // ============ Private Methods ============

  private removeNoteChunks(noteId: string): void {
    const chunkIds = this.noteIdToChunkIds.get(noteId);
    if (chunkIds) {
      for (const chunkId of chunkIds) {
        this.docs.delete(chunkId);
      }
      this.noteIdToChunkIds.delete(noteId);
    }
  }

  private validateEmbedding(embedding: number[]): boolean {
    return (
      Array.isArray(embedding) &&
      embedding.length === this.dimension &&
      embedding.every((n) => typeof n === "number" && !Number.isNaN(n))
    );
  }

  private cosineSimilarity(a: Float32Array, aNorm: number, b: Float32Array): number {
    let dot = 0;
    let bNormSq = 0;

    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      bNormSq += b[i] * b[i];
    }

    const bNorm = Math.sqrt(bNormSq);
    if (bNorm === 0) return 0;

    return dot / (aNorm * bNorm);
  }

  private magnitude(vec: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < vec.length; i++) {
      sum += vec[i] * vec[i];
    }
    return Math.sqrt(sum);
  }
}
