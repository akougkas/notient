/**
 * Quick Search Strategy
 *
 * Fast native search using Obsidian APIs only.
 * Target latency: <100ms
 * No AI/embeddings required - always available.
 *
 * Perfect for:
 * - Quick lookups during Ollama downtime
 * - Searching while indexing is running
 * - Users who prefer instant results over semantic matching
 */

import type { ChunkKind, ChunkTier } from "../../../types/indexer";
import type { ParaType, SearchResult } from "../../../types/search";
import { NativeSearch } from "./native";
import type {
  NativeMatch,
  SearchProgress,
  SearchStrategy,
  StrategyContext,
  StrategySearchOptions,
} from "./types";

/**
 * Quick search strategy - native Obsidian search only
 */
export class QuickSearchStrategy implements SearchStrategy {
  readonly name = "quick" as const;
  readonly description = "Fast native search, no AI";
  readonly targetLatencyMs = 100;

  private nativeSearch: NativeSearch;

  constructor(private context: StrategyContext) {
    this.nativeSearch = new NativeSearch(context.kernel.obsidian, (path) => this.getParaType(path));
  }

  /**
   * Quick search is always available (uses native Obsidian APIs)
   */
  isAvailable(): boolean {
    return true;
  }

  /**
   * Execute quick search using native Obsidian search
   */
  async search(
    query: string,
    options: StrategySearchOptions,
    onProgress?: (progress: SearchProgress) => void,
  ): Promise<SearchResult[]> {
    const startTime = performance.now();

    console.log(`[QuickSearchStrategy] Starting native search for: "${query}"`);
    onProgress?.({ stage: "native", detail: "Searching vault..." });

    // Perform native search
    const nativeMatches = await this.nativeSearch.search(query, {
      ...options,
      topK: options.topK * 2, // Get extra for filtering
    });

    if (options.signal?.aborted) return [];

    // Convert native matches to SearchResult format
    const results = await this.convertToSearchResults(nativeMatches, options);

    const elapsed = performance.now() - startTime;
    console.log(
      `[QuickSearchStrategy] Completed in ${elapsed.toFixed(1)}ms with ${results.length} results`,
    );

    return results;
  }

  /**
   * Convert native matches to SearchResult format
   */
  private async convertToSearchResults(
    matches: NativeMatch[],
    options: StrategySearchOptions,
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    for (const match of matches) {
      if (options.signal?.aborted) break;

      // Generate a pseudo noteId from path
      const noteId = this.pathToNoteId(match.path);

      // Get file modification time
      const file = this.context.kernel.obsidian.getFileByPath(match.path);
      const mtimeMs = file?.stat.mtime ?? 0;

      // Create a single "chunk" representing the match
      const result: SearchResult = {
        noteId,
        path: match.path,
        title: match.title,
        bestScore: match.score,
        paraType: this.getParaType(match.path),
        mtimeMs,
        reasoning: this.getMatchReasoning(match),
        chunks: [
          {
            chunkId: `${noteId}-native`,
            noteId,
            path: match.path,
            title: match.title,
            headingPath: [],
            tier: "note" as ChunkTier,
            kind: "paragraph" as ChunkKind,
            parentChunkId: null,
            blockRef: null,
            startLine: null,
            endLine: null,
            tokenEstimate: 0,
            text: match.snippet ?? "",
            score: match.score,
            paraType: this.getParaType(match.path),
            reasoning: this.getMatchReasoning(match),
          },
        ],
      };

      results.push(result);
    }

    // Sort by score and limit
    results.sort((a, b) => b.bestScore - a.bestScore);
    return results.slice(0, options.topK);
  }

  /**
   * Generate reasoning text for a native match
   */
  private getMatchReasoning(match: NativeMatch): string {
    switch (match.matchType) {
      case "title":
        return "Title match";
      case "heading":
        return "Heading match";
      case "tag":
        return "Tag match";
      case "path":
        return "Path match";
      case "content":
        return "Content match";
      default:
        return "Native search";
    }
  }

  /**
   * Convert file path to a stable note ID
   */
  private pathToNoteId(path: string): string {
    // Use a hash of the path for consistency
    let hash = 0;
    for (let i = 0; i < path.length; i++) {
      const char = path.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return `native-${Math.abs(hash).toString(36)}`;
  }

  /**
   * Determine PARA type from path
   */
  private getParaType(path: string): ParaType {
    if (!path) return "unknown";

    const para = this.context.kernel.settings.para;
    const lowerPath = path.toLowerCase();

    // Helper to check folder match with null safety
    const matchesFolder = (folders: string[] | undefined, type: ParaType): ParaType | null => {
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
