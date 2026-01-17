/**
 * Indexer types for Notient
 * Source of truth: .planning/PHASE-GALAXY.md
 */

import type { ChunkType } from "../../types";

/**
 * A chunk of content from a note.
 * Represents hierarchical semantic decomposition:
 * - full: entire note content
 * - section: content under a heading
 * - paragraph: individual paragraph
 */
export interface Chunk {
  id: string;
  notePath: string;
  content: string;
  type: ChunkType;
  startLine: number;
  endLine: number;
  hash: string;
}

/**
 * Configuration for the indexer service.
 */
export interface IndexerConfig {
  /** Max note size in bytes before warning (default 50KB) */
  maxNoteSize?: number;
  /** Progress callback during vault indexing */
  onProgress?: (indexed: number, total: number) => void;
}

/** Default max note size: 50KB */
export const DEFAULT_MAX_NOTE_SIZE = 50 * 1024;

/**
 * Result of indexing a single note.
 */
export interface IndexNoteResult {
  notePath: string;
  chunkCount: number;
  skipped: boolean;
  warning?: string;
}

/**
 * Result of indexing the entire vault.
 */
export interface IndexVaultResult {
  totalNotes: number;
  indexedNotes: number;
  skippedNotes: number;
  totalChunks: number;
  duration: number;
  warnings: string[];
}
