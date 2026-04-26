/**
 * Search types for semantic search pipeline
 */

import type { ChunkKind, ChunkTier } from "./indexer";

/** Search query options */
export interface SearchOptions {
  /** Maximum number of results */
  topK: number;
  /** Minimum similarity threshold (0-1) */
  minScore: number;
  /** Filter by PARA type */
  paraType?: ParaType;
  /** Filter by folder paths */
  folderPaths?: string[];
  /** Filter by tags */
  tags?: string[];
  /** Restrict search to specific chunk tiers */
  tier?: ChunkTier | ChunkTier[];
  /** Restrict search to specific note IDs (used for hierarchical retrieval) */
  noteIds?: string[];
  /** Maximum results per note (applied after scoring) */
  maxPerNote?: number;
  /** Include note content in results */
  includeContent: boolean;
  /** Original query text for hybrid search (lexical boost) */
  queryText?: string;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  topK: 10,
  minScore: 0.3,
  includeContent: true,
};

/** PARA note types */
export type ParaType = "inbox" | "projects" | "areas" | "resources" | "archive" | "unknown";

/** Search result for a single chunk */
export interface ChunkSearchResult {
  /** Chunk ID */
  chunkId: string;
  /** Note ID */
  noteId: string;
  /** Note path */
  path: string;
  /** Note title */
  title: string;
  /** Heading path */
  headingPath: string[];
  /** Tier (note/section/block) */
  tier: ChunkTier;
  /** Kind */
  kind: ChunkKind;
  /** Parent chunk ID (block -> section, section -> note) */
  parentChunkId: string | null;
  /** Obsidian block reference (e.g. ^abc123) if present */
  blockRef: string | null;
  /** Start line in the note (1-based) */
  startLine: number | null;
  /** End line in the note (1-based) */
  endLine: number | null;
  /** Token estimate (proxy) */
  tokenEstimate: number;
  /** Chunk text */
  text: string;
  /** Similarity score (0-1) */
  score: number;
  /** PARA type */
  paraType: ParaType;
  /** Optional LLM reasoning for this chunk (chunk-level reranking) */
  reasoning?: string;
}

/** Grouped search result by note */
export interface SearchResult {
  /** Note ID */
  noteId: string;
  /** Note path */
  path: string;
  /** Note title */
  title: string;
  /** Best score among chunks */
  bestScore: number;
  /** PARA type */
  paraType: ParaType;
  /** Matching chunks */
  chunks: ChunkSearchResult[];
  /** Last modified time */
  mtimeMs: number;
  /** LLM reasoning for why this result is relevant (from reranking) */
  reasoning?: string;
}

/** Related notes result */
export interface RelatedNote {
  /** Note path */
  path: string;
  /** Note title */
  title: string;
  /** Relevance score */
  score: number;
  /** PARA type */
  paraType: ParaType;
  /** Shared tags */
  sharedTags: string[];
  /** Direct link exists */
  hasDirectLink: boolean;
}
