/**
 * Analyst Agent for Notient Pipeline
 * Generates enhancement suggestions from built context.
 * Source of truth: .planning/PHASE-GALAXY.md (Phase G2)
 *
 * Per spec decisions:
 * - Lean prompts (no persona, zero-shot)
 * - Wait for complete response (buffer, parse at end)
 * - Flexible JSON with fallback parsing (JSON → YAML → regex)
 * - Suggestion types: tag, link, section, frontmatter (NO text rewriting)
 */

import type { EnhancementSuggestion, SuggestionMetadata, SuggestionType } from "../../types";
import type {
  AgentConfig,
  AgentResult,
  BuiltContext,
  RawAnalystResponse,
} from "./types";
import { formatContextForLLM } from "./contextBuilder";

// =============================================================================
// Prompt Building
// =============================================================================

/**
 * Build the analysis prompt for the LLM.
 * Lean and focused - no persona, no examples.
 */
function buildAnalysisPrompt(context: BuiltContext): string {
  const formattedContext = formatContextForLLM(context);
  const targetTypes = context.plan.suggestionTypes;

  return `Analyze this note and suggest enhancements.

${formattedContext}

## Instructions
Generate enhancement suggestions for this note. Focus on: ${targetTypes.join(", ")}.

Respond with JSON containing a "suggestions" array. Each suggestion must have:
- type: one of "tag", "link", "section", "frontmatter"
- description: short description of what to add/change
- preview: how it would appear in the note
- confidence: 0-100 confidence score

For type="tag": include "tags" array
For type="link": include "linkTarget" (note path or title)
For type="section": include "sectionTitle"
For type="frontmatter": include "frontmatterKey" and "frontmatterValue"

Only suggest structural improvements. Do NOT suggest text rewrites or content changes.
If the note is already well-structured, return an empty suggestions array.

Respond ONLY with valid JSON, no markdown code blocks.`;
}

// =============================================================================
// Response Parsing
// =============================================================================

/**
 * Attempt to parse LLM response as JSON.
 * Tries multiple strategies: direct JSON, strip markdown, extract JSON block.
 */
function parseResponse(response: string): RawAnalystResponse | null {
  const trimmed = response.trim();

  // Strategy 1: Direct JSON parse
  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue to next strategy
  }

  // Strategy 2: Strip markdown code block
  const jsonBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlockMatch?.[1]) {
    try {
      return JSON.parse(jsonBlockMatch[1].trim());
    } catch {
      // Continue to next strategy
    }
  }

  // Strategy 3: Extract first JSON object
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // Failed all strategies
    }
  }

  return null;
}

/**
 * Validate and normalize a suggestion type.
 */
function validateSuggestionType(type: string | undefined): SuggestionType | null {
  const validTypes: SuggestionType[] = ["tag", "link", "section", "frontmatter"];
  if (type && validTypes.includes(type as SuggestionType)) {
    return type as SuggestionType;
  }
  return null;
}

/**
 * Generate a unique suggestion ID.
 */
function generateSuggestionId(): string {
  return `sug_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Convert raw LLM response to validated EnhancementSuggestion array.
 */
function convertToSuggestions(raw: RawAnalystResponse): EnhancementSuggestion[] {
  if (!raw.suggestions || !Array.isArray(raw.suggestions)) {
    return [];
  }

  const suggestions: EnhancementSuggestion[] = [];

  for (const item of raw.suggestions) {
    const type = validateSuggestionType(item.type);
    if (!type) continue;

    // Must have description and preview
    if (!item.description || !item.preview) continue;

    const metadata: SuggestionMetadata = {
      confidence: typeof item.confidence === "number" ? Math.min(100, Math.max(0, item.confidence)) : 50,
      reasoning: item.reasoning,
    };

    // Add type-specific metadata
    if (type === "tag" && Array.isArray(item.tags)) {
      metadata.tags = item.tags;
    }
    if (type === "link" && item.linkTarget) {
      metadata.linkTarget = item.linkTarget;
    }
    if (type === "section" && item.sectionTitle) {
      metadata.sectionTitle = item.sectionTitle;
    }
    if (type === "frontmatter" && item.frontmatterKey) {
      metadata.frontmatterKey = item.frontmatterKey;
      metadata.frontmatterValue = item.frontmatterValue;
    }

    suggestions.push({
      id: generateSuggestionId(),
      type,
      description: item.description,
      preview: item.preview,
      metadata,
    });
  }

  return suggestions;
}

// =============================================================================
// Functional Core
// =============================================================================

/**
 * Analyze note context and generate enhancement suggestions.
 *
 * @param context - Built context from ContextBuilder
 * @param config - Optional abort signal
 * @returns Array of enhancement suggestions
 */
export async function analyze(
  context: BuiltContext,
  config?: AgentConfig,
): Promise<AgentResult<EnhancementSuggestion[]>> {
  // Check for abort
  if (config?.abortSignal?.aborted) {
    return { success: false, error: "Aborted" };
  }

  // Build prompt
  const _prompt = buildAnalysisPrompt(context);

  // TODO: G3 will implement LLM provider
  // For now, stub with empty response indicating LLM not available
  // In G3, this will call: const response = await llmProvider.complete(prompt, config);

  // Stub response for typecheck/build verification
  // This will be replaced with actual LLM call in G3
  const stubResponse: RawAnalystResponse = { suggestions: [] };

  // Parse and validate response
  const suggestions = convertToSuggestions(stubResponse);

  return {
    success: true,
    data: suggestions,
  };
}

/**
 * Parse an LLM response string into suggestions.
 * Exported for testing and direct use.
 */
export function parseAnalystResponse(response: string): AgentResult<EnhancementSuggestion[]> {
  const parsed = parseResponse(response);
  if (!parsed) {
    return {
      success: false,
      error: "Failed to parse LLM response as JSON",
    };
  }

  const suggestions = convertToSuggestions(parsed);
  return {
    success: true,
    data: suggestions,
  };
}

// =============================================================================
// Class Wrapper (for lifecycle management)
// =============================================================================

/**
 * AnalystAgent class wrapper.
 * Provides lifecycle management around the functional core.
 */
export class AnalystAgent {
  /**
   * Analyze note context and generate enhancement suggestions.
   *
   * @param context - Built context from ContextBuilder
   * @param config - Optional abort signal
   * @returns Array of enhancement suggestions
   */
  async run(
    context: BuiltContext,
    config?: AgentConfig,
  ): Promise<AgentResult<EnhancementSuggestion[]>> {
    return analyze(context, config);
  }

  /**
   * Parse a raw LLM response string.
   * Useful for testing or when LLM response comes from elsewhere.
   */
  parseResponse(response: string): AgentResult<EnhancementSuggestion[]> {
    return parseAnalystResponse(response);
  }
}
