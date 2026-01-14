/**
 * Context Builder Agent
 *
 * Internal agent that builds context for other agents.
 * Temperature: 0.1 (highly deterministic, factual)
 * Output: Internal (not shown to user)
 * Context Priority: Search results + note metadata
 *
 * Identity: Tier 1 (Core Notient) + Tier 2 (Intelligence Analyst)
 *
 * Phase 4 Swarm: Behavior & Trend Tracking
 * - Tracks user editing patterns from metadataCache
 * - Computes vault-level trends (growth, connectivity)
 * - Caches expensive computations with TTL
 */

import type { ObsidianFacade } from "../../adapters/obsidianFacade";
import type { UserProfile } from "../../types/profile";
import type { VaultContextBuilder } from "../context/vaultContextBuilder";
import type { LLMProvider } from "../llm/provider";
import type { SearchPipeline } from "../search/pipeline";
import { buildAgentSystemPrompt } from "./agentIdentity";
import { BaseAgent } from "./base";
import type {
  AgentContext,
  AgentEvent,
  InternalOutput,
  SearchContext,
  UserBehavior,
  VaultTrends,
} from "./types";

// Cache TTLs
const BEHAVIOR_TTL_MS = 5 * 60 * 1000; // 5 minutes
const TRENDS_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Context Builder agent implementation
 */
export class ContextBuilderAgent extends BaseAgent {
  private searchPipeline: SearchPipeline | null;
  private vaultContextBuilder: VaultContextBuilder | null;
  private obsidian: ObsidianFacade | null;
  private profile?: UserProfile;

  // Behavior & Trends caches (Phase 4 Swarm)
  private behaviorCache: UserBehavior | null = null;
  private trendsCache: VaultTrends | null = null;
  private lastBehaviorUpdate = 0;
  private lastTrendsUpdate = 0;

  constructor(
    llm: LLMProvider,
    searchPipeline: SearchPipeline | null,
    vaultContextBuilder: VaultContextBuilder | null,
    obsidian: ObsidianFacade | null,
    profile?: UserProfile,
  ) {
    super(llm, "context-builder");
    this.searchPipeline = searchPipeline;
    this.vaultContextBuilder = vaultContextBuilder;
    this.obsidian = obsidian;
    this.profile = profile;
  }

  /**
   * Update user profile
   */
  setProfile(profile: UserProfile | undefined): void {
    this.profile = profile;
  }

  /**
   * Update search pipeline (for reconnection scenarios)
   */
  updateSearchPipeline(pipeline: SearchPipeline | null): void {
    this.searchPipeline = pipeline;
  }

  /**
   * Update vault context builder
   */
  updateVaultContextBuilder(builder: VaultContextBuilder | null): void {
    this.vaultContextBuilder = builder;
  }

  /**
   * Update ObsidianFacade (for reconnection scenarios)
   */
  updateObsidian(obsidian: ObsidianFacade | null): void {
    this.obsidian = obsidian;
    // Invalidate caches when facade changes
    this.behaviorCache = null;
    this.trendsCache = null;
    this.lastBehaviorUpdate = 0;
    this.lastTrendsUpdate = 0;
  }

  // ===========================================================================
  // Phase 4 Swarm: Behavior & Trend Tracking
  // ===========================================================================

  /**
   * Get current user behavior patterns
   * Cached with 5 minute TTL
   */
  async getUserBehavior(): Promise<UserBehavior> {
    const now = Date.now();

    if (this.behaviorCache && now - this.lastBehaviorUpdate < BEHAVIOR_TTL_MS) {
      return this.behaviorCache;
    }

    this.behaviorCache = this.computeBehavior();
    this.lastBehaviorUpdate = now;
    return this.behaviorCache;
  }

  /**
   * Get vault-level trends
   * Cached with 30 minute TTL (expensive computation)
   */
  async getVaultTrends(): Promise<VaultTrends> {
    const now = Date.now();

    if (this.trendsCache && now - this.lastTrendsUpdate < TRENDS_TTL_MS) {
      return this.trendsCache;
    }

    this.trendsCache = this.computeTrends();
    this.lastTrendsUpdate = now;
    return this.trendsCache;
  }

  /**
   * Build enriched context including behavior and trends
   * Used by Orchestrator for personalized planning
   */
  async buildEnrichedContext(query: string): Promise<SearchContext> {
    const [searchResults, behavior, trends] = await Promise.all([
      this.searchPipeline?.search(query, { topK: 5, enableReranking: false }) ?? [],
      this.getUserBehavior(),
      this.getVaultTrends(),
    ]);

    return {
      query,
      results: searchResults.map((r) => ({
        path: r.path,
        title: r.title,
        snippet: r.chunks[0]?.text || "",
        score: r.bestScore,
      })),
      userBehavior: behavior,
      vaultTrends: trends,
    };
  }

