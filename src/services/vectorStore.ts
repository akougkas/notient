/**
 * Vector Store Interface
 * 
 * Abstract interface for vector storage operations.
 * Allows for alternative implementations in the future.
 */

import type { EmbeddedChunk, NoteChunk } from "../types/indexer";
import type { ChunkSearchResult, SearchOptions } from "../types/search";

/**
 * Vector store interface for chunk storage and retrieval
 */
export interface VectorStore {
  /**
   * Initialize the vector store
   */
  initialize(): Promise<void>;

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
  search(
    embedding: number[],
    options: SearchOptions
  ): Promise<ChunkSearchResult[]>;

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
  dispose(): void;
}
