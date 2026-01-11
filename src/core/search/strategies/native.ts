/**
 * Native Search Utility
 *
 * Fast text-based search using Obsidian's APIs.
 * No embeddings required - works even when Ollama is down.
 *
 * Search sources:
 * - File titles (highest weight)
 * - File paths/folders
 * - Content text
 * - Tags (both frontmatter and inline)
 * - Headings
 */

import type { TFile } from "obsidian";
import type { ObsidianFacade } from "../../../adapters/obsidianFacade";
import type { ParaType } from "../../../types/search";
import type { NativeMatch, StrategySearchOptions } from "./types";

/** Scoring weights for different match types */
const MATCH_WEIGHTS = {
  title: 1.0, // Exact title match is highest
  heading: 0.8, // Headings are important
  tag: 0.7, // Tags indicate topic
  path: 0.5, // Path/folder context
  content: 0.4, // Content matches (many potential)
} as const;

/** Minimum score to include in results */
const MIN_NATIVE_SCORE = 0.1;

/**
 * Native search implementation using Obsidian APIs
 */
export class NativeSearch {
  constructor(
    private obsidian: ObsidianFacade,
    private getParaType: (path: string) => ParaType,
  ) {}

  /**
   * Perform native text search across the vault
   *
   * @param query - Search query (supports multiple terms)
   * @param options - Search options including filters
   * @returns Matches sorted by relevance score
   */
  async search(query: string, options: StrategySearchOptions): Promise<NativeMatch[]> {
    const startTime = performance.now();

    // Normalize query: lowercase, split into terms
    const normalizedQuery = query.toLowerCase().trim();
    if (!normalizedQuery) return [];

    const queryTerms = normalizedQuery.split(/\s+/).filter((t) => t.length > 1);
    if (queryTerms.length === 0) return [];

    // Get all markdown files
    let files = this.obsidian.getMarkdownFiles();

    // Apply folder filter
    if (options.folderPaths?.length) {
      files = files.filter((f) =>
        options.folderPaths?.some((folder) => folder && f.path?.startsWith(folder)),
      );
    }

    // Apply PARA type filter
    if (options.paraType) {
      files = files.filter((f) => this.getParaType(f.path) === options.paraType);
    }

    // Score each file
    const matches: NativeMatch[] = [];

    for (const file of files) {
      // Check for abort
      if (options.signal?.aborted) break;

      const match = await this.scoreFile(file, queryTerms, normalizedQuery, options);
      if (match && match.score >= MIN_NATIVE_SCORE) {
        matches.push(match);
      }
    }

    // Sort by score descending
    matches.sort((a, b) => b.score - a.score);

    // Limit results
    const results = matches.slice(0, options.topK);

    const elapsed = performance.now() - startTime;
    console.log(
      `[NativeSearch] Found ${results.length} matches in ${elapsed.toFixed(1)}ms (scanned ${files.length} files)`,
    );

    return results;
  }

  /**
   * Score a single file against the search query
   */
  private async scoreFile(
    file: TFile,
    queryTerms: string[],
    fullQuery: string,
    options: StrategySearchOptions,
  ): Promise<NativeMatch | null> {
    if (!file.path || !file.basename) return null;

    const metadata = this.obsidian.getFileMetadata(file);
    const tags = this.extractTags(metadata);

    if (!this.passesTagFilter(tags, options.tags)) return null;

    const scoringContext = this.computeMetadataScores(file, metadata, queryTerms, fullQuery);
    let { totalScore, bestMatchType } = scoringContext;

    const contentResult = await this.scoreContent(file, queryTerms, fullQuery, options, totalScore);
    totalScore += contentResult.score;

    if (totalScore < options.minScore) return null;

    return {
      path: file.path,
      title: file.basename,
      matchType: bestMatchType,
      snippet: contentResult.snippet,
      score: Math.min(1.0, totalScore),
    };
  }