  /**
   * Compute behavior from Obsidian's metadataCache
   */
  private computeBehavior(): UserBehavior {
    if (!this.obsidian) {
      return this.emptyBehavior();
    }

    const files = this.obsidian.getMarkdownFiles();
    const now = Date.now();
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;

    // Collect recent edits sorted by modification time
    const recentEdits: UserBehavior["recentEdits"] = [];
    const tagCounts = new Map<string, number>();
    const folderCounts = new Map<string, number>();

    for (const file of files) {
      const stat = file.stat;
      const metadata = this.obsidian.getFileMetadata(file);

      // Track recent edits (last 50)
      if (stat.mtime > oneWeekAgo) {
        recentEdits.push({
          path: file.path,
          timestamp: stat.mtime,
          type: stat.ctime === stat.mtime ? "create" : "modify",
        });
      }

      // Count tags
      for (const tag of metadata.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }

      // Count top-level folder activity
      const folder = file.path.split("/")[0];
      if (folder && folder !== file.name) {
        folderCounts.set(folder, (folderCounts.get(folder) || 0) + 1);
      }
    }

    // Sort recent edits by timestamp descending, limit to 50
    recentEdits.sort((a, b) => b.timestamp - a.timestamp);
    const limitedEdits = recentEdits.slice(0, 50);

    // Determine edit frequency
    const recentEditCount = limitedEdits.filter(
      (e) => e.timestamp > now - 24 * 60 * 60 * 1000,
    ).length;
    let editFrequency: UserBehavior["editFrequency"] = "low";
    if (recentEditCount > 10) {
      editFrequency = "high";
    } else if (recentEditCount > 3) {
      editFrequency = "medium";
    }

    // Get top 10 active topics (tags + folders combined)
    const allTopics = new Map<string, number>();
    for (const [tag, count] of tagCounts) {
      allTopics.set(`#${tag}`, count);
    }
    for (const [folder, count] of folderCounts) {
      allTopics.set(folder, count);
    }
    const activeTopics = [...allTopics.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([topic]) => topic);

    // Determine preferred note types (simplified heuristic)
    const preferredNoteTypes = this.inferNoteTypes(files);

    return {
      recentEdits: limitedEdits,
      activeTopics,
      editFrequency,
      preferredNoteTypes,
    };
  }

  /**
   * Infer preferred note types from file characteristics
   */
  private inferNoteTypes(files: { path: string; stat: { size: number } }[]): string[] {
    let quickCapture = 0;
    let longForm = 0;
    let structured = 0;

    for (const file of files) {
      const size = file.stat.size;
      if (size < 500) {
        quickCapture++;
      } else if (size > 5000) {
        longForm++;
      } else {
        structured++;
      }
    }

    const total = files.length || 1;
    const types: string[] = [];

    if (quickCapture / total > 0.3) types.push("quick-capture");
    if (longForm / total > 0.2) types.push("long-form");
    if (structured / total > 0.3) types.push("structured");

    return types.length > 0 ? types : ["mixed"];
  }

  /**
   * Compute vault-level trends
   */
  private computeTrends(): VaultTrends {
    if (!this.obsidian) {
      return this.emptyTrends();
    }

    const files = this.obsidian.getMarkdownFiles();
    const now = Date.now();
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const resolvedLinks = this.obsidian.metadataCache.resolvedLinks;

    // Growth rate: notes created in last week
    let notesCreatedThisWeek = 0;
    for (const file of files) {
      if (file.stat.ctime > oneWeekAgo) {
        notesCreatedThisWeek++;
      }
    }
    const growthRate = notesCreatedThisWeek;

    // Topic clusters from tags
    const tagCounts = new Map<string, { count: number; recentActivity: boolean }>();
    for (const file of files) {
      const metadata = this.obsidian.getFileMetadata(file);
      const isRecent = file.stat.mtime > oneWeekAgo;

      for (const tag of metadata.tags) {
        const existing = tagCounts.get(tag) || { count: 0, recentActivity: false };
        tagCounts.set(tag, {
          count: existing.count + 1,
          recentActivity: existing.recentActivity || isRecent,
        });
      }
    }

    const topicClusters = [...tagCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 15)
      .map(([topic, data]) => ({
        topic,
        noteCount: data.count,
        recentActivity: data.recentActivity,
      }));

    // Orphan ratio and connectivity
    let orphanCount = 0;
    let totalLinks = 0;

    for (const file of files) {
      const fileLinks = resolvedLinks[file.path] || {};
      const linkCount = Object.keys(fileLinks).length;
      totalLinks += linkCount;
      if (linkCount === 0) {
        orphanCount++;
      }
    }

    const totalNotes = files.length || 1;
    const orphanRatio = Math.round((orphanCount / totalNotes) * 100) / 100;
    const avgConnectivity = Math.round((totalLinks / totalNotes) * 10) / 10;

    return {
      growthRate,
      topicClusters,
      orphanRatio,
      avgConnectivity,
    };
  }

