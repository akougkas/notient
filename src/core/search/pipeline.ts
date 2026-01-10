/**
 * Search Pipeline
 *
 * Orchestrates search strategies based on user preferences.
 * Implements the Strategy pattern for flexible search modes:
 * - Quick: Native Obsidian search (<100ms, no AI)
 * - Balanced: Vector search + LLM reranking (<2s)
 * - Deep/Thorough: Agentic search with expansion (<10s)
 *
 * Features:
 * - Automatic fallback chain (Deep → Balanced → Quick)
 * - Result caching with LRU eviction
 * - Progress events for UI updates
 */

import type { OllamaService } from "../../services/ollama";
import type { VectorStore } from "../../services/vectorStore";
import type {
  RelatedNote,
  SearchOptions,
  SearchResult,
  ChunkSearchResult,
} from "../../types/search";
import { SEARCH_PRESETS, type SearchPreset } from "../../types/settings";
import { CACHE_CONFIG } from "../constants";
import type { EventBus } from "../events/eventBus";
import type { Kernel } from "../kernel";
import {
  BalancedSearchStrategy,
  DeepSearchStrategy,
  QuickSearchStrategy,
  type SearchStrategy,
  type StrategyContext,
  type StrategySearchOptions,
} from "./strategies";

interface CacheEntry {
  results: SearchResult[];
  timestamp: number;
  preset: SearchPreset;
}

/** Extended search options with reranking control */
export interface ExtendedSearchOptions extends SearchOptions {
  enableReranking?: boolean;
}

/**
 * Search pipeline with strategy-based execution
 */
export class SearchPipeline {
  private queryCache: Map<string, CacheEntry> = new Map();
  private disposed = false;
  private abortController: AbortController | null = null;

  /** Search strategies by mode */
  private strategies: Map<SearchPreset, SearchStrategy> = new Map();
  private strategyContext: StrategyContext;

  constructor(
    private kernel: Kernel,
    private eventBus: EventBus,
    private ollamaService: OllamaService,
    private vectorStore: VectorStore,
  ) {
    // Create strategy context
    this.strategyContext = {
      kernel,
      eventBus,
      ollamaService,
      vectorStore,
    };

    // Initialize strategies
    this.initializeStrategies();
  }

  /**
   * Initialize search strategies
   */
  private initializeStrategies(): void {
    this.strategies.set("quick", new QuickSearchStrategy(this.strategyContext));
    this.strategies.set("balanced", new BalancedSearchStrategy(this.strategyContext));
    this.strategies.set("thorough", new DeepSearchStrategy(this.strategyContext));

    console.log("[SearchPipeline] Strategies initialized: quick, balanced, thorough");
  }

  /**
   * Initialize the pipeline
   */
  async initialize(): Promise<void> {
    // Strategies are initialized in constructor
    console.log("[SearchPipeline] Ready");
  }

  /**
   * Perform a search using the configured strategy
   */
  async search(
    query: string,
    options: Partial<ExtendedSearchOptions> = {},
  ): Promise<SearchResult[]> {
    if (this.disposed) return [];

    // Create abort controller for this search
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    // Get current preset and settings
    const searchSettings = this.kernel.settings.search;
    // Map "custom" preset to "balanced" behavior
    const rawPreset = searchSettings.preset;
    const preset: "quick" | "balanced" | "thorough" =
      rawPreset === "custom" ? "balanced" : rawPreset;

    // Get defaults from preset
    const defaults = preset in SEARCH_PRESETS
      ? SEARCH_PRESETS[preset as keyof typeof SEARCH_PRESETS]
      : searchSettings.custom;

    const enableReranking = options.enableReranking ?? defaults.enableReranking;
    const topK = options.topK ?? defaults.topK;
    const minScore = options.minScore ?? defaults.minScore;

    console.log(
      `[SearchPipeline] Search: query="${query.slice(0, 50)}", preset=${preset}, rerank=${enableReranking}, topK=${topK}`,
    );

    const startTime = Date.now();

    // Check cache
    const cacheKey = this.getCacheKey(query, topK, minScore, preset);
    const cached = this.queryCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_CONFIG.SEARCH_CACHE_TTL_MS) {
      // LRU: Update timestamp on cache hit
      cached.timestamp = Date.now();

      this.eventBus.emit("search:complete", {
        query,
        results: cached.results,
        durationMs: Date.now() - startTime,
        cached: true,
      });

      console.log(`[SearchPipeline] Cache hit for "${query}" (${cached.results.length} results)`);
      return cached.results;
    }

    // Emit search started
    this.eventBus.emit("search:started", { query });

