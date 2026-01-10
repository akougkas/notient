/**
 * Context Builder Agent
 *
 * Internal agent that builds context for other agents.
 * Temperature: 0.1 (highly deterministic, factual)
 * Output: Internal (not shown to user)
 * Context Priority: Search results + note metadata
 *
 * Identity: Tier 1 (Core Notient) + Tier 2 (Intelligence Analyst)
 */

import type { UserProfile } from "../../types/profile";
import type { VaultContextBuilder } from "../context/vaultContextBuilder";
import type { LLMProvider } from "../llm/provider";
import type { SearchPipeline } from "../search/pipeline";
import { buildAgentSystemPrompt } from "./agentIdentity";
import { BaseAgent } from "./base";
import type { AgentContext, AgentEvent, InternalOutput, SearchContext } from "./types";

/**
 * Context Builder agent implementation
 */
export class ContextBuilderAgent extends BaseAgent {
  private searchPipeline: SearchPipeline | null;
  private vaultContextBuilder: VaultContextBuilder | null;
  private profile?: UserProfile;

  constructor(
    llm: LLMProvider,
    searchPipeline: SearchPipeline | null,
    vaultContextBuilder: VaultContextBuilder | null,
    profile?: UserProfile,
  ) {
    super(llm, "context-builder");
    this.searchPipeline = searchPipeline;
    this.vaultContextBuilder = vaultContextBuilder;
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

    const relatedNotes: Array<{ title: string; path: string; text: string }> = [];
    let searchContext: SearchContext = { results: [], query: context.query };
    let contextSummary = "No vault context available.";

    // Phase 1: Search for related content
    if (this.searchPipeline) {
      try {
        // Build search query from user query + note title
        const searchQuery = `${context.query} ${context.currentNote.title}`.trim();

        this.log(`Searching vault for: "${searchQuery}"`);

        const searchResults = await this.searchPipeline.search(searchQuery, {
          topK: 7,
          enableReranking: true,
        });

        yield { type: "progress", agentType: "context-builder", progress: 30 };

        // Build search context
        searchContext = {
          query: searchQuery,
          results: searchResults.map((r) => ({
            path: r.path,
            title: r.title,
            snippet: r.chunks[0]?.text || "",
            score: r.bestScore,
          })),
        };

        // Extract related notes (exclude current note)
        for (const result of searchResults) {
          if (result.path === context.currentNote.path) continue;
          if (relatedNotes.length >= 5) break;

          const bestChunk = result.chunks[0];
          relatedNotes.push({
            title: result.title,
            path: result.path,
            text: bestChunk?.text || "",
          });
        }

        // Build vault context summary
        if (this.vaultContextBuilder && searchResults.length > 0) {
          const vaultContext = this.vaultContextBuilder.buildForQuery(context.query, searchResults);
          if (vaultContext?.contextSummary) {
            contextSummary = vaultContext.contextSummary;
          }
        }

        yield { type: "progress", agentType: "context-builder", progress: 50 };
      } catch (error) {
        this.warn("Search failed, continuing without search context:", error);
      }
    }

    // Phase 2: Summarize context using LLM (if we have results)
    if (relatedNotes.length > 0 && contextSummary === "No vault context available.") {
      try {
        const summaryContext: AgentContext = {
          ...context,
          search: searchContext,
          relatedNotes,
        };

        const systemPrompt = this.buildSystemPrompt(summaryContext);
        const messages = [
          { role: "system" as const, content: systemPrompt },
          { role: "user" as const, content: "Summarize the relevant vault context for this note." },
        ];

        yield { type: "progress", agentType: "context-builder", progress: 70 };

        contextSummary = await this.completeLLM(messages);
      } catch (error) {
        this.warn("Context summarization failed:", error);
      }
    }

    // Phase 3: Build final output
    const output: InternalOutput = {
      kind: "internal",
      agentType: "context-builder",
      contextSummary,
      relatedNotes,
      searchResults: searchContext,
    };

    // Emit citations for found notes
    if (relatedNotes.length > 0) {
      yield {
        type: "citations",
        agentType: "context-builder",
        paths: relatedNotes.map((n) => n.path),
      };
    }

    this.log(
      `Built context: ${relatedNotes.length} related notes, summary: ${contextSummary.slice(0, 50)}...`,
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
