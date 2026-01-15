/**
 * Deep Search Strategy
 *
 * Comprehensive agentic search with query expansion and graph traversal.
 * Target latency: <10s
 *
 * Pipeline:
 * 1. Everything from Balanced (vector + rerank)
 * 2. Query expansion via LLM (generate related terms)
 * 3. Graph traversal (find notes linked from top results)
 * 4. Second-pass reranking with expanded context
 * 5. Reasoning explanations for results
 *
 * Falls back to Balanced if LLM unavailable for expansion.
 */

import type { OllamaReranker, RerankCandidate } from "../../../services/ollamaReranker";
import type { ChunkSearchResult, SearchResult } from "../../../types/search";
import type { LLMProvider } from "../../llm/provider";
import type { ChatMessage } from "../../llm/types";
import { BalancedSearchStrategy } from "./balanced";
import { NativeSearch } from "./native";
import type {
  SearchProgress,
  SearchStrategy,
  StrategyContext,
  StrategySearchOptions,
} from "./types";

/** LLM abstraction for query expansion */
type LLMChat = {
  complete(messages: ChatMessage[]): Promise<string>;
};

/**
 * Deep search strategy - agentic search with query expansion
 */
export class DeepSearchStrategy implements SearchStrategy {
  readonly name = "thorough" as const;
  readonly description = "Deep search with query expansion and graph traversal";
  readonly targetLatencyMs = 10000;

  private balancedStrategy: BalancedSearchStrategy;
  private nativeSearch: NativeSearch;

  constructor(private context: StrategyContext) {
    this.balancedStrategy = new BalancedSearchStrategy(context);
    this.nativeSearch = new NativeSearch(context.kernel.obsidian, (path) => this.getParaType(path));
  }

  /**
   * Deep search is available if either embeddings or LLM is available
   */
  isAvailable(): boolean {
    return this.context.ollamaService?.isReady() ?? false;
  }

  /**
   * Execute deep search with expansion and graph traversal
   */
  async search(
    query: string,
    options: StrategySearchOptions,
    onProgress?: (progress: SearchProgress) => void,
  ): Promise<SearchResult[]> {
    const startTime = performance.now();
    console.log(`[DeepSearchStrategy] Starting deep search for: "${query}"`);

    // Phase 1: Run balanced search first (vector + rerank)
    onProgress?.({ stage: "vector-search", detail: "Running initial vector search..." });
    const initialResults = await this.balancedStrategy.search(query, {
      ...options,
      topK: Math.max(options.topK * 2, 20), // Get more for expansion
    });

    if (options.signal?.aborted) return [];

    // Phase 2: Query expansion via LLM
    let expandedTerms: string[] = [];
    const llm = this.getLLMChat();

    if (llm) {
      onProgress?.({ stage: "expanding", detail: "Generating related search terms..." });
      try {
        expandedTerms = await this.expandQuery(query, initialResults, llm);
        console.log(`[DeepSearchStrategy] Expanded terms: ${expandedTerms.join(", ")}`);
      } catch (error) {
        console.warn("[DeepSearchStrategy] Query expansion failed:", error);
      }
    }

    if (options.signal?.aborted) return [];

    // Phase 3: Search with expanded terms
    let expandedResults: SearchResult[] = [];
    if (expandedTerms.length > 0) {
      onProgress?.({
        stage: "vector-search",
        detail: `Searching expanded terms: ${expandedTerms.slice(0, 3).join(", ")}...`,
      });
      expandedResults = await this.searchExpandedTerms(expandedTerms, options);
    }

    if (options.signal?.aborted) return [];

    // Phase 4: Graph traversal - find linked notes from top results
    onProgress?.({ stage: "graph", detail: "Exploring connected notes..." });
    const graphResults = await this.exploreGraph(initialResults.slice(0, 5), options);

    if (options.signal?.aborted) return [];

    // Phase 5: Merge and deduplicate all results
    onProgress?.({ stage: "aggregating", detail: "Merging results..." });
    const mergedResults = this.mergeResults(
      initialResults,
      expandedResults,
      graphResults,
      expandedTerms,
    );

    // Phase 6: Final reranking with full context (if LLM available)
    let finalResults = mergedResults;
    const reranker = this.getReranker();

    if (reranker && mergedResults.length > 5) {
      onProgress?.({
        stage: "reranking",
        detail: "Final reranking with reasoning...",
      });
      try {
        finalResults = await this.finalRerank(query, mergedResults, reranker, expandedTerms);
      } catch (error) {
        console.warn("[DeepSearchStrategy] Final reranking failed:", error);
      }
    }

    // Limit to requested topK
    finalResults = finalResults.slice(0, options.topK);

    const elapsed = performance.now() - startTime;
    console.log(
      `[DeepSearchStrategy] Completed in ${elapsed.toFixed(0)}ms with ${finalResults.length} results ` +
        `(initial: ${initialResults.length}, expanded: ${expandedResults.length}, graph: ${graphResults.length})`,
    );

    return finalResults;
  }

