/**
 * Simple Vector Store
 *
 * Lightweight in-memory vector store with JSON persistence.
 * Uses brute-force cosine similarity - fast enough for <100K vectors.
 *
 * Design goals:
 * - Zero native dependencies (works in Electron/Obsidian)
 * - Simple API, easy to understand
 * - Fast search (<50ms for 50K vectors)
 * - JSON persistence for portability
 * - Multi-model support via separate index files
 */

import * as fs from "fs";
import * as path from "path";
import type { Kernel } from "../core/kernel";
import type { VectorStore } from "./vectorStore";
import type { EmbeddedChunk, NoteChunk } from "../types/indexer";
import type { ChunkSearchResult, SearchOptions } from "../types/search";
import { ParaDetector } from "../core/para/detector";

/** Internal document structure - stored in memory */
interface StoredDoc {
  chunkId: string;
  noteId: string;
  path: string;
  title: string;
  headingPath: string[];
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
  chunkIndex: number;
  text: string;
  embedding: number[];
  mtimeMs: number;
  contentHash: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
}

interface IndexMetadata {
  version: number;
  modelKey: string;
  dimension: number;
  docCount: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Simple vector store with brute-force cosine similarity
 */
export class SimpleVectorStore implements VectorStore {
  private docs: Map<string, StoredDoc> = new Map();
  private noteIdToChunkIds: Map<string, Set<string>> = new Map();
  private dimension: number = 0;
  private modelKey: string = "";
  private disposed = false;
  private dirty = false;
  private bulkMode = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private paraDetector: ParaDetector;

  constructor(private kernel: Kernel) {
    this.paraDetector = new ParaDetector(kernel.settings);
  }

  async initialize(): Promise<void> {
    if (this.disposed) return;

    const ollama = this.kernel.getService<{
      getModelKey(): string;
      getDimension(): Promise<number>;
    }>("ollama");

    if (!ollama) {
      throw new Error("Ollama service not available");
    }

    this.modelKey = ollama.getModelKey();
    this.dimension = await ollama.getDimension();

    // Try to load existing index
    const loaded = await this.loadFromDisk();
    if (!loaded) {
      console.log(
        `[SimpleVectorStore] Created fresh index (${this.dimension}-dim)`
      );
    }
  }

  /**
   * Upsert chunks - replaces existing chunks for the same note
   */
  async upsertChunks(chunks: EmbeddedChunk[]): Promise<void> {
    if (this.disposed) throw new Error("Store disposed");
    if (chunks.length === 0) return;

    // Remove existing chunks for affected notes (unless in bulk mode)
    if (!this.bulkMode) {
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
      this.noteIdToChunkIds.get(chunk.noteId)!.add(chunk.chunkId);
    }

    this.dirty = true;
    if (!this.bulkMode) {
      this.scheduleSave();
    }
  }

  async deleteByNoteId(noteId: string): Promise<void> {
    if (this.disposed) return;
    this.removeNoteChunks(noteId);
    this.dirty = true;
    if (!this.bulkMode) {
      this.scheduleSave();
    }
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
    if (!this.bulkMode) {
      this.scheduleSave();
    }
  }

  /**
   * Search using brute-force cosine similarity
   * For 50K vectors, this takes ~10-20ms - well within target
   */
  async search(
    queryEmbedding: number[],
    options: SearchOptions
  ): Promise<ChunkSearchResult[]> {
    if (this.disposed || this.docs.size === 0) return [];

    const query = new Float32Array(queryEmbedding);
    const queryNorm = this.magnitude(query);
    if (queryNorm === 0) return [];

    // Score all documents
    const scored: Array<{ doc: StoredDoc; score: number }> = [];

    for (const doc of this.docs.values()) {
      const score = this.cosineSimilarity(query, queryNorm, doc.embedding);
      if (score >= options.minScore) {
        scored.push({ doc, score });
      }
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Apply filters and build results
    const results: ChunkSearchResult[] = [];

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

      results.push({
        chunkId: doc.chunkId,
        noteId: doc.noteId,
        path: doc.path,
        title: doc.title,
        headingPath: doc.headingPath,
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
    this.bulkMode = true;
  }

  async endBulkUpdate(): Promise<void> {
    this.bulkMode = false;
    await this.flush();
  }

  async clearAll(): Promise<void> {
    this.docs.clear();
    this.noteIdToChunkIds.clear();
    this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.dirty || this.disposed || this.bulkMode) return;

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    await this.saveToDisk();
  }

  async dispose(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.bulkMode = false;
    await this.flush();
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
      embedding.every((n) => typeof n === "number" && !isNaN(n))
    );
  }

  private cosineSimilarity(
    a: Float32Array,
    aNorm: number,
    b: Float32Array
  ): number {
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

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveToDisk();
    }, 10000); // Save 10s after last write
  }

  private getIndexPath(): string {
    return path.join(
      this.kernel.storagePaths.pluginRoot,
      `index-${this.modelKey}.json`
    );
  }

  private async loadFromDisk(): Promise<boolean> {
    const indexPath = this.getIndexPath();

    try {
      const exists = await fs.promises
        .access(indexPath)
        .then(() => true)
        .catch(() => false);
      if (!exists) return false;

      const raw = await fs.promises.readFile(indexPath, "utf-8");
      const data = JSON.parse(raw) as {
        meta: IndexMetadata;
        docs: PersistedDoc[];
      };

      // Validate model key and dimension
      if (data.meta.modelKey !== this.modelKey) {
        console.log("[SimpleVectorStore] Model key mismatch, creating fresh");
        return false;
      }

      if (data.meta.dimension !== this.dimension) {
        console.log("[SimpleVectorStore] Dimension mismatch, creating fresh");
        return false;
      }

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
        this.noteIdToChunkIds.get(doc.noteId)!.add(doc.chunkId);
      }

      console.log(
        `[SimpleVectorStore] Loaded ${this.docs.size} chunks from disk`
      );
      return true;
    } catch (error) {
      console.warn("[SimpleVectorStore] Failed to load:", error);
      return false;
    }
  }

  private async saveToDisk(): Promise<void> {
    if (!this.dirty || this.disposed) return;

    const indexPath = this.getIndexPath();

    try {
      // Convert to persisted format
      const persistedDocs: PersistedDoc[] = [];
      for (const doc of this.docs.values()) {
        persistedDocs.push({
          chunkId: doc.chunkId,
          noteId: doc.noteId,
          path: doc.path,
          title: doc.title,
          headingPath: doc.headingPath,
          chunkIndex: doc.chunkIndex,
          text: doc.text,
          embedding: Array.from(doc.embedding),
          mtimeMs: doc.mtimeMs,
          contentHash: doc.contentHash,
          tags: doc.tags,
          frontmatter: doc.frontmatter,
        });
      }

      const data = {
        meta: {
          version: 1,
          modelKey: this.modelKey,
          dimension: this.dimension,
          docCount: persistedDocs.length,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } as IndexMetadata,
        docs: persistedDocs,
      };

      await fs.promises.writeFile(indexPath, JSON.stringify(data));
      this.dirty = false;
      console.log(`[SimpleVectorStore] Saved ${persistedDocs.length} chunks`);
    } catch (error) {
      console.error("[SimpleVectorStore] Failed to save:", error);
    }
  }
}
