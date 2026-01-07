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

import * as fs from "node:fs";
import * as path from "node:path";
import type { Kernel } from "../core/kernel";
import { ParaDetector } from "../core/para/detector";
import type { EmbeddedChunk, NoteChunk } from "../types/indexer";
import type { ChunkSearchResult, SearchOptions } from "../types/search";
import type { VectorStore } from "./vectorStore";

const INDEX_VERSION = 2;
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

interface IndexMetadata {
  version: number;
  modelKey: string;
  dimension: number;
  docCount: number;
  createdAt: number;
  updatedAt: number;
  chunker?: { name: string; version: number };
  tiers?: { note: boolean; section: boolean; block: boolean };
}

/**
 * Simple vector store with brute-force cosine similarity
 */
export class SimpleVectorStore implements VectorStore {
  private docs: Map<string, StoredDoc> = new Map();
  private noteIdToChunkIds: Map<string, Set<string>> = new Map();
  private dimension = 0;
  private modelKey = "";
  private createdAt = Date.now();
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

    console.log(
      `[SimpleVectorStore] Initializing for modelKey=${this.modelKey}, dim=${this.dimension}`,
    );

    // Try to load existing index
    const loaded = await this.loadFromDisk();
    if (!loaded) {
      console.log(`[SimpleVectorStore] Created fresh index (${this.dimension}-dim)`);
    } else {
      console.log(
        `[SimpleVectorStore] Using existing index: ${this.docs.size} chunks, ${this.noteIdToChunkIds.size} notes`,
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
   * Search using brute-force cosine similarity with hybrid lexical boost
   * For 50K vectors, this takes ~10-20ms - well within target
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
    const LENGTH_PENALTY_FACTOR = 0.3; // How much to penalize short texts (0-1)

    // Lexical boost for hybrid search
    const LEXICAL_BOOST = 0.15; // Boost for notes containing query terms
    const TITLE_BOOST = 0.25; // Extra boost for title matches

    for (const doc of this.docs.values()) {
      // Tier + noteId prefilter (fast reject before cosine)
      if (allowedTiers && !allowedTiers.has(doc.tier)) continue;
      if (allowedNoteIds && !allowedNoteIds.has(doc.noteId)) continue;

      let score = this.cosineSimilarity(query, queryNorm, doc.embedding);
      let lexicalMatch = false;

      // Apply length penalty for very short chunks
      // Short texts produce generic embeddings that falsely match many queries
      if (doc.text.length < MIN_TEXT_LENGTH) {
        const lengthRatio = doc.text.length / MIN_TEXT_LENGTH;
        const penalty = 1 - LENGTH_PENALTY_FACTOR * (1 - lengthRatio);
        score = score * penalty;
      }

      // Apply lexical boost for hybrid search
      // Notes containing the query terms should rank higher
      if (queryTerms.length > 0) {
        const textLower = doc.text.toLowerCase();
        const titleLower = doc.title.toLowerCase();
        const pathLower = doc.path.toLowerCase();

        // Check if any query term appears in content/title/path
        const textMatch = queryTerms.some((term) => textLower.includes(term));
        const titleMatch = queryTerms.some(
          (term) => titleLower.includes(term) || pathLower.includes(term),
        );

        if (titleMatch) {
          score = Math.min(0.99, score + TITLE_BOOST); // Title/path match gets biggest boost
          lexicalMatch = true;
        } else if (textMatch) {
          score = Math.min(0.99, score + LEXICAL_BOOST); // Content match gets smaller boost
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

      // Enforce per-note cap (applied after scoring + filters)
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

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveToDisk();
    }, 10000); // Save 10s after last write
  }

  private getIndexPath(): string {
    return path.join(this.kernel.storagePaths.pluginRoot, `index-${this.modelKey}.json`);
  }

  private async loadFromDisk(): Promise<boolean> {
    const indexPath = this.getIndexPath();
    console.log(`[SimpleVectorStore] Looking for index at: ${indexPath}`);

    try {
      const exists = await fs.promises
        .access(indexPath)
        .then(() => true)
        .catch(() => false);

      if (!exists) {
        console.log(`[SimpleVectorStore] No index file found for modelKey=${this.modelKey}`);
        return false;
      }

      const raw = await fs.promises.readFile(indexPath, "utf-8");
      const data = JSON.parse(raw) as {
        meta: IndexMetadata;
        docs: PersistedDoc[];
      };

      console.log(
        `[SimpleVectorStore] Found index: fileModelKey=${data.meta.modelKey}, fileDim=${data.meta.dimension}, docCount=${data.meta.docCount}`,
      );

      // Hard migration: only v2 is supported (Tiered Semantic Index)
      if (data.meta.version !== INDEX_VERSION) {
        console.log(
          `[SimpleVectorStore] Index version mismatch: file=${data.meta.version}, expected=${INDEX_VERSION}. Moving aside and creating fresh.`,
        );
        await this.moveToDeleted(indexPath, `v${data.meta.version ?? "unknown"}`);
        return false;
      }

      // Validate model key and dimension
      if (data.meta.modelKey !== this.modelKey) {
        console.log(
          `[SimpleVectorStore] Model key mismatch: file=${data.meta.modelKey}, current=${this.modelKey}. Creating fresh.`,
        );
        return false;
      }

      if (data.meta.dimension !== this.dimension) {
        console.log(
          `[SimpleVectorStore] Dimension mismatch: file=${data.meta.dimension}, current=${this.dimension}. Creating fresh.`,
        );
        return false;
      }

      this.createdAt = typeof data.meta.createdAt === "number" ? data.meta.createdAt : Date.now();

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

      console.log(`[SimpleVectorStore] Loaded ${this.docs.size} chunks from disk`);
      return true;
    } catch (error) {
      console.warn("[SimpleVectorStore] Failed to load:", error);
      // Corrupt file: move aside so we don't keep failing every boot
      try {
        await this.moveToDeleted(indexPath, "corrupt");
      } catch {
        // ignore
      }
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

      const data = {
        meta: {
          version: INDEX_VERSION,
          modelKey: this.modelKey,
          dimension: this.dimension,
          docCount: persistedDocs.length,
          createdAt: this.createdAt,
          updatedAt: Date.now(),
          chunker: CHUNKER_META,
          tiers: TIER_FLAGS,
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

  private async moveToDeleted(filePath: string, reason: string): Promise<void> {
    try {
      const deletedDir = path.join(this.kernel.storagePaths.pluginRoot, ".deleted");
      await fs.promises.mkdir(deletedDir, { recursive: true });
      const base = path.basename(filePath).replace(/\.json$/, "");
      const target = path.join(deletedDir, `${base}-${reason}-${Date.now()}.json`);
      await fs.promises.rename(filePath, target);
      console.log(`[SimpleVectorStore] Moved ${filePath} -> ${target}`);
    } catch (error) {
      console.warn("[SimpleVectorStore] Failed to move file to .deleted:", error);
    }
  }
}