  /**
   * Empty behavior for when facade is unavailable
   */
  private emptyBehavior(): UserBehavior {
    return {
      recentEdits: [],
      activeTopics: [],
      editFrequency: "low",
      preferredNoteTypes: [],
    };
  }

  /**
   * Empty trends for when facade is unavailable
   */
  private emptyTrends(): VaultTrends {
    return {
      growthRate: 0,
      topicClusters: [],
      orphanRatio: 0,
      avgConnectivity: 0,
    };
  }

  // ===========================================================================
  // LLM-Based Context Building
  // ===========================================================================

  /**
   * Build system prompt for context building
   * Uses two-tier identity: Core Notient + Intelligence Analyst
   */
  protected buildSystemPrompt(context: AgentContext): string {
    // Build context string
    const contextParts: string[] = [];

    // Add current note info (minimal, just metadata)
    contextParts.push(
      `\nCURRENT NOTE: "${context.currentNote.title}" (${context.currentNote.path})`,
    );

    // Add search results if available
    if (context.search?.results.length) {
      const resultsList = context.search.results
        .slice(0, 7)
        .map(
          (r, i) =>
            `${i + 1}. [[${r.title}]] (score: ${r.score.toFixed(2)}): ${r.snippet.slice(0, 100)}...`,
        )
        .join("\n");
      contextParts.push(`\nSEARCH RESULTS:\n${resultsList}`);
    }

    // Use unified identity system: Tier 1 (Core Notient) + Tier 2 (Intelligence Analyst)
    return buildAgentSystemPrompt("context-builder", this.profile, contextParts.join("\n"));
  }

  /**
   * Parse internal output
   */
  protected parseOutput(rawOutput: string, context: AgentContext): InternalOutput {
    return {
      kind: "internal",
      agentType: "context-builder",
      contextSummary: rawOutput.trim(),
      relatedNotes: context.relatedNotes || [],
      searchResults: context.search || { results: [], query: "" },
    };
  }

  /**
   * Execute context builder agent
   * This agent performs search AND summarization
   */
  async *execute(context: AgentContext, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    yield { type: "started", agentType: "context-builder" };
    yield { type: "progress", agentType: "context-builder", progress: 5 };

    // Phase 1: Search for related content
    const searchResult = await this.executeSearchPhase(context);
    yield { type: "progress", agentType: "context-builder", progress: 30 };

    // Phase 2: Summarize context using LLM (if we have results but no summary)
    let contextSummary = searchResult.contextSummary;
    if (searchResult.relatedNotes.length > 0 && contextSummary === "No vault context available.") {
      yield { type: "progress", agentType: "context-builder", progress: 50 };
      contextSummary = await this.executeSummarizationPhase(context, searchResult);
    }
    yield { type: "progress", agentType: "context-builder", progress: 70 };

    // Phase 3: Build final output
    yield* this.emitFinalOutput(searchResult, contextSummary);
  }

  /**
   * Execute search phase and return results
   */
  private async executeSearchPhase(context: AgentContext): Promise<{
    relatedNotes: Array<{ title: string; path: string; text: string }>;
    searchContext: SearchContext;
    contextSummary: string;
  }> {
    const relatedNotes: Array<{ title: string; path: string; text: string }> = [];
    let searchContext: SearchContext = { results: [], query: context.query };
    let contextSummary = "No vault context available.";

    if (!this.searchPipeline) {
      return { relatedNotes, searchContext, contextSummary };
    }

    try {
      const searchQuery = `${context.query} ${context.currentNote.title}`.trim();
      this.log(`Searching vault for: "${searchQuery}"`);

      const searchResults = await this.searchPipeline.search(searchQuery, {
        topK: 7,
        enableReranking: true,
      });

      searchContext = this.buildSearchContext(searchQuery, searchResults);
      this.extractRelatedNotes(searchResults, context.currentNote.path, relatedNotes);
      contextSummary = this.buildVaultContextSummary(context.query, searchResults, contextSummary);
    } catch (error) {
      this.warn("Search failed, continuing without search context:", error);
    }

    return { relatedNotes, searchContext, contextSummary };
  }

