/**
 * Vector Store Interface
 *
 * Abstract interface for vector storage operations.
 * Allows for alternative implementations in the future.
 */

import type { EmbeddedChunk, NoteChunk } from "../types/indexer";
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
   * Delete chunks by note ID
   */
  deleteByNoteId(noteId: string): Promise<void>;

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
}
