import * as fs from "node:fs";
import * as path from "node:path";
import { VectorWorkerBridge } from "../core/vector/workerBridge";
import type { Kernel } from "../core/kernel";
import { ParaDetector } from "../core/para/detector";
import type { ChunkKind, ChunkTier, EmbeddedChunk, NoteChunk } from "../types/indexer";
import type { ChunkSearchResult, ParaType, SearchOptions } from "../types/search";
import { atomicWriteFile } from "../utils/atomicWrite";
import type { VectorStore, VectorStoreInitOptions } from "./vectorStore";
import type { DatabaseService } from "../core/db/database";

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

/** Persisted doc format with embedding (Legacy compatibility) */
// biome-ignore lint/suspicious/noExplicitAny: Legacy format
type PersistedDoc = any;

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
 * Metadata is stored in SQLite (via DatabaseService).
 */
export class HNSWVectorStore implements VectorStore {
  private bridge: VectorWorkerBridge;
  private db: DatabaseService;
  
  private dimension = 0;
  private modelKey = "";
  private createdAt = Date.now();
  private disposed = false;
  private dirty = false;
  private bulkDepth = 0;
  private paraDetector: ParaDetector;
  private initialized = false;

  // Note states - Cached in memory for speed, populated from DB on init.
  private noteStates: Map<string, NoteState> = new Map();
  private lastFullIndexAt: number | null = null;

