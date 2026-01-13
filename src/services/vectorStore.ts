/**
 * Vector Store Interface
 *
 * Abstract interface for vector storage operations.
 * Allows for alternative implementations in the future.
 */

import type { ChunkKind, ChunkTier, EmbeddedChunk, NoteChunk } from "../types/indexer";
import type { ChunkSearchResult, SearchOptions } from "../types/search";

/**
 * Options for vector store initialization
 */
export interface VectorStoreInitOptions {
  /** Override path for external/user-provided indices */
  indexOverridePath?: string;
  /** Mark index as read-only (no persistence allowed) */
  isReadOnly?: boolean;
}

/**
 * Vector store interface for chunk storage and retrieval
 */
export interface VectorStore {
  /**
   * Initialize the vector store
   */
  initialize(options?: VectorStoreInitOptions): Promise<void>;

  /**
   * Upsert chunks into the store
   */
  upsertChunks(chunks: EmbeddedChunk[]): Promise<void>;

  /**
   * Delete chunks by note path
   */
  deleteByPath(notePath: string): Promise<void>;

  /**
   * Delete chunks by path prefix (for folder operations)
   */
  deleteByPathPrefix(prefix: string): Promise<void>;

  /**
   * Search for similar chunks
   */
  search(embedding: number[], options: SearchOptions): Promise<ChunkSearchResult[]>;

  /**
   * Get all chunks for a note
   */
  getChunksByNoteId(noteId: string): Promise<NoteChunk[]>;

  /**
   * Count total chunks
   */
  countChunks(): Promise<number>;

  /**
   * Count notes (distinct noteIds)
   */
  countNotes(): Promise<number>;

  /**
   * Check if the store is ready
   */
  isReady(): boolean;

  /**
   * Wait for the store to be ready (async initialization).
   * Call this before loadFromData() to ensure WASM/async resources are loaded.
   */
  waitForReady?(): Promise<void>;

  /**
   * Dispose of the store
   */
  dispose(): Promise<void>;

  /**
   * Optional: signal the store that a large bulk indexing operation is starting.
   * Implementations may suspend expensive persistence work while bulk updates run.
   */
  beginBulkUpdate?(): void;

  /**
   * Optional: signal the store that bulk indexing has finished.
   * Implementations may resume persistence and flush pending writes.
   */
  endBulkUpdate?(): Promise<void>;

  /**
   * Optional: force persistence of any pending writes.
   */
  flush?(): Promise<void>;

  /**
   * Optional: clear ALL data for full reindex.
   * Much faster than deleting documents one by one.
   */
  clearAll?(): Promise<void>;

  // ============ Embedded State API (v3) ============

  /** Get state for a note */
  getNoteState?(notePath: string): {
    path: string;
    mtimeMs: number;
    contentHash: string;
    chunkCount: number;
    embeddedAt: number;
  } | null;

  /** Set state for a note */
  setNoteState?(
    notePath: string,
    state: {
      path: string;
      mtimeMs: number;
      contentHash: string;
      chunkCount: number;
      embeddedAt: number;
    },
  ): void;

  /** Remove state for a note */
  removeNoteState?(notePath: string): void;

  /** Get all indexed note paths */
  getIndexedPaths?(): string[];

  /** Get count of indexed notes */
  getIndexedNoteCount?(): number;

  /** Check if a note is indexed */
  isNoteIndexed?(notePath: string): boolean;

  /** Get last full index timestamp */
  getLastFullIndexAt?(): number | null;

  /** Record that a full index completed */
  recordFullIndex?(): void;

  /** Clear all state (for rebuild) */
  clearState?(): void;

  // ============ Data Transfer API (for IndexManager file I/O) ============

  /**
   * Load data from parsed index file.
   * Called by IndexManager after reading and parsing JSON.
   */
  loadFromData?(data: {
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
      notes: Record<
        string,
        {
          path: string;
          mtimeMs: number;
          contentHash: string;
          chunkCount: number;
          embeddedAt: number;
        }
      >;
    };
  }): void;

  /**
   * Async variant of loadFromData() for implementations that need async I/O
   * (e.g., loading a native/WASM index from a virtual filesystem).
   *
   * Called by IndexManager after reading and parsing JSON.
   */
  loadFromDataAsync?(
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
        /** Optional label for native index compatibility (v3+) */
        label?: number;
        mtimeMs: number;
        contentHash: string;
        tags: string[];
        frontmatter: Record<string, unknown>;
      }>;
      state?: {
        lastFullIndexAt: number | null;
        notes: Record<
          string,
          {
            path: string;
            mtimeMs: number;
            contentHash: string;
            chunkCount: number;
            embeddedAt: number;
          }
        >;
      };
    },
    options?: {
      /**
       * Optional native index filename for WASM-backed stores (e.g. hnswlib-wasm).
       * This should be unique per vault/index snapshot to avoid collisions.
       */
      hnswFilename?: string;
    },
  ): Promise<void>;

  /**
   * Optional: persist any native/WASM index data (separate from JSON) to the
   * store's native filesystem (e.g. Emscripten/IDBFS).
   */
  persistNativeIndex?(options: { hnswFilename: string }): Promise<void>;

  /**
   * Export current data for persistence.
   * Called by IndexManager when saving to disk.
   */
  exportData?(): {
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
        notes: Record<
          string,
          {
            path: string;
            mtimeMs: number;
            contentHash: string;
            chunkCount: number;
            embeddedAt: number;
          }
        >;
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
      /** Optional label for native index compatibility (v3+) */
      label?: number;
      mtimeMs: number;
      contentHash: string;
      tags: string[];
      frontmatter: Record<string, unknown>;
    }>;
  };

  /**
   * Set model configuration (called before loadFromData or for fresh index).
   */
  setModelConfig?(modelKey: string, dimension: number): void;

  /**
   * Mark the store as dirty (needs saving).
   * IndexManager will check this to schedule saves.
   */
  isDirty?(): boolean;

  /**
   * Clear the dirty flag after successful save.
   */
  clearDirty?(): void;
}