  /**
   * Build search context from results
   */
  private buildSearchContext(
    searchQuery: string,
    searchResults: Array<{
      path: string;
      title: string;
      chunks: Array<{ text: string }>;
      bestScore: number;
    }>,
  ): SearchContext {
    return {
      query: searchQuery,
      results: searchResults.map((r) => ({
        path: r.path,
        title: r.title,
        snippet: r.chunks[0]?.text || "",
        score: r.bestScore,
      })),
    };
  }

  /**
   * Extract related notes from search results
   */
  private extractRelatedNotes(
    searchResults: Array<{
      path: string;
      title: string;
      chunks: Array<{ text: string }>;
    }>,
    currentNotePath: string,
    relatedNotes: Array<{ title: string; path: string; text: string }>,
  ): void {
    for (const result of searchResults) {
      if (result.path === currentNotePath) continue;
      if (relatedNotes.length >= 5) break;

      const bestChunk = result.chunks[0];
      relatedNotes.push({
        title: result.title,
        path: result.path,
        text: bestChunk?.text || "",
      });
    }
  }

  /**
   * Build vault context summary from search results
   */
  private buildVaultContextSummary(
    query: string,
    searchResults: Array<unknown>,
    defaultSummary: string,
  ): string {
    if (!this.vaultContextBuilder || searchResults.length === 0) {
      return defaultSummary;
    }

    const vaultContext = this.vaultContextBuilder.buildForQuery(
      query,
      searchResults as Parameters<VaultContextBuilder["buildForQuery"]>[1],
    );

    return vaultContext?.contextSummary || defaultSummary;
  }

  /**
   * Execute summarization phase using LLM
   */
  private async executeSummarizationPhase(
    context: AgentContext,
    searchResult: {
      relatedNotes: Array<{ title: string; path: string; text: string }>;
      searchContext: SearchContext;
    },
  ): Promise<string> {
    try {
      const summaryContext: AgentContext = {
        ...context,
        search: searchResult.searchContext,
        relatedNotes: searchResult.relatedNotes,
      };

      const systemPrompt = this.buildSystemPrompt(summaryContext);
      const messages = [
        { role: "system" as const, content: systemPrompt },
        { role: "user" as const, content: "Summarize the relevant vault context for this note." },
      ];

      return await this.completeLLM(messages);
    } catch (error) {
      this.warn("Context summarization failed:", error);
      return "No vault context available.";
    }
  }

  /**
   * Emit final output events
   */
  private async *emitFinalOutput(
    searchResult: {
      relatedNotes: Array<{ title: string; path: string; text: string }>;
      searchContext: SearchContext;
    },
    contextSummary: string,
  ): AsyncIterable<AgentEvent> {
    const output: InternalOutput = {
      kind: "internal",
      agentType: "context-builder",
      contextSummary,
      relatedNotes: searchResult.relatedNotes,
      searchResults: searchResult.searchContext,
    };

    if (searchResult.relatedNotes.length > 0) {
      yield {
        type: "citations",
        agentType: "context-builder",
        paths: searchResult.relatedNotes.map((n) => n.path),
      };
    }

    this.log(
      `Built context: ${searchResult.relatedNotes.length} related notes, summary: ${contextSummary.slice(0, 50)}...`,
    );

    yield { type: "progress", agentType: "context-builder", progress: 100 };
    yield { type: "complete", agentType: "context-builder", output };
  }

  /**
   * Quick search without LLM summarization
   * Used when we need fast context without AI processing
   */
  async quickSearch(query: string, noteTitle: string): Promise<SearchContext> {
    if (!this.searchPipeline) {
      return { results: [], query };
    }

    try {
      const searchQuery = `${query} ${noteTitle}`.trim();
      const searchResults = await this.searchPipeline.search(searchQuery, {
        topK: 5,
        enableReranking: false, // Faster without reranking
      });

      return {
        query: searchQuery,
        results: searchResults.map((r) => ({
          path: r.path,
          title: r.title,
          snippet: r.chunks[0]?.text || "",
          score: r.bestScore,
        })),
      };
    } catch (error) {
      this.warn("Quick search failed:", error);
      return { results: [], query };
    }
  }
}