    try {
      // Get strategy for preset
      const strategy = this.strategies.get(preset) ?? this.strategies.get("balanced")!;

      // Build strategy options
      const strategyOptions: StrategySearchOptions = {
        topK,
        minScore,
        paraType: options.paraType,
        folderPaths: options.folderPaths,
        tags: options.tags,
        includeContent: options.includeContent ?? true,
        signal,
      };

      // Execute strategy with progress callback
      const results = await strategy.search(query, strategyOptions, (progress) => {
        this.eventBus.emit("search:progress", {
          query,
          stage: progress.stage,
          detail: progress.detail,
        });
      });

      if (signal.aborted) return [];

      // Cache results
      this.updateCache(cacheKey, results, preset);

      // Emit completion
      this.eventBus.emit("search:complete", {
        query,
        results,
        durationMs: Date.now() - startTime,
        cached: false,
        strategy: preset,
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

      // Fallback chain: try simpler strategies on failure
      if (preset === "thorough") {
        console.log("[SearchPipeline] Deep search failed, falling back to balanced");
        return this.searchWithFallback(query, "balanced", options);
      } else if (preset === "balanced") {
        console.log("[SearchPipeline] Balanced search failed, falling back to quick");
        return this.searchWithFallback(query, "quick", options);
      }

      return [];
    }
  }

  /**
   * Fallback search with a different strategy
   */
  private async searchWithFallback(
    query: string,
    fallbackPreset: SearchPreset,
    options: Partial<ExtendedSearchOptions>,
  ): Promise<SearchResult[]> {
    const strategy = this.strategies.get(fallbackPreset);
    if (!strategy) return [];

    const defaults = SEARCH_PRESETS[fallbackPreset as keyof typeof SEARCH_PRESETS] ?? {
      topK: 10,
      minScore: 0.3,
    };

    try {
      return await strategy.search(
        query,
        {
          topK: options.topK ?? defaults.topK,
          minScore: options.minScore ?? defaults.minScore,
          paraType: options.paraType,
          folderPaths: options.folderPaths,
          tags: options.tags,
          includeContent: options.includeContent ?? true,
          signal: this.abortController?.signal,
        },
        (progress) => {
          this.eventBus.emit("search:progress", {
            query,
            stage: progress.stage,
            detail: `Fallback: ${progress.detail}`,
          });
        },
      );
    } catch (error) {
      console.error(`[SearchPipeline] Fallback to ${fallbackPreset} also failed:`, error);
      return [];
    }
  }

  /**
   * Find notes related to a given note (uses balanced strategy internals)
   */
  async findRelated(
    path: string,
    options: { topK?: number; minScore?: number } = {},
  ): Promise<RelatedNote[]> {
    if (this.disposed) return [];

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const topK = options.topK ?? 5;
    const minScore = options.minScore ?? 0.4;

    try {
      // Get note content for query
      const content = await this.kernel.obsidian.readFileByPath(path);
      if (!content) return [];

      const metadata = this.kernel.obsidian.getMetadataByPath(path);
      const noteTags = metadata?.tags ?? [];

      // Use first 1000 chars as query
      const queryText = content.slice(0, 1000);

      // Check if embeddings available
      if (!this.ollamaService.isReady()) {
        console.warn("[SearchPipeline] findRelated: Embeddings unavailable");
        return [];
      }

      // Get embedding
      const { embedding: queryEmbedding } = await this.ollamaService.embed(queryText);
      if (signal.aborted) return [];

      // Search vector store
      const chunkResults = await this.vectorStore.search(queryEmbedding, {
        topK: topK * 3,
        minScore,
        includeContent: false,
        tier: "note",
      });

      // Filter and aggregate
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

      // Build results
      const relatedNotes: RelatedNote[] = [];

      for (const [, data] of noteScores) {
        const avgScore = data.scores.reduce((a, b) => a + b, 0) / data.scores.length;

        // Get shared tags
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
   * Generate cache key
   */
  private getCacheKey(
    query: string,
    topK: number,
    minScore: number,
    preset: SearchPreset,
  ): string {
    return JSON.stringify({
      query: query.toLowerCase().trim(),
      topK,
      minScore,
      preset,
    });
  }

  /**
   * Update cache with LRU eviction
   */
  private updateCache(key: string, results: SearchResult[], preset: SearchPreset): void {
    // Remove existing entry to update position
    if (this.queryCache.has(key)) {
      this.queryCache.delete(key);
    }

    // LRU eviction
    if (this.queryCache.size >= CACHE_CONFIG.MAX_SEARCH_CACHE_SIZE) {
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
      preset,
    });
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.queryCache.clear();
  }

  /**
   * Get available strategies and their status
   */
  getStrategyStatus(): Array<{ name: string; available: boolean; description: string }> {
    return Array.from(this.strategies.entries()).map(([name, strategy]) => ({
      name,
      available: strategy.isAvailable(),
      description: strategy.description,
    }));
  }

  /**
   * Dispose of the pipeline
   */
  dispose(): void {
    this.disposed = true;
    this.abortController?.abort();
    this.abortController = null;
    this.clearCache();
    this.strategies.clear();
  }
}
