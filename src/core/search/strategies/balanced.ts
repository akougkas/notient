/**
 * Balanced Search Strategy
 *
 * Combines vector similarity search with optional LLM reranking.
 * Target latency: <2s
 *
 * Pipeline:
 * 1. Generate query embedding (Ollama)
 * 2. Vector similarity search (VectorStore)
 * 3. LLM reranking (LM Studio, if available)
 * 4. Aggregate chunks to notes
 *
 * Falls back to Quick search if embeddings unavailable.
 */

import type { LMStudioService } from "../../../services/lmstudio";
import type { OllamaRerankerService } from "../../../services/ollamaReranker";
import type { ChunkSearchResult, SearchResult } from "../../../types/search";
import { SEARCH_LIMITS } from "../../constants";
import type { LLMProvider } from "../../llm/provider";
import type { RankedResult, RerankCandidate } from "../../llm/types";
import { NativeSearch } from "./native";
import type {
  SearchProgress,
  SearchStrategy,
  StrategyContext,
  StrategySearchOptions,
} from "./types";

/** Reranker abstraction (OllamaRerankerService, LLMProvider, or legacy LMStudioService) */
type Reranker = {
  rerank: (query: string, candidates: RerankCandidate[]) => Promise<RankedResult[]>;
};

/**
 * Balanced search strategy - vector search with LLM reranking
 */
export class BalancedSearchStrategy implements SearchStrategy {
  readonly name = "balanced" as const;
  readonly description = "Vector search with AI reranking";
  readonly targetLatencyMs = 2000;

  private nativeSearch: NativeSearch;
  /** Embedding cache for query deduplication */
  private embeddingCache: Map<string, number[]> = new Map();
  private readonly MAX_EMBEDDING_CACHE = 50;

  constructor(private context: StrategyContext) {
    this.nativeSearch = new NativeSearch(context.kernel.obsidian, (path) => this.getParaType(path));
  }

  /**
   * Check if vector search is available
   */
  isAvailable(): boolean {
    return this.context.ollamaService?.isReady() ?? false;
  }

