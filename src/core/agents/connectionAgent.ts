/**
 * Connection Agent
 *
 * Specialist agent for finding semantic connections between notes.
 * Temperature: 0.3 (balanced precision and creativity)
 * Output: Structured JSON (LinkSuggestionsOutput)
 * Context Priority: Note + vault graph + search results
 *
 * Identity: Tier 1 (Core Notient) + Tier 2 (Knowledge Connector)
 */

import type { UserProfile } from "../../types/profile";
import type { LLMProvider } from "../llm/provider";
import { buildAgentSystemPrompt } from "./agentIdentity";
import { BaseAgent } from "./base";
import type { AgentContext, AgentEvent, LinkSuggestionsOutput, StructuredOutput } from "./types";

/**
 * Connection agent implementation
 */
export class ConnectionAgent extends BaseAgent {
  private profile?: UserProfile;

  constructor(llm: LLMProvider, profile?: UserProfile) {
    super(llm, "connection");
    this.profile = profile;
  }

  /**
   * Update user profile
   */
  setProfile(profile: UserProfile | undefined): void {
    this.profile = profile;
  }

  /**
   * Build system prompt for connection finding
   * Uses two-tier identity: Core Notient + Knowledge Connector
   */
  protected buildSystemPrompt(context: AgentContext): string {
    // Build context string
    const contextParts: string[] = [];

    // Add current note
    contextParts.push(this.formatNoteForPrompt(context.currentNote, 3000));

    // Add existing links (to avoid duplicates)
    const existingLinks = this.extractExistingLinks(context.currentNote.content);
    if (existingLinks.length > 0) {
      contextParts.push(
        `\nEXISTING LINKS IN NOTE:\n${existingLinks.map((l) => `- [[${l}]]`).join("\n")}`,
      );
    }

    // Add vault graph context (backlinks, orphans, hubs)
    if (context.graph) {
      const graphInfo = [];
      if (context.graph.backlinks.length > 0) {
        graphInfo.push(
          `Notes linking TO this note: ${context.graph.backlinks.slice(0, 10).join(", ")}`,
        );
      }
      if (context.graph.outlinks.length > 0) {
        graphInfo.push(
          `Notes this note links TO: ${context.graph.outlinks.slice(0, 10).join(", ")}`,
        );
      }
      if (context.graph.hubs.length > 0) {
        graphInfo.push(
          `Hub notes (highly connected): ${context.graph.hubs.slice(0, 5).join(", ")}`,
        );
      }
      if (graphInfo.length > 0) {
        contextParts.push(`\nVAULT GRAPH CONTEXT:\n${graphInfo.join("\n")}`);
      }
    }

    // Add semantically related notes from search (critical for link suggestions)
    if (context.relatedNotes?.length) {
      const candidates = context.relatedNotes
        .filter((n) => !existingLinks.includes(n.title)) // Exclude already linked
        .slice(0, 10);

      if (candidates.length > 0) {
        const candidateList = candidates
          .map((n) => {
            const preview = n.text.slice(0, 200).replace(/\n/g, " ");
            return `### [[${n.title}]] (${n.path})\n${preview}...`;
          })
          .join("\n\n");

        contextParts.push(`\nCANDIDATE NOTES FOR LINKING:\n${candidateList}`);
      }
    }

    // Add search context if available
    if (context.search?.results.length) {
      contextParts.push(`\nSEARCH QUERY: "${context.search.query}"`);
    }

    // Use unified identity system: Tier 1 (Core Notient) + Tier 2 (Knowledge Connector)
    return buildAgentSystemPrompt("connection", this.profile, contextParts.join("\n"));
  }

  /**
   * Parse link suggestions from LLM
   * Robust handling: sanitizes control chars and markdown, handles parse failures gracefully
   */
  protected parseOutput(rawOutput: string, context: AgentContext): StructuredOutput & { parseError?: string } {
    let parsed: LinkSuggestionsOutput | null = null;
    let parseError: string | undefined;

    // Log raw output for debugging (truncated)
    const truncatedRaw = rawOutput.length > 500 ? `${rawOutput.slice(0, 500)}...(${rawOutput.length} chars)` : rawOutput;
    this.log(`Raw LLM output: ${truncatedRaw || "(empty)"}`);

    // Check for empty response
    if (!rawOutput || rawOutput.trim().length === 0) {
      parseError = "LLM returned empty response (possible timeout or overload)";
      this.warn(parseError);
    } else {
      try {
        // Sanitize control characters that break JSON.parse
        let sanitized = rawOutput
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // Remove control chars (keep \n, \r, \t)
          .replace(/\r\n/g, "\n") // Normalize line endings
          .replace(/\r/g, "\n");

        // Remove markdown formatting inside JSON strings (common LLM mistake)
        // e.g., "reason": **"Some text"** → "reason": "Some text"
        sanitized = sanitized.replace(/\*\*"([^"]+)"\*\*/g, '"$1"');
        sanitized = sanitized.replace(/\*\*([^*]+)\*\*/g, "$1");

        parsed = this.parseJSON<LinkSuggestionsOutput>(sanitized);

        if (!parsed) {
          parseError = "No valid JSON found in LLM response";
          this.warn(parseError);
        }
      } catch (error) {
        parseError = `JSON parse error: ${error instanceof Error ? error.message : String(error)}`;
        this.warn(parseError);
      }
    }