  /**
   * Expand query using LLM to generate related search terms
   */
  private async expandQuery(
    query: string,
    initialResults: SearchResult[],
    llm: LLMChat,
  ): Promise<string[]> {
    // Build context from initial results
    const topTitles = initialResults.slice(0, 5).map((r) => r.title);

    const prompt = `Given the search query "${query}" and these top matching notes:
${topTitles.map((t, i) => `${i + 1}. ${t}`).join("\n")}

Generate 3-5 related search terms that could find additional relevant notes.
Focus on:
- Synonyms and related concepts
- Specific aspects of the topic
- Common terminology variations

Return ONLY a JSON array of strings, no explanation.
Example: ["term1", "term2", "term3"]`;

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: "You generate search expansion terms. Return only valid JSON arrays.",
      },
      { role: "user", content: prompt },
    ];

    const response = await llm.complete(messages);

    if (!response) {
      return [];
    }

    // Parse JSON array from response
    try {
      const match = response.match(/\[[\s\S]*\]/);
      if (match) {
        const terms = JSON.parse(match[0]) as string[];
        // Filter and deduplicate
        return terms
          .filter((t) => typeof t === "string" && t.length > 2)
          .map((t) => t.toLowerCase().trim())
          .filter((t, i, arr) => arr.indexOf(t) === i)
          .slice(0, 5);
      }
    } catch {
      // Try line-by-line parsing as fallback
      const lines = response.split("\n").filter((l) => l.trim());
      return lines
        .map((l) => l.replace(/^[-*\d.)\s]+/, "").trim())
        .filter((l) => l.length > 2 && l.length < 50)
        .slice(0, 5);
    }

    return [];
  }

  /**
   * Search for expanded terms
   */
  private async searchExpandedTerms(
    terms: string[],
    options: StrategySearchOptions,
  ): Promise<SearchResult[]> {
    const allResults: SearchResult[] = [];

    for (const term of terms.slice(0, 3)) {
      // Limit to 3 terms
      if (options.signal?.aborted) break;

      try {
        const results = await this.balancedStrategy.search(term, {
          ...options,
          topK: Math.min(options.topK, 5), // Get fewer per term
        });

        // Mark results with expanded term
        for (const r of results) {
          r.reasoning = `Found via expanded term: "${term}"`;
        }

        allResults.push(...results);
      } catch (error) {
        console.warn(`[DeepSearchStrategy] Expanded search failed for "${term}":`, error);
      }
    }

    return allResults;
  }

  /**
   * Explore graph connections from top results
   */
  private async exploreGraph(
    topResults: SearchResult[],
    options: StrategySearchOptions,
  ): Promise<SearchResult[]> {
    const graphResults: SearchResult[] = [];
    const seenPaths = new Set(topResults.map((r) => r.path));

    for (const result of topResults) {
      if (options.signal?.aborted) break;
      if (graphResults.length >= options.topK) break;

      const newResults = this.exploreLinksFromResult(
        result,
        seenPaths,
        options.topK - graphResults.length,
      );
      graphResults.push(...newResults);
    }

    return graphResults;
  }

  /**
   * Explore links from a single result
   */
  private exploreLinksFromResult(
    result: SearchResult,
    seenPaths: Set<string>,
    maxResults: number,
  ): SearchResult[] {
    const metadata = this.context.kernel.obsidian.getMetadataByPath(result.path);
    if (!metadata?.links) return [];

    const results: SearchResult[] = [];
    const linksToExplore = metadata.links.slice(0, 5);

    for (const link of linksToExplore) {
      if (results.length >= maxResults) break;

      const graphResult = this.createGraphResultFromLink(link, result, seenPaths);
      if (graphResult) {
        results.push(graphResult);
      }
    }

    return results;
  }

  /**
   * Create a graph result from a link if valid
   */
  private createGraphResultFromLink(
    link: string,
    sourceResult: SearchResult,
    seenPaths: Set<string>,
  ): SearchResult | null {
    const linkedPath = this.resolveLink(link, sourceResult.path);
    if (!linkedPath || seenPaths.has(linkedPath)) return null;

    seenPaths.add(linkedPath);

    const linkedFile = this.context.kernel.obsidian.getFileByPath(linkedPath);
    if (!linkedFile) return null;

    const derivedScore = sourceResult.bestScore * 0.7;
    const noteId = this.pathToNoteId(linkedPath);
    const reasoning = `Linked from "${sourceResult.title}"`;

    return {
      noteId,
      path: linkedPath,
      title: linkedFile.basename,
      bestScore: derivedScore,
      paraType: this.getParaType(linkedPath),
      mtimeMs: linkedFile.stat.mtime,
      reasoning,
      chunks: [this.createGraphChunk(linkedPath, linkedFile.basename, derivedScore, reasoning)],
    };
  }

  /**
   * Create a chunk for a graph result
   */
  private createGraphChunk(
    path: string,
    title: string,
    score: number,
    reasoning: string,
  ): ChunkSearchResult {
    const noteId = this.pathToNoteId(path);
    return {
      chunkId: `${noteId}-graph`,
      noteId,
      path,
      title,
      headingPath: [],
      tier: "note" as const,
      kind: "paragraph" as const,
      parentChunkId: null,
      blockRef: null,
      startLine: null,
      endLine: null,
      tokenEstimate: 0,
      text: "",
      score,
      paraType: this.getParaType(path),
      reasoning,
    };
  }

  /**
   * Resolve a wiki-style link to a full path
   */
  private resolveLink(link: string, sourcePath: string): string | null {
    // Handle various link formats: [[note]], [[folder/note]], [[note.md]]
    let target = link
      .replace(/^\[\[|\]\]$/g, "")
      .split("|")[0]
      .split("#")[0]
      .trim();

    // If it doesn't have an extension, add .md
    if (!target.endsWith(".md")) {
      target = `${target}.md`;
    }

    // Try exact path first
    if (this.context.kernel.obsidian.getFileByPath(target)) {
      return target;
    }

    // Try relative to source
    const sourceFolder = sourcePath.split("/").slice(0, -1).join("/");
    if (sourceFolder) {
      const relativePath = `${sourceFolder}/${target}`;
      if (this.context.kernel.obsidian.getFileByPath(relativePath)) {
        return relativePath;
      }
    }

    // Search all files for matching basename
    const files = this.context.kernel.obsidian.getMarkdownFiles();
    const basename = target.replace(/\.md$/, "").toLowerCase();
    const match = files.find((f) => f.basename.toLowerCase() === basename);

    return match?.path ?? null;
  }

  /**
   * Merge results from different sources with deduplication
   */
  private mergeResults(
    initial: SearchResult[],
    expanded: SearchResult[],
    graph: SearchResult[],
    expandedTerms: string[],
  ): SearchResult[] {
    const seen = new Map<string, SearchResult>();

    // Add initial results (highest priority)
    for (const r of initial) {
      seen.set(r.path, r);
    }

    // Add expanded results (boost score if matches expanded terms)
    for (const r of expanded) {
      const existing = seen.get(r.path);
      if (existing) {
        // Merge: keep higher score, note that it matched expansion
        if (r.bestScore > existing.bestScore) {
          existing.bestScore = r.bestScore;
        }
        if (r.reasoning?.includes("expanded term")) {
          existing.reasoning = `${existing.reasoning || "Relevant"} (also matched expanded terms)`;
        }
      } else {
        seen.set(r.path, r);
      }
    }

    // Add graph results (lowest priority)
    for (const r of graph) {
      if (!seen.has(r.path)) {
        seen.set(r.path, r);
      }
    }

    // Sort by score
    const results = Array.from(seen.values());
    results.sort((a, b) => b.bestScore - a.bestScore);

    return results;
  }

  /**
   * Final reranking with full context and reasoning
   */
  private async finalRerank(
    query: string,
    results: SearchResult[],
    reranker: OllamaReranker,
    expandedTerms: string[],
  ): Promise<SearchResult[]> {
    const RERANK_LIMIT = 15;

    // Build candidates in OllamaReranker format: {id, text, score?}
    const candidates: RerankCandidate[] = results.slice(0, RERANK_LIMIT).map((r) => ({
      id: r.noteId,
      text: this.truncateForRerank(r.chunks[0]?.text ?? r.title),
      score: r.bestScore,
    }));

    // Enhance query with expanded terms for reranking
    const enhancedQuery =
      expandedTerms.length > 0 ? `${query} (related: ${expandedTerms.join(", ")})` : query;

    const ranked = await reranker.rerank(enhancedQuery, candidates);
    if (!ranked.length) return results;

    // Apply rankings - OllamaReranker returns {id, score, reasoning?}
    const scoreMap = new Map<string, { score: number; reasoning?: string }>();
    for (const r of ranked) {
      scoreMap.set(r.id, { score: r.score, reasoning: r.reasoning });
    }

    for (const result of results) {
      const newScore = scoreMap.get(result.noteId);
      if (newScore) {
        result.bestScore = newScore.score;
        result.reasoning = newScore.reasoning ?? "Ollama reranked";
        // Update chunk scores too
        for (const chunk of result.chunks) {
          chunk.score = newScore.score;
          chunk.reasoning = newScore.reasoning ?? "Ollama reranked";
        }
      }
    }

    results.sort((a, b) => b.bestScore - a.bestScore);
    return results;
  }

  /**
   * Truncate text for reranking (avoid overly long inputs)
   */
  private truncateForRerank(text: string): string {
    const MAX_CHARS = 2000;
    if (text.length <= MAX_CHARS) return text;
    return text.slice(0, MAX_CHARS) + "...";
  }

  /**
   * Get LLM chat service
   */
  private getLLMChat(): LLMChat | null {
    const provider = this.context.kernel.getService<LLMProvider>("llmProvider");
    if (provider?.isReady) return provider;

    return null;
  }

  /**
   * Get Ollama reranker for reranking
   */
  private getReranker(): OllamaReranker | null {
    const reranker = this.context.kernel.getService<OllamaReranker>("ollamaReranker");
    return reranker?.isReady() ? reranker : null;
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
    return `deep-${Math.abs(hash).toString(36)}`;
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
