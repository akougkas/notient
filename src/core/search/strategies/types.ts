/**
 * Search Strategy Types
 *
 * Defines the interface for search strategies and shared types.
 * Each strategy implements a different search approach:
 * - Quick: Native Obsidian search, no AI
 * - Balanced: Vector search with optional LLM reranking
 * - Deep: Agentic search with query expansion and graph traversal
 */

import type { ChunkSearchResult, SearchOptions, SearchResult } from "../../../types/search";

/** Search mode identifiers matching settings presets */
export type SearchMode = "quick" | "balanced" | "thorough";

/** Result source attribution for debugging and UI */
export type ResultSource = "native" | "vector" | "rerank" | "graph" | "expanded";

/**
 * Extended search result with source attribution
 */
export interface AttributedSearchResult extends SearchResult {
  /** How this result was found */
  sources: ResultSource[];
  /** Query expansion terms that matched (Deep mode) */
  expandedTerms?: string[];
  /** Graph path if found via link traversal */
  graphPath?: string[];
}

/**
 * Options for search strategy execution
 */
export interface StrategySearchOptions {
  /** Maximum number of results */
  topK: number;
  /** Minimum similarity threshold (0-1) */
  minScore: number;
  /** Filter by PARA type */
  paraType?: SearchOptions["paraType"];
  /** Filter by folder paths */
  folderPaths?: string[];
  /** Filter by tags */
  tags?: string[];
  /** Include note content in results */
  includeContent: boolean;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/**
 * Progress event for long-running searches
 */
export interface SearchProgress {
  /** Current stage of the search */
  stage:
    | "native"
    | "embedding"
    | "vector-search"
    | "reranking"
    | "expanding"
    | "graph"
    | "aggregating";
  /** Optional detail message */
  detail?: string;
  /** Progress percentage (0-100) if known */
  progress?: number;
}

/**
 * Search strategy interface
 *
 * Each strategy must implement this interface to be used by SearchPipeline.
 * Strategies should:
 * - Handle their own error recovery
 * - Respect the abort signal
 * - Report progress for UI updates
 */
export interface SearchStrategy {
  /** Strategy identifier */
  readonly name: SearchMode;

  /** Human-readable description */
  readonly description: string;

  /** Target latency in milliseconds */
  readonly targetLatencyMs: number;

  /**
   * Execute the search strategy
   *
   * @param query - Search query text
   * @param options - Search options
   * @param onProgress - Optional progress callback
   * @returns Search results attributed with source information
   */
  search(
    query: string,
    options: StrategySearchOptions,
    onProgress?: (progress: SearchProgress) => void,
  ): Promise<SearchResult[]>;

  /**
   * Check if the strategy is available
   * Quick mode should always return true (native search)
   * Other modes depend on service availability
   */
  isAvailable(): boolean;
}

/**
 * Context passed to search strategies
 */
export interface StrategyContext {
  /** Kernel for accessing services */
  kernel: import("../../kernel").Kernel;
  /** Event bus for emitting events */
  eventBus: import("../../events/eventBus").EventBus;
  /** Ollama service for embeddings */
  ollamaService: import("../../../services/ollama").OllamaService;
  /** Vector store for similarity search */
  vectorStore: import("../../../services/vectorStore").VectorStore;
}

/**
 * Native search match from Obsidian
 */
export interface NativeMatch {
  /** File path */
  path: string;
  /** File basename (title) */
  title: string;
  /** Match type */
  matchType: "title" | "path" | "content" | "tag" | "heading";
  /** Matched text snippet */
  snippet?: string;
  /** Match positions in content */
  positions?: Array<{ start: number; end: number }>;
  /** Relevance score (normalized 0-1) */
  score: number;
}