  /**
   * Extract normalized tags from metadata
   */
  private extractTags(metadata: ReturnType<ObsidianFacade["getFileMetadata"]>): string[] {
    return (metadata.tags ?? [])
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.toLowerCase());
  }

  /**
   * Check if tags pass the filter
   */
  private passesTagFilter(tags: string[], filterTags: string[] | undefined): boolean {
    if (!filterTags?.length) return true;

    return filterTags.some((filterTag) => {
      if (!filterTag) return false;
      return tags.some((t) => t.includes(filterTag.toLowerCase()));
    });
  }

  /**
   * Compute scores from metadata (title, path, tags, headings)
   */
  private computeMetadataScores(
    file: TFile,
    metadata: ReturnType<ObsidianFacade["getFileMetadata"]>,
    queryTerms: string[],
    fullQuery: string,
  ): { totalScore: number; bestMatchType: NativeMatch["matchType"] } {
    const path = file.path.toLowerCase();
    const title = file.basename.toLowerCase();

    let totalScore = 0;
    let bestMatchType: NativeMatch["matchType"] = "content";

    // Title matching (highest priority)
    const titleScore = this.scoreTextMatch(title, queryTerms, fullQuery);
    if (titleScore > 0) {
      totalScore += titleScore * MATCH_WEIGHTS.title;
      if (titleScore > 0.5) bestMatchType = "title";
    }

    // Path matching
    const pathScore = this.scoreTextMatch(path, queryTerms, fullQuery);
    if (pathScore > 0) {
      totalScore += pathScore * MATCH_WEIGHTS.path * 0.5;
    }

    // Tag matching
    const tags = this.extractTags(metadata);
    const tagScore = this.scoreTagMatch(tags, queryTerms);
    if (tagScore > 0) {
      totalScore += tagScore * MATCH_WEIGHTS.tag;
      if (tagScore > 0.7 && totalScore < tagScore * MATCH_WEIGHTS.tag * 1.5) {
        bestMatchType = "tag";
      }
    }

    // Heading matching
    const headings = (metadata.headings ?? []).map((h) => h.heading.toLowerCase());
    const headingScore = this.scoreTextMatch(headings.join(" "), queryTerms, fullQuery);
    if (headingScore > 0) {
      totalScore += headingScore * MATCH_WEIGHTS.heading;
      if (headingScore > 0.6 && bestMatchType === "content") {
        bestMatchType = "heading";
      }
    }

    return { totalScore, bestMatchType };
  }

  /**
   * Score content if needed
   */
  private async scoreContent(
    file: TFile,
    queryTerms: string[],
    fullQuery: string,
    options: StrategySearchOptions,
    currentScore: number,
  ): Promise<{ score: number; snippet: string | undefined }> {
    if (!options.includeContent || currentScore >= 0.5) {
      return { score: 0, snippet: undefined };
    }

    try {
      const content = await this.obsidian.readFile(file);
      const contentLower = content.toLowerCase();
      const contentScore = this.scoreTextMatch(contentLower, queryTerms, fullQuery);

      if (contentScore > 0) {
        return {
          score: contentScore * MATCH_WEIGHTS.content,
          snippet: this.extractSnippet(content, queryTerms[0]),
        };
      }
    } catch {
      // File read error - skip content scoring
    }

    return { score: 0, snippet: undefined };
  }

  /**
   * Score text match using fuzzy matching
   * Returns 0-1 based on how well terms match
   */
  private scoreTextMatch(text: string, terms: string[], fullQuery: string): number {
    if (!text) return 0;

    // Exact phrase match (highest)
    if (text.includes(fullQuery)) {
      return 1.0;
    }

    // Count matching terms
    let matchedTerms = 0;
    let partialMatches = 0;

    for (const term of terms) {
      if (text.includes(term)) {
        matchedTerms++;
      } else {
        // Check for partial match (prefix)
        const words = text.split(/\s+/);
        if (words.some((w) => w.startsWith(term) || term.startsWith(w))) {
          partialMatches++;
        }
      }
    }

    // Calculate score based on match ratio
    const fullMatchScore = matchedTerms / terms.length;
    const partialMatchScore = (partialMatches / terms.length) * 0.5;

    return fullMatchScore + partialMatchScore;
  }

  /**
   * Score tag matches
   */
  private scoreTagMatch(tags: string[], queryTerms: string[]): number {
    if (tags.length === 0) return 0;

    let matches = 0;
    for (const term of queryTerms) {
      if (tags.some((tag) => tag.includes(term))) {
        matches++;
      }
    }

    return matches / queryTerms.length;
  }

  /**
   * Extract a snippet around the first match
   */
  private extractSnippet(content: string, term: string): string {
    const SNIPPET_LENGTH = 150;
    const lowerContent = content.toLowerCase();
    const index = lowerContent.indexOf(term.toLowerCase());

    if (index === -1) {
      // No match found, return beginning
      return `${content.slice(0, SNIPPET_LENGTH).trim()}…`;
    }

    // Calculate snippet bounds
    const start = Math.max(0, index - SNIPPET_LENGTH / 2);
    const end = Math.min(content.length, index + term.length + SNIPPET_LENGTH / 2);

    let snippet = content.slice(start, end).trim();

    // Add ellipsis if truncated
    if (start > 0) snippet = `…${snippet}`;
    if (end < content.length) snippet = `${snippet}…`;

    // Clean up whitespace
    snippet = snippet.replace(/\s+/g, " ");

    return snippet;
  }
}
