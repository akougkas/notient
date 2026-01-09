/**
 * Semantic Search Pipeline
 *
 * Provides fast semantic search with LLM reranking and caching.
 * Architecture: Vector search (fast) → LLM reranking (smart)
 */

import type { LMStudioService } from "../../services/lmstudio";
import type { OllamaService } from "../../services/ollama";
import type { VectorStore } from "../../services/vectorStore";
import type {
  ChunkSearchResult,
  RelatedNote,
  SearchOptions,
  SearchResult,
} from "../../types/search";
import { SEARCH_PRESETS } from "../../types/settings";
import { CACHE_CONFIG } from "../constants";
import type { EventBus } from "../events/eventBus";
import type { Kernel } from "../kernel";
import type { LLMProvider } from "../llm/provider";
import type { RankedResult, RerankCandidate } from "../llm/types";

type Reranker = {
  rerank: (query: string, candidates: RerankCandidate[]) => Promise<RankedResult[]>;
};

interface CacheEntry {
  results: SearchResult[];
  timestamp: number;
  queryEmbedding: number[];
}

/** Extended search options with reranking control */
export interface ExtendedSearchOptions extends SearchOptions {
  enableReranking?: boolean;
}

/**
 * Semantic search pipeline with LLM reranking and caching
 */
export class SearchPipeline {
  private queryCache: Map<string, CacheEntry> = new Map();
  private embeddingCache: Map<string, number[]> = new Map();
  private disposed = false;
  private abortController: AbortController | null = null;

  constructor(
    private kernel: Kernel,
    private eventBus: EventBus,
    private ollamaService: OllamaService,
    private vectorStore: VectorStore,
  ) {}

  /**
   * Get reranker (prefer new LLMProvider; fall back to legacy LMStudioService)
   */
  private getReranker(): Reranker | null {
    const provider = this.kernel.getService<LLMProvider>("llmProvider");
    if (provider?.isReady) return provider;

    const legacy = this.kernel.getService<LMStudioService>("lmstudio");
    if (legacy?.isReady()) return legacy;

    return null;
  }

  /**
   * Initialize the pipeline
   */
  async initialize(): Promise<void> {
    // Nothing to initialize currently
  }

  /**
   * Perform a semantic search with optional LLM reranking
   */
  async search(
    query: string,
    options: Partial<ExtendedSearchOptions> = {},
  ): Promise<SearchResult[]> {
    if (this.disposed) return [];

    // Create abort controller for this search operation
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    // Resolve effective settings from presets vs custom
    const searchSettings = this.kernel.settings.search;
    let defaults = searchSettings.custom;
    if (searchSettings.preset !== "custom") {
      defaults = SEARCH_PRESETS[searchSettings.preset];
    }

    const enableReranking = options.enableReranking ?? defaults.enableReranking;
    const requestedTopK = options.topK ?? defaults.topK;
    const minScore = options.minScore ?? defaults.minScore;

    const baseFilters = {
      minScore,
      includeContent: options.includeContent ?? true,
      paraType: options.paraType,
      folderPaths: options.folderPaths,
      tags: options.tags,
      queryText: query,
    } satisfies Omit<SearchOptions, "topK">;

    const startTime = Date.now();
    const cacheKey = this.getCacheKey(
      query,
      { ...baseFilters, topK: requestedTopK },
      enableReranking,
    );

    this.eventBus.emit("search:started", { query });

    // Check cache first (LRU: update timestamp on access)
    const cached = this.queryCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_CONFIG.SEARCH_CACHE_TTL_MS) {
      // LRU: Update timestamp on cache hit to mark as recently used
      cached.timestamp = Date.now();
      this.eventBus.emit("search:complete", {
        query,
        results: cached.results,
        durationMs: Date.now() - startTime,
        cached: true,
      });
      return cached.results;
    }