  /**
   * Execute balanced search with vector similarity and reranking
   */
  async search(
    query: string,
    options: StrategySearchOptions,
    onProgress?: (progress: SearchProgress) => void,
  ): Promise<SearchResult[]> {
    const startTime = performance.now();
    const enableReranking = true; // Balanced always attempts reranking

    console.log(`[BalancedSearchStrategy] Starting search for: "${query}"`);

    // Check if embeddings are available
    if (!this.isAvailable()) {
      console.warn(
        "[BalancedSearchStrategy] Embeddings unavailable, falling back to native search",
      );
      onProgress?.({ stage: "native", detail: "Falling back to native search..." });

      const nativeMatches = await this.nativeSearch.search(query, options);
      return this.convertNativeToResults(nativeMatches, options);
    }

    try {
      // Phase 1: Query embedding
      onProgress?.({ stage: "embedding", detail: "Generating query embedding..." });
      const queryEmbedding = await this.getQueryEmbedding(query);
      if (options.signal?.aborted) return [];

      // Graceful fallback if embedding failed
      if (!queryEmbedding) {
        console.log("[BalancedSearchStrategy] No embedding, using native search fallback");
        onProgress?.({ stage: "native", detail: "Using native search..." });
        const nativeMatches = await this.nativeSearch.search(query, options);
        return this.convertNativeToResults(nativeMatches, options);
      }

      // Phase 2: Vector search - hierarchical retrieval (TSI v2)
      onProgress?.({ stage: "vector-search", detail: "Searching vector store..." });
      const chunkCandidates = await this.performVectorSearch(
        queryEmbedding,
        query,
        options,
        enableReranking,
      );
      if (options.signal?.aborted) return [];

      if (chunkCandidates.length === 0) {
        console.log("[BalancedSearchStrategy] No vector results, falling back to native search");
        onProgress?.({ stage: "native", detail: "No vector results, using native search..." });
        const nativeMatches = await this.nativeSearch.search(query, options);
        return this.convertNativeToResults(nativeMatches, options);
      }

      // Phase 3: LLM reranking (if available)
      let results: SearchResult[];
      const reranker = this.getReranker();

      if (enableReranking && reranker && chunkCandidates.length > 0) {
        onProgress?.({
          stage: "reranking",
          detail: `Reranking ${chunkCandidates.length} chunks...`,
        });
        const rerankedChunks = await this.rerankChunks(query, chunkCandidates, reranker);
        onProgress?.({ stage: "aggregating" });
        results = this.aggregateChunksToNotes(rerankedChunks, { maxChunksPerNote: 3 });
      } else {
        // No reranker: aggregate by vector score
        onProgress?.({ stage: "aggregating" });
        results = this.aggregateChunksToNotes(chunkCandidates, { maxChunksPerNote: 3 });
      }

      // Limit to requested topK
      results = results.slice(0, options.topK);

      const elapsed = performance.now() - startTime;
      console.log(
        `[BalancedSearchStrategy] Completed in ${elapsed.toFixed(0)}ms with ${results.length} results (reranked: ${Boolean(reranker)})`,
      );

      return results;
    } catch (error) {
      // Graceful degradation to native search
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[BalancedSearchStrategy] Vector search failed: ${message}`);
      console.log("[BalancedSearchStrategy] Falling back to native search");

      onProgress?.({ stage: "native", detail: "Falling back to native search..." });
      const nativeMatches = await this.nativeSearch.search(query, options);
      return this.convertNativeToResults(nativeMatches, options);
    }
  }

  /**
   * Get or create query embedding with caching
   * Returns null if embedding unavailable (graceful degradation)
   */
  private async getQueryEmbedding(query: string): Promise<number[] | null> {
    const cached = this.embeddingCache.get(query);
    if (cached) return cached;

    // Use tryEmbed for graceful degradation
    const result = await this.context.ollamaService.tryEmbed(query);
    if (!result) {
      console.warn("[BalancedSearchStrategy] Embedding unavailable, will fall back to native");
      return null;
    }

    const embedding = result.embedding;

    // LRU cache management
    if (this.embeddingCache.size >= this.MAX_EMBEDDING_CACHE) {
      const firstKey = this.embeddingCache.keys().next().value;
      if (firstKey) this.embeddingCache.delete(firstKey);
    }

    this.embeddingCache.set(query, embedding);
    return embedding;
  }

  /**
   * Perform hierarchical vector search (TSI v2)
   */
  private async performVectorSearch(
    queryEmbedding: number[],
    queryText: string,
    options: StrategySearchOptions,
    enableReranking: boolean,
  ): Promise<ChunkSearchResult[]> {
    const baseFilters = {
      minScore: options.minScore,
      includeContent: options.includeContent,
      paraType: options.paraType,
      folderPaths: options.folderPaths,
      tags: options.tags,
      queryText,
    };

    // Stage 1: Find candidate notes
    const noteCandidateK = enableReranking ? 80 : Math.max(40, options.topK * 4);
    const noteCandidates = await this.context.vectorStore.search(queryEmbedding, {
      ...baseFilters,
      topK: noteCandidateK,
      includeContent: false,
      tier: "note",
    });

    const candidateNoteIds = Array.from(new Set(noteCandidates.map((c) => c.noteId)));

    // Stage 2: Get chunks within candidate notes
    const chunkCandidateK = enableReranking
      ? SEARCH_LIMITS.RERANK_CANDIDATE_K
      : Math.max(SEARCH_LIMITS.NO_RERANK_MULTIPLIER, options.topK * 6);
    const chunksPerNote = enableReranking ? 5 : 3;

    let chunkCandidates = await this.context.vectorStore.search(queryEmbedding, {
      ...baseFilters,
      topK: chunkCandidateK,
      includeContent: true,
      tier: "block",
      noteIds: candidateNoteIds.length ? candidateNoteIds : undefined,
      maxPerNote: candidateNoteIds.length ? chunksPerNote : undefined,
    });

    // Fallback for vaults not yet reindexed with tiered chunks
    if (candidateNoteIds.length === 0 || chunkCandidates.length === 0) {
      chunkCandidates = await this.context.vectorStore.search(queryEmbedding, {
        ...baseFilters,
        topK: enableReranking ? 50 : options.topK,
        includeContent: true,
      });
    }

    return chunkCandidates;
  }

  /**
   * Get reranker service (prioritizes dedicated Ollama reranker, falls back to LLM)
   */
  private getReranker(): Reranker | null {
    // Priority 1: Dedicated Ollama reranker (Qwen3-Reranker-4B)
    const ollamaReranker = this.context.kernel.getService<OllamaRerankerService>("ollamaReranker");
    if (ollamaReranker?.isReady()) {
      return ollamaReranker;
    }

    // Priority 2: LLM Provider (falls back to chat-based reranking)
    const provider = this.context.kernel.getService<LLMProvider>("llmProvider");
    if (provider?.isReady) return provider;

    // Priority 3: Legacy LM Studio service
    const legacy = this.context.kernel.getService<LMStudioService>("lmstudio");
    if (legacy?.isReady()) return legacy;

    return null;
  }

  /**
   * Rerank chunks using LLM
   */
  private async rerankChunks(
    query: string,
    chunks: ChunkSearchResult[],
    reranker: Reranker,
  ): Promise<ChunkSearchResult[]> {
    const RERANK_LIMIT = 25;

    try {
      const candidates: RerankCandidate[] = chunks.slice(0, RERANK_LIMIT).map((c) => ({
        noteId: c.chunkId, // Encode chunkId as noteId for reranker
        path: c.path,
        title: c.headingPath.length ? `${c.title} — ${c.headingPath.join(" > ")}` : c.title,
        text: this.truncateForRerank(c.text),
        originalScore: c.score,
      }));

      const ranked = await reranker.rerank(query, candidates);
      if (!ranked.length) return chunks;

      // Build score map
      const scores = new Map<string, { score: number; reasoning: string }>();
      for (const r of ranked) {
        scores.set(r.noteId, { score: r.score, reasoning: r.reasoning });
      }

      // Apply scores to chunks
      const rerankedChunks: ChunkSearchResult[] = [];
      for (const c of chunks) {
        const rr = scores.get(c.chunkId);
        if (rr) {
          rerankedChunks.push({ ...c, score: rr.score, reasoning: rr.reasoning });
        } else {
          // Chunks outside rerank window keep vector scores with penalty
          const penalizedScore = c.score * 0.85;
          rerankedChunks.push({ ...c, score: penalizedScore, reasoning: "Vector similarity" });
        }
      }

      rerankedChunks.sort((a, b) => b.score - a.score);
      return rerankedChunks;
    } catch (error) {
      console.warn("[BalancedSearchStrategy] Reranking failed:", error);
      return chunks;
    }
  }

  /**
   * Truncate text for reranking prompt
   */
  private truncateForRerank(text: string): string {
    const MAX = 1200;
    if (text.length <= MAX) return text;
    return `${text.slice(0, MAX).trimEnd()}…`;
  }

  /**
   * Aggregate chunks into note-level results
   */
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

    // Limit chunks per note
    for (const r of results) {
      r.chunks.sort((a, b) => b.score - a.score);
      r.chunks = r.chunks.slice(0, Math.max(1, opts.maxChunksPerNote));
    }

    results.sort((a, b) => b.bestScore - a.bestScore);
    return results;
  }

  /**
   * Get file modification time
   */
  private getFileMtime(path: string): number {
    const file = this.context.kernel.obsidian.getFileByPath(path);
    return file?.stat.mtime ?? 0;
  }

  /**
   * Convert native matches to SearchResult format
   */
  private convertNativeToResults(
    matches: { path: string; title: string; score: number; snippet?: string }[],
    options: StrategySearchOptions,
  ): SearchResult[] {
    return matches.slice(0, options.topK).map((m) => ({
      noteId: this.pathToNoteId(m.path),
      path: m.path,
      title: m.title,
      bestScore: m.score,
      paraType: this.getParaType(m.path),
      mtimeMs: this.getFileMtime(m.path),
      reasoning: "Native search fallback",
      chunks: [
        {
          chunkId: `${this.pathToNoteId(m.path)}-native`,
          noteId: this.pathToNoteId(m.path),
          path: m.path,
          title: m.title,
          headingPath: [],
          tier: "note" as const,
          kind: "paragraph" as const,
          parentChunkId: null,
          blockRef: null,
          startLine: null,
          endLine: null,
          tokenEstimate: 0,
          text: m.snippet ?? "",
          score: m.score,
          paraType: this.getParaType(m.path),
          reasoning: "Native search fallback",
        },
      ],
    }));
  }

  /**
   * Convert path to note ID
   */
  private pathToNoteId(path: string): string {
    let hash = 0;
    for (let i = 0; i < path.length; i++) {
      const char = path.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return `native-${Math.abs(hash).toString(36)}`;
  }

  /**
   * Get PARA type from path
   */
  private getParaType(path: string): SearchResult["paraType"] {
    if (!path) return "unknown";

    const para = this.context.kernel.settings.para;
    const lowerPath = path.toLowerCase();

    // Helper to check folder match with null safety
    const matchesFolder = (
      folders: string[] | undefined,
      type: SearchResult["paraType"],
    ): SearchResult["paraType"] | null => {
      if (!folders) return null;
      for (const folder of folders) {
        if (!folder) continue;
        const lowerFolder = folder.toLowerCase();
        if (lowerPath.startsWith(`${lowerFolder}/`) || lowerPath === lowerFolder) {
          return type;
        }
      }
      return null;
    };

    return (
      matchesFolder(para.inbox, "inbox") ??
      matchesFolder(para.projects, "projects") ??
      matchesFolder(para.areas, "areas") ??
      matchesFolder(para.resources, "resources") ??
      matchesFolder(para.archive, "archive") ??
      "unknown"
    );
  }
}
