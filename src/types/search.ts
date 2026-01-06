/**
 * Search types for semantic search pipeline
 */

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
  /** Chunk text */
  text: string;
  /** Similarity score (0-1) */
  score: number;
  /** PARA type */
  paraType: ParaType;
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

/** Cache entry for search results */
export interface SearchCacheEntry {
  /** Query string */
  query: string;
  /** Options hash */
  optionsHash: string;
  /** Model key */
  modelKey: string;
  /** Results */
  results: SearchResult[];
  /** Cache timestamp */
  cachedAt: number;
  /** Time to live (ms) */
  ttlMs: number;
}