    try {
      // Phase 1: Query embedding (cached)
      this.eventBus.emit("search:progress", { query, stage: "embedding" });
      const queryEmbedding = await this.getQueryEmbedding(query);
      if (signal.aborted) return [];

      // Phase 2: Hierarchical retrieval (TSI v2)
      this.eventBus.emit("search:progress", { query, stage: "vector-search" });
      // Stage 1: candidate notes (tier=note)
      const noteCandidateK = enableReranking ? 80 : Math.max(40, requestedTopK * 4);
      const noteCandidates = await this.vectorStore.search(queryEmbedding, {
        ...baseFilters,
        topK: noteCandidateK,
        includeContent: false,
        tier: "note",
      });

      const candidateNoteIds = Array.from(new Set(noteCandidates.map((c) => c.noteId)));

      // Stage 2: candidate chunks within candidate notes (tier=block)
      const chunkCandidateK = enableReranking ? 120 : Math.max(60, requestedTopK * 6);
      const chunksPerNote = enableReranking ? 5 : 3;
      let chunkCandidates = await this.vectorStore.search(queryEmbedding, {
        ...baseFilters,
        topK: chunkCandidateK,
        includeContent: true,
        tier: "block",
        noteIds: candidateNoteIds.length ? candidateNoteIds : undefined,
        maxPerNote: candidateNoteIds.length ? chunksPerNote : undefined,
      });

      // If the vault isn't reindexed yet (no tiered chunks), fall back to legacy behavior
      if (candidateNoteIds.length === 0 || chunkCandidates.length === 0) {
        chunkCandidates = await this.vectorStore.search(queryEmbedding, {
          ...baseFilters,
          topK: enableReranking ? 50 : requestedTopK,
          includeContent: true,
        });
      }

      if (signal.aborted) return [];

      let results: SearchResult[];

      // Phase 3: Chunk-level reranking (smart)
      const reranker = this.getReranker();
      if (enableReranking && reranker && chunkCandidates.length > 0) {
        this.eventBus.emit("search:progress", {
          query,
          stage: "reranking",
          detail: `${chunkCandidates.length} chunks`,
        });
        const rerankedChunks = await this.rerankChunksWithLLM(query, chunkCandidates, reranker);
        this.eventBus.emit("search:progress", { query, stage: "aggregating" });
        results = this.aggregateChunksToNotes(rerankedChunks, { maxChunksPerNote: 3 });
      } else {
        // No reranker: rank by vector similarity, but still aggregate by note
        this.eventBus.emit("search:progress", { query, stage: "aggregating" });
        results = this.aggregateChunksToNotes(chunkCandidates, { maxChunksPerNote: 3 });
      }

      // Limit to requested topK
      results = results.slice(0, requestedTopK);

      // Cache results
      this.updateCache(cacheKey, results, queryEmbedding);

      this.eventBus.emit("search:complete", {
        query,
        results,
        durationMs: Date.now() - startTime,
        cached: false,
        reranked: enableReranking && Boolean(reranker),
      });

      return results;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[SearchPipeline] Search failed:", message);
      this.eventBus.emit("search:error", {
        query,
        error: message,
        operation: "search",
      });
      return [];
    }
  }

  /**
   * Rerank chunk candidates using LLM (chunk-level reranking)
   *
   * Strategy: Send top 25 chunks to reranker to avoid missing relevant content.
   * The reranker returns scores and reasoning for these candidates, while
   * remaining chunks keep their original vector scores with a small penalty.
   */
  private async rerankChunksWithLLM(
    query: string,
    chunks: ChunkSearchResult[],
    reranker: Reranker,
  ): Promise<ChunkSearchResult[]> {
    // Increased from 10 to 25 to reduce ranking degradation
    const RERANK_LIMIT = 25;

    try {
      // NOTE: The reranker types are "noteId"-based. For chunk-level reranking, we
      // encode chunkId into the noteId field and map it back afterwards.
      const candidates: RerankCandidate[] = chunks.slice(0, RERANK_LIMIT).map((c) => ({
        noteId: c.chunkId,
        path: c.path,
        title: c.headingPath.length ? `${c.title} — ${c.headingPath.join(" > ")}` : c.title,
        text: this.truncateForRerank(c.text),
        originalScore: c.score,
      }));

      const ranked = await reranker.rerank(query, candidates);

      if (!ranked.length) return chunks;

      const scores = new Map<string, { score: number; reasoning: string }>();
      for (const r of ranked) {
        scores.set(r.noteId, { score: r.score, reasoning: r.reasoning });
      }

      const rerankedChunks: ChunkSearchResult[] = [];
      for (const c of chunks) {
        const rr = scores.get(c.chunkId);
        if (rr) {
          rerankedChunks.push({ ...c, score: rr.score, reasoning: rr.reasoning });
        } else {
          // Chunks outside the rerank window keep their vector scores
          // Apply a small penalty to ensure reranked results are prioritized
          const penalizedScore = c.score * 0.85;
          rerankedChunks.push({ ...c, score: penalizedScore, reasoning: "Vector similarity" });
        }
      }

      rerankedChunks.sort((a, b) => b.score - a.score);
      return rerankedChunks;
    } catch (error) {
      console.warn("[SearchPipeline] LLM reranking failed, using vector scores:", error);
      return chunks;
    }
  }

  private truncateForRerank(text: string): string {
    const MAX = 1200;
    if (text.length <= MAX) return text;
    return `${text.slice(0, MAX).trimEnd()}…`;
  }

  /**
   * Get file modification time by path
   */
  private getFileMtime(path: string): number {
    const file = this.kernel.obsidian.getFileByPath(path);
    return file?.stat.mtime ?? 0;
  }

  private aggregateChunksToNotes(
    chunks: ChunkSearchResult[],
    opts: { maxChunksPerNote: number },
  ): SearchResult[] {
    const noteMap: Map<string, SearchResult> = new Map();

    for (const chunk of chunks) {
      const existing = noteMap.get(chunk.noteId);
      if (existing) {
        existing.chunks.push(chunk);
        if (chunk.score > existing.bestScore) {
          existing.bestScore = chunk.score;
          existing.reasoning = chunk.reasoning;
        }
      } else {
        noteMap.set(chunk.noteId, {
          noteId: chunk.noteId,
          path: chunk.path,
          title: chunk.title,
          bestScore: chunk.score,
          paraType: chunk.paraType,
          chunks: [chunk],
          mtimeMs: this.getFileMtime(chunk.path),
          reasoning: chunk.reasoning,
        });
      }
    }

    const results = Array.from(noteMap.values());
    for (const r of results) {
      r.chunks.sort((a, b) => b.score - a.score);
      r.chunks = r.chunks.slice(0, Math.max(1, opts.maxChunksPerNote));
    }

    results.sort((a, b) => b.bestScore - a.bestScore);
    return results;
  }

  /**
   * Find notes related to a given note
   */
  async findRelated(
    path: string,
    options: { topK?: number; minScore?: number } = {},
  ): Promise<RelatedNote[]> {
    if (this.disposed) return [];

    // Create abort controller for this operation
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const topK = options.topK ?? 5;
    const minScore = options.minScore ?? 0.4;

    try {
      // Get the note's content and metadata
      const content = await this.kernel.obsidian.readFileByPath(path);
      if (!content) return [];

      const metadata = this.kernel.obsidian.getMetadataByPath(path);
      const noteTags = metadata?.tags ?? [];

      // Use the note content as the query (or a summary)
      const queryText = content.slice(0, 1000); // First 1000 chars as representative
      const queryEmbedding = await this.getQueryEmbedding(queryText);
      if (signal.aborted) return [];

      // Search for similar notes (tier=note) when available
      const chunkResults = await this.vectorStore.search(queryEmbedding, {
        topK: topK * 3, // Get more to filter out self
        minScore,
        includeContent: false,
        tier: "note",
      });

      // Filter out the source note and group by note
      const noteScores: Map<
        string,
        { path: string; title: string; scores: number[]; paraType: ChunkSearchResult["paraType"] }
      > = new Map();

      for (const chunk of chunkResults) {
        if (chunk.path === path) continue; // Skip self

        const existing = noteScores.get(chunk.noteId);
        if (existing) {
          existing.scores.push(chunk.score);
        } else {
          noteScores.set(chunk.noteId, {
            path: chunk.path,
            title: chunk.title,
            scores: [chunk.score],
            paraType: chunk.paraType,
          });
        }
      }

      // Calculate aggregate scores and convert to RelatedNote
      const relatedNotes: RelatedNote[] = [];

      for (const [, data] of noteScores) {
        // Average score across chunks
        const avgScore = data.scores.reduce((a, b) => a + b, 0) / data.scores.length;

        // Get metadata for shared tags
        const relatedMeta = this.kernel.obsidian.getMetadataByPath(data.path);
        const relatedTags = relatedMeta?.tags ?? [];
        const sharedTags = noteTags.filter((t) => relatedTags.includes(t));

        // Check for direct link
        const hasDirectLink =
          metadata?.links?.some((l) => l.includes(data.path.replace(".md", ""))) ?? false;

        relatedNotes.push({
          path: data.path,
          title: data.title,
          score: avgScore,
          paraType: data.paraType,
          sharedTags,
          hasDirectLink,
        });
      }

      // Sort by score and limit
      relatedNotes.sort((a, b) => b.score - a.score);
      return relatedNotes.slice(0, topK);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[SearchPipeline] findRelated failed:", message);
      this.eventBus.emit("search:error", {
        query: path,
        error: message,
        operation: "findRelated",
      });
      return [];
    }
  }

  /**
   * Get embedding for a query (with caching)
   */
  private async getQueryEmbedding(query: string): Promise<number[]> {
    const cached = this.embeddingCache.get(query);
    if (cached) return cached;

    const { embedding } = await this.ollamaService.embed(query);

    // LRU cache management
    if (this.embeddingCache.size >= CACHE_CONFIG.MAX_QUERY_CACHE_SIZE) {
      const firstKey = this.embeddingCache.keys().next().value;
      if (firstKey) this.embeddingCache.delete(firstKey);
    }

    this.embeddingCache.set(query, embedding);
    return embedding;
  }

  /**
   * Generate cache key for query + options.
   * Includes all options that affect results, including reranking flag.
   */
  private getCacheKey(query: string, options: SearchOptions, enableReranking = false): string {
    return JSON.stringify({
      query: query.toLowerCase().trim(),
      topK: options.topK,
      minScore: options.minScore,
      paraType: options.paraType,
      // Create copies before sorting to avoid mutating caller's arrays
      folderPaths: options.folderPaths?.slice().sort(),
      tags: options.tags?.slice().sort(),
      // Include reranking flag to avoid cache key collisions
      enableReranking,
    });
  }

  /**
   * Update result cache with LRU eviction.
   * LRU: evict least recently USED (not inserted) when capacity is reached.
   */
  private updateCache(key: string, results: SearchResult[], embedding: number[]): void {
    // LRU: If key already exists, delete it first to update its position
    if (this.queryCache.has(key)) {
      this.queryCache.delete(key);
    }

    // LRU eviction: remove oldest entry when at capacity
    if (this.queryCache.size >= CACHE_CONFIG.MAX_SEARCH_CACHE_SIZE) {
      // Find the entry with the oldest timestamp (least recently used)
      let oldestKey: string | null = null;
      let oldestTime = Number.POSITIVE_INFINITY;
      for (const [k, v] of this.queryCache.entries()) {
        if (v.timestamp < oldestTime) {
          oldestTime = v.timestamp;
          oldestKey = k;
        }
      }
      if (oldestKey) this.queryCache.delete(oldestKey);
    }

    this.queryCache.set(key, {
      results,
      timestamp: Date.now(),
      queryEmbedding: embedding,
    });
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.queryCache.clear();
    this.embeddingCache.clear();
  }

  /**
   * Dispose of the pipeline and abort any pending operations
   */
  dispose(): void {
    this.disposed = true;
    this.abortController?.abort();
    this.abortController = null;
    this.clearCache();
  }
}
