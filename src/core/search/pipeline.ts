/**
 * Semantic Search Pipeline
 * 
 * Provides fast semantic search with LLM reranking and caching.
 * Architecture: Vector search (fast) → LLM reranking (smart)
 */

import type { Kernel } from "../kernel";
import type { EventBus } from "../events/eventBus";
import type { OllamaService } from "../../services/ollama";
import type { VectorStore } from "../../services/vectorStore";
import type { LMStudioService } from "../../services/lmstudio";
import type {
  SearchOptions,
  SearchResult,
  ChunkSearchResult,
  RelatedNote,
} from "../../types/search";
import { SEARCH_PRESETS } from "../../types/settings";
import { CACHE_CONFIG } from "../constants";

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

  constructor(
    private kernel: Kernel,
    private eventBus: EventBus,
    private ollamaService: OllamaService,
    private vectorStore: VectorStore
  ) { }

  /**
   * Get LM Studio service (lazy resolution)
   */
  private getLMStudio(): LMStudioService | null {
    return this.kernel.getService<LMStudioService>("lmstudio");
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
    options: Partial<ExtendedSearchOptions> = {}
  ): Promise<SearchResult[]> {
    if (this.disposed) return [];

    // Resolve effective settings from presets vs custom
    const searchSettings = this.kernel.settings.search;
    let defaults = searchSettings.custom;
    if (searchSettings.preset !== 'custom') {
      defaults = SEARCH_PRESETS[searchSettings.preset];
    }

    const enableReranking = options.enableReranking ?? defaults.enableReranking;
    const requestedTopK = options.topK ?? defaults.topK;
    const minScore = options.minScore ?? defaults.minScore;

    const fullOptions: SearchOptions = {
      // Get more candidates for reranking
      topK: enableReranking ? 50 : requestedTopK,
      minScore: minScore,
      includeContent: options.includeContent ?? true,
      paraType: options.paraType,
      folderPaths: options.folderPaths,
      tags: options.tags,
    };

    const startTime = Date.now();
    const cacheKey = this.getCacheKey(query, { ...fullOptions, topK: requestedTopK });

    this.eventBus.emit("search:started", { query });

    // Check cache first
    const cached = this.queryCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_CONFIG.SEARCH_CACHE_TTL_MS) {
      this.eventBus.emit("search:complete", {
        query,
        results: cached.results,
        durationMs: Date.now() - startTime,
        cached: true,
      });
      return cached.results;
    }

    try {
      // Phase 1: Vector search (fast, <100ms)
      const queryEmbedding = await this.getQueryEmbedding(query);
      const chunkResults = await this.vectorStore.search(
        queryEmbedding,
        { ...fullOptions, queryText: query }
      );

      // Group by note
      let results = this.groupByNote(chunkResults);

      // Phase 2: LLM reranking (smart, adds ~500ms)
      const lmStudio = this.getLMStudio();
      if (enableReranking && lmStudio?.isReady() && results.length > 0) {
        results = await this.rerankWithLLM(query, results, lmStudio);
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
        reranked: enableReranking && lmStudio?.isReady(),
      });

      return results;
    } catch (error) {
      console.error("[SearchPipeline] Search failed:", error);
      return [];
    }
  }

  /**
   * Rerank results using LLM
   */
  private async rerankWithLLM(
    query: string,
    results: SearchResult[],
    lmStudio: LMStudioService
  ): Promise<SearchResult[]> {
    try {
      // Build candidates for reranking
      const candidates = results.map((r) => ({
        noteId: r.noteId,
        path: r.path,
        title: r.title,
        text: r.chunks[0]?.text || r.title,
        originalScore: r.bestScore,
      }));

      // Get reranked results
      const reranked = await lmStudio.rerank(query, candidates);

      // Map back to SearchResult format
      const rerankedResults: SearchResult[] = [];
      for (const ranked of reranked) {
        const original = results.find((r) => r.noteId === ranked.noteId);
        if (original) {
          rerankedResults.push({
            ...original,
            bestScore: ranked.score,
            reasoning: ranked.reasoning,
          });
        }
      }

      return rerankedResults;
    } catch (error) {
      console.warn("[SearchPipeline] LLM reranking failed, using vector scores:", error);
      return results;
    }
  }

  /**
   * Find notes related to a given note
   */
  async findRelated(
    path: string,
    options: { topK?: number; minScore?: number } = {}
  ): Promise<RelatedNote[]> {
    if (this.disposed) return [];

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

      // Search for similar chunks
      const chunkResults = await this.vectorStore.search(queryEmbedding, {
        topK: topK * 3, // Get more to filter out self
        minScore,
        includeContent: false,
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
        const avgScore =
          data.scores.reduce((a, b) => a + b, 0) / data.scores.length;

        // Get metadata for shared tags
        const relatedMeta = this.kernel.obsidian.getMetadataByPath(data.path);
        const relatedTags = relatedMeta?.tags ?? [];
        const sharedTags = noteTags.filter((t) => relatedTags.includes(t));

        // Check for direct link
        const hasDirectLink =
          metadata?.links?.some((l) => l.includes(data.path.replace(".md", ""))) ??
          false;

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
      console.error("[SearchPipeline] findRelated failed:", error);
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
   * Group chunk results by note
   */
  private groupByNote(chunks: ChunkSearchResult[]): SearchResult[] {
    const noteMap: Map<string, SearchResult> = new Map();

    for (const chunk of chunks) {
      const existing = noteMap.get(chunk.noteId);

      if (existing) {
        existing.chunks.push(chunk);
        if (chunk.score > existing.bestScore) {
          existing.bestScore = chunk.score;
        }
      } else {
        noteMap.set(chunk.noteId, {
          noteId: chunk.noteId,
          path: chunk.path,
          title: chunk.title,
          bestScore: chunk.score,
          paraType: chunk.paraType,
          chunks: [chunk],
          mtimeMs: 0, // TODO: get from file
        });
      }
    }

    // Sort by best score
    const results = Array.from(noteMap.values());
    results.sort((a, b) => b.bestScore - a.bestScore);

    return results;
  }

  /**
   * Generate cache key for query + options
   */
  private getCacheKey(query: string, options: SearchOptions): string {
    return JSON.stringify({
      query: query.toLowerCase().trim(),
      topK: options.topK,
      minScore: options.minScore,
      paraType: options.paraType,
      folderPaths: options.folderPaths?.sort(),
      tags: options.tags?.sort(),
    });
  }

  /**
   * Update result cache
   */
  private updateCache(
    key: string,
    results: SearchResult[],
    embedding: number[]
  ): void {
    // LRU management
    if (this.queryCache.size >= CACHE_CONFIG.MAX_SEARCH_CACHE_SIZE) {
      const firstKey = this.queryCache.keys().next().value;
      if (firstKey) this.queryCache.delete(firstKey);
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
   * Dispose of the pipeline
   */
  dispose(): void {
    this.disposed = true;
    this.clearCache();
  }
}