  constructor(private kernel: Kernel) {
    this.paraDetector = new ParaDetector(kernel.settings);
    const workerPath = path.join(this.kernel.storagePaths.pluginRoot, "vector.worker.js");
    this.bridge = new VectorWorkerBridge(workerPath);
    
    const db = kernel.getService<DatabaseService>("database");
    if (!db) throw new Error("DatabaseService not available");
    this.db = db;
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
      
      // Load note states from SQLite to hydrate cache
      await this.hydrateNoteStates();
    } catch (error) {
      console.error("[HNSWVectorStore] Failed to initialize:", error);
      throw error;
    }
  }
  
  private async hydrateNoteStates(): Promise<void> {
    try {
      // Fetch indexed notes from DB
      const notes = await this.db.db
        .selectFrom("notes")
        .select(["path", "mtime", "hash", "word_count"])
        .execute();
        
      // Only notes with chunks are "indexed".
      const indexedNotes = await this.db.db
        .selectFrom("chunks")
        .select("note_path")
        .distinct()
        .execute();
        
      const indexedPaths = new Set(indexedNotes.map(n => n.note_path));
      
      for (const note of notes) {
        if (indexedPaths.has(note.path)) {
           this.noteStates.set(note.path, {
             path: note.path,
             mtimeMs: note.mtime,
             contentHash: note.hash,
             chunkCount: 0, // Placeholder
             embeddedAt: note.mtime
           });
        }
      }
      console.log(`[HNSWVectorStore] Hydrated ${this.noteStates.size} note states from DB`);
    } catch (e) {
      console.warn("[HNSWVectorStore] Failed to hydrate note states:", e);
    }
  }

  async waitForReady(): Promise<void> {
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
      const tempPath = `${filePath}.tmp`;
      await fs.promises.writeFile(tempPath, new Uint8Array(data));
      await fs.promises.rename(tempPath, filePath);
      
      console.log("[HNSWVectorStore] Native index persisted successfully");
    } catch (error) {
      console.warn("[HNSWVectorStore] Failed to persist native index:", error);
    }
  }

  private async tryLoadNativeIndex(hnswFilename: string): Promise<boolean> {
    const filePath = path.join(this.kernel.storagePaths.pluginRoot, hnswFilename);
    try {
      await fs.promises.access(filePath);
      const buffer = await fs.promises.readFile(filePath);
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
    
    // Legacy state load (if provided)
    if (data.state) {
      this.lastFullIndexAt = data.state.lastFullIndexAt ?? null;
      if (data.state.notes) {
        for (const [path, noteState] of Object.entries(data.state.notes)) {
          this.noteStates.set(path, noteState);
        }
      }
    }
    
    const hnswFilename = options?.hnswFilename ?? null;

    // Fast path: load native HNSW
    if (hnswFilename) {
      const loaded = await this.tryLoadNativeIndex(hnswFilename);
      if (loaded) {
        this.dirty = false;
        console.log(`[HNSWVectorStore] Loaded native index ${hnswFilename}`);
        return;
      }
    }

    // Slow path: rebuild HNSW from provided docs (Migration case)
    if (data.docs && data.docs.length > 0) {
        console.log("[HNSWVectorStore] Rebuilding index from JSON docs...");
        const items = data.docs.map(doc => ({
          id: doc.chunkId,
          embedding: new Float32Array(doc.embedding)
        }));
        await this.bridge.addItems(items);
    }
    
    this.dirty = false;
  }

  // biome-ignore lint/suspicious/noExplicitAny: Legacy interface compatibility
  loadFromData(data: any): void {
    console.warn("[HNSWVectorStore] Sync loadFromData called - using async fallback");
    this.loadFromDataAsync(data).catch(e => console.error(e));
  }

  exportData(): { meta: PersistedIndex["meta"]; docs: PersistedDoc[] } {
    // We no longer export docs to JSON.
    return {
      meta: {
        version: INDEX_VERSION,
        modelKey: this.modelKey,
        dimension: this.dimension,
        docCount: this.noteStates.size, // Approx
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
      docs: [], // Empty docs - metadata is in SQLite
    };
  }

  // ============ Vector Operations ============

  async upsertChunks(chunks: EmbeddedChunk[]): Promise<void> {
    if (this.disposed) throw new Error("Store disposed");
    if (chunks.length === 0) return;

    const validChunks = chunks.filter((c) => this.validateEmbedding(c.embedding));
    if (validChunks.length === 0) return;

    // 1. Prepare items for worker
    const items = validChunks.map(c => ({
      id: c.chunkId,
      embedding: new Float32Array(c.embedding)
    }));

    // 2. Write to SQLite
    try {
      await this.db.db.transaction().execute(async (trx) => {
        // Insert/Update chunks
        for (const chunk of validChunks) {
          // Ensure note exists
          await trx.insertInto("notes")
            .values({
              path: chunk.path,
              hash: chunk.contentHash,
              mtime: chunk.mtimeMs,
              title: chunk.title,
              health_score: 0,
              para_type: this.paraDetector.detectType(chunk.path),
              word_count: 0 // TODO: calculate
            })
            .onConflict((oc) => oc.column("path").doUpdateSet({
              hash: chunk.contentHash,
              mtime: chunk.mtimeMs,
              title: chunk.title
            }))
            .execute();

          // Insert chunk
          await trx.insertInto("chunks")
            .values({
              id: chunk.chunkId,
              note_path: chunk.path,
              tier: chunk.tier,
              kind: chunk.kind,
              parent_chunk_id: chunk.parentChunkId || null,
              heading_path: chunk.headingPath ? JSON.stringify(chunk.headingPath) : null,
              text: chunk.text,
              start_line: chunk.startLine || null,
              end_line: chunk.endLine || null
            })
            .onConflict((oc) => oc.column("id").doUpdateSet({
              text: chunk.text,
              tier: chunk.tier,
              kind: chunk.kind
            }))
            .execute();

          // Insert embedding
          await trx.insertInto("embeddings")
            .values({
              chunk_id: chunk.chunkId,
              model_key: this.modelKey,
              dimension: this.dimension,
              vector: new Uint8Array(new Float32Array(chunk.embedding).buffer)
            })
            .onConflict((oc) => oc.column("chunk_id").doUpdateSet({
              vector: new Uint8Array(new Float32Array(chunk.embedding).buffer)
            }))
            .execute();
        }
      });
    } catch (e) {
      console.error("[HNSWVectorStore] Failed to write to DB:", e);
      throw e;
    }

    // 3. Update Worker
    await this.bridge.addItems(items);

    // 4. Update cache
    for (const chunk of validChunks) {
      this.noteStates.set(chunk.path, {
        path: chunk.path,
        mtimeMs: chunk.mtimeMs,
        contentHash: chunk.contentHash,
        chunkCount: 0, // Need to track
        embeddedAt: Date.now()
      });
    }

    this.dirty = true;
  }

  async deleteByNoteId(noteId: string): Promise<void> {
    console.warn("[HNSWVectorStore] deleteByNoteId is not supported with SQLite. Use deleteByPath.");
  }
  
  // New method for SQLite compatibility
  async deleteByPath(notePath: string): Promise<void> {
    if (this.disposed) return;
    
    // 1. Get chunk IDs from DB
    const chunks = await this.db.db
      .selectFrom("chunks")
      .select("id")
      .where("note_path", "=", notePath)
      .execute();
      
    const ids = chunks.map(c => c.id);
    if (ids.length === 0) return;
    
    // 2. Delete from Worker
    this.bridge.markDeleted(ids);
    
    // 3. Delete from DB
    await this.db.db.deleteFrom("chunks").where("note_path", "=", notePath).execute();
    // embeddings deleted via foreign key cascade? Not guaranteed in SQLite unless enabled.
    // Explicitly delete embeddings.
    await this.db.db.deleteFrom("embeddings").where("chunk_id", "in", ids).execute();
    
    this.dirty = true;
  }

  async deleteByPathPrefix(prefix: string): Promise<void> {
    if (this.disposed) return;

    // Find notes starting with prefix
    const notes = await this.db.db
      .selectFrom("notes")
      .select("path")
      .where("path", "like", `${prefix}%`)
      .execute();
      
    for (const note of notes) {
      await this.deleteByPath(note.path);
    }

    this.dirty = true;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Search Helpers
  // ──────────────────────────────────────────────────────────────────────────

  /** Build search result from row */
  // biome-ignore lint/suspicious/noExplicitAny: DB row
  private buildSearchResult(
    row: any,
    score: number,
    paraType: ParaType,
    includeContent: boolean,
  ): ChunkSearchResult {
    return {
      chunkId: row.id,
      noteId: row.note_path, // using path as noteId for now
      path: row.note_path,
      title: row.title || "",
      headingPath: row.heading_path ? JSON.parse(row.heading_path) : [],
      tier: row.tier,
      kind: row.kind,
      parentChunkId: row.parent_chunk_id,
      blockRef: null,
      startLine: row.start_line,
      endLine: row.end_line,
      tokenEstimate: 0,
      text: includeContent ? row.text : "",
      score,
      paraType,
    };
  }

  /**
   * Search using HNSW algorithm via worker + SQLite metadata.
   */
  async search(queryEmbedding: number[], options: SearchOptions): Promise<ChunkSearchResult[]> {
    if (this.disposed) return [];

    const query = new Float32Array(queryEmbedding);
    const k = options.topK * 4; 
    
    // 1. Get candidates from Worker
    const rawResults = await this.bridge.search(query, k);
    if (rawResults.length === 0) return [];
    
    const ids = rawResults.map(r => r.id);
    const scores = new Map(rawResults.map(r => [r.id, r.score]));
    
    // 2. Fetch metadata from SQLite
    const rows = await this.db.db
      .selectFrom("chunks")
      .innerJoin("notes", "chunks.note_path", "notes.path")
      .select([
        "chunks.id", "chunks.note_path", "chunks.tier", "chunks.kind", 
        "chunks.heading_path", "chunks.text", "chunks.start_line", "chunks.end_line",
        "chunks.parent_chunk_id",
        "notes.title", "notes.path"
      ])
      .where("chunks.id", "in", ids)
      .execute();
      
    // 3. Post-process
    const queryTerms = options.queryText?.toLowerCase().split(/\s+/).filter(t => t.length >= 2) || [];
    const results: ChunkSearchResult[] = [];
    const perNoteCounts = new Map<string, number>();

    for (const row of rows) {
      const score = scores.get(row.id) || 0;
      const paraType = this.paraDetector.detectType(row.path);
      
      // Filter: Tier
      if (options.tier) {
        const tiers = Array.isArray(options.tier) ? options.tier : [options.tier];
        if (!tiers.includes(row.tier)) continue;
      }
      
      results.push(this.buildSearchResult(row, score, paraType, options.includeContent ?? false));
    }
    
    // Sort by score
    return results.sort((a, b) => b.score - a.score).slice(0, options.topK);
  }

  async getChunksByNoteId(noteId: string): Promise<NoteChunk[]> {
    return this.getChunksByPath(noteId);
  }
  
  async getChunksByPath(path: string): Promise<NoteChunk[]> {
    if (this.disposed) return [];
    
    const rows = await this.db.db
      .selectFrom("chunks")
      .where("note_path", "=", path)
      .selectAll()
      .execute();
      
    // biome-ignore lint/suspicious/noExplicitAny: casting types
    return rows.map(row => ({
      chunkId: row.id,
      noteId: row.note_path,
      path: row.note_path,
      title: "", // Missing title in chunks table query, default to empty
      text: row.text,
      tier: row.tier as any,
      kind: row.kind as any,
      headingPath: row.heading_path ? JSON.parse(row.heading_path) : [],
      startLine: row.start_line || 0,
      endLine: row.end_line || 0,
      contentHash: "",
      mtimeMs: 0,
      tags: [],
      frontmatter: {},
      tokenEstimate: 0,
      chunkIndex: 0,
      parentChunkId: row.parent_chunk_id,
      blockRef: null
    }));
  }

  async countChunks(): Promise<number> {
    const res = await this.db.db
      .selectFrom("chunks")
      .select(this.db.db.fn.count("id").as("count"))
      .executeTakeFirst();
    return Number(res?.count || 0);
  }

  async countNotes(): Promise<number> {
    const res = await this.db.db
      .selectFrom("notes")
      .select(this.db.db.fn.count("path").as("count"))
      .executeTakeFirst();
    return Number(res?.count || 0);
  }

  isReady(): boolean {
    return !this.disposed && this.initialized;
  }

  // Bulk stubs
  beginBulkUpdate(): void { this.bulkDepth++; }
  async endBulkUpdate(): Promise<void> { this.bulkDepth = Math.max(0, this.bulkDepth - 1); }
  async clearAll(): Promise<void> {
    await this.bridge.init(HNSW_CONFIG);
    await this.db.db.deleteFrom("chunks").execute();
    await this.db.db.deleteFrom("notes").execute();
    await this.db.db.deleteFrom("embeddings").execute();
    this.noteStates.clear();
    this.dirty = true;
  }
  async flush(): Promise<void> { }
  
  async dispose(): Promise<void> {
    this.disposed = true;
    this.noteStates.clear();
    this.bridge.terminate();
  }

  private validateEmbedding(embedding: number[]): boolean {
    return (
      Array.isArray(embedding) &&
      embedding.length === this.dimension &&
      embedding.every((n) => typeof n === "number" && !Number.isNaN(n))
    );
  }
}