    // Graceful fallback: return empty links on any parse failure
    const validLinks = this.validateLinks(
      parsed?.links || [],
      context.currentNote.content,
      context.relatedNotes || [],
    );

    return {
      kind: "structured",
      agentType: "connection",
      schema: "LinkSuggestionsOutput",
      data: { links: validLinks },
      parseError,
    };
  }

  /**
   * Execute connection agent
   */
  async *execute(context: AgentContext, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    yield { type: "started", agentType: "connection" };
    yield { type: "progress", agentType: "connection", progress: 10 };

    const systemPrompt = this.buildSystemPrompt(context);
    const messages = [
      { role: "system" as const, content: systemPrompt },
      {
        role: "user" as const,
        content: `Find semantic connections between this note and other notes in the vault. Prioritize meaningful, non-obvious connections. Output only valid JSON.`,
      },
    ];

    this.log(`Finding connections for: ${context.currentNote.title}`);

    try {
      yield { type: "progress", agentType: "connection", progress: 30 };

      const rawOutput = await this.completeLLM(messages);

      yield { type: "progress", agentType: "connection", progress: 70 };

      const output = this.parseOutput(rawOutput, context);
      const linkOutput = output.data as LinkSuggestionsOutput;

      // Emit citations for the suggested links
      const citationPaths = linkOutput.links.map((l) => l.targetPath);
      if (citationPaths.length > 0) {
        yield { type: "citations", agentType: "connection", paths: citationPaths };
      }

      // Log with distinction between parse error vs no links found
      if (output.parseError) {
        this.warn(`Parse error (returning ${linkOutput.links.length} links): ${output.parseError}`);
      } else {
        this.log(`Found ${linkOutput.links.length} connection suggestions`);
      }

      yield { type: "progress", agentType: "connection", progress: 100 };
      yield { type: "complete", agentType: "connection", output };
    } catch (error) {
      yield { type: "error", agentType: "connection", error: error as Error };
    }
  }

  /**
   * Extract existing wiki-links from note content
   */
  private extractExistingLinks(content: string): string[] {
    const links: string[] = [];
    const wikiLinkRegex = /\[\[([^\]|#]+)(?:[#|][^\]]+)?\]\]/g;
    let match;

    while ((match = wikiLinkRegex.exec(content)) !== null) {
      const noteName = match[1].trim();
      if (!links.includes(noteName)) {
        links.push(noteName);
      }
    }

    return links;
  }

  /**
   * Validate and filter link suggestions
   */
  private validateLinks(
    links: unknown[],
    noteContent: string,
    relatedNotes: Array<{ title: string; path: string; text: string }>,
  ): LinkSuggestionsOutput["links"] {
    const existingLinks = this.extractExistingLinks(noteContent);
    const validLinks: LinkSuggestionsOutput["links"] = [];
    const seenPaths = new Set<string>();

    for (const link of links) {
      if (!this.isValidLinkSuggestion(link)) continue;

      const suggestion = link as LinkSuggestionsOutput["links"][0];

      // Skip if already linked
      if (existingLinks.includes(suggestion.targetTitle)) continue;

      // Skip duplicates
      if (seenPaths.has(suggestion.targetPath)) continue;
      seenPaths.add(suggestion.targetPath);

      // Verify the target exists in related notes
      const targetExists = relatedNotes.some(
        (n) => n.path === suggestion.targetPath || n.title === suggestion.targetTitle,
      );
      if (!targetExists) {
        this.warn(`Suggested link target not found: ${suggestion.targetPath}`);
        continue;
      }

      // Validate connection type
      const validTypes = ["conceptual", "methodological", "problem-solution", "hierarchical"];
      if (!validTypes.includes(suggestion.connectionType)) {
        suggestion.connectionType = "conceptual"; // Default
      }

      // Clamp relevance score
      suggestion.relevanceScore = Math.max(0, Math.min(1, suggestion.relevanceScore || 0.5));

      validLinks.push(suggestion);
    }

    // Sort by relevance and limit
    return validLinks.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, 10);
  }

  /**
   * Type guard for link suggestion
   */
  private isValidLinkSuggestion(link: unknown): boolean {
    if (!link || typeof link !== "object") return false;
    const l = link as Record<string, unknown>;
    return (
      typeof l.targetPath === "string" &&
      typeof l.targetTitle === "string" &&
      typeof l.reason === "string"
    );
  }
}
