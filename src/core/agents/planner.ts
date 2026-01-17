/**
 * Planner Agent for Notient Pipeline
 * Analyzes note maturity, origin, vitals to determine enhancement strategy.
 * Source of truth: .planning/PHASE-GALAXY.md (Phase G2)
 *
 * Per spec decisions:
 * - No agent identity (pure task)
 * - Zero-shot (no examples)
 * - Direct calls for pipeline
 * - Maturity Impact: young→structure, adolescent→connections, mature→synthesis
 */

import type { AgentContext, NoteMaturity, SuggestionType } from "../../types";
import type {
  AgentConfig,
  AgentResult,
  EnhancementPlan,
  EnhancementPriority,
} from "./types";

// =============================================================================
// Maturity-Based Priority Mapping
// =============================================================================

/**
 * Maps note maturity to enhancement priorities.
 * Per spec: young→structure, adolescent→connections, mature→synthesis
 */
const MATURITY_PRIORITIES: Record<NoteMaturity, EnhancementPriority[]> = {
  raw: ["structure", "metadata"],
  adolescent: ["connections", "structure", "metadata"],
  mature: ["synthesis", "connections", "metadata"],
  "synthesis-ready": ["metadata", "connections"],
};

/**
 * Maps enhancement priorities to suggestion types.
 */
const PRIORITY_TO_SUGGESTIONS: Record<EnhancementPriority, SuggestionType[]> = {
  structure: ["section", "frontmatter"],
  connections: ["link", "tag"],
  synthesis: ["section", "link"],
  metadata: ["frontmatter", "tag"],
};

// =============================================================================
// Functional Core
// =============================================================================

/**
 * Analyze note and determine enhancement strategy.
 * Pure function - no side effects, no LLM calls (strategy is heuristic-based).
 *
 * @param context - Agent context with note content and metadata
 * @param config - Optional abort signal
 * @returns Enhancement plan with priorities and suggestion types
 */
export async function plan(
  context: AgentContext,
  config?: AgentConfig,
): Promise<AgentResult<EnhancementPlan>> {
  // Check for abort
  if (config?.abortSignal?.aborted) {
    return { success: false, error: "Aborted" };
  }

  const { metadata } = context;
  const { maturity, vitals } = metadata;

  // Get base priorities from maturity
  const basePriorities = MATURITY_PRIORITIES[maturity];

  // Adjust priorities based on vitals
  const priorities = adjustPrioritiesForVitals(basePriorities, vitals);

  // Derive suggestion types from priorities (deduplicated, ordered)
  const suggestionTypes = deriveSuggestionTypes(priorities);

  // Build rationale for debugging
  const rationale = buildRationale(maturity, vitals, priorities);

  return {
    success: true,
    data: {
      priorities,
      suggestionTypes,
      maturity,
      rationale,
    },
  };
}

/**
 * Adjust enhancement priorities based on vitals scores.
 * Low scores in specific areas push those priorities higher.
 */
function adjustPrioritiesForVitals(
  basePriorities: EnhancementPriority[],
  vitals: AgentContext["metadata"]["vitals"],
): EnhancementPriority[] {
  const adjusted = [...basePriorities];

  // Low connectivity → prioritize connections
  if (vitals.connectivity < 30 && !adjusted.includes("connections")) {
    adjusted.unshift("connections");
  }

  // Low structure → prioritize structure
  if (vitals.structure < 30 && !adjusted.includes("structure")) {
    adjusted.unshift("structure");
  }

  return adjusted;
}

/**
 * Derive unique suggestion types from priorities, maintaining order.
 */
function deriveSuggestionTypes(priorities: EnhancementPriority[]): SuggestionType[] {
  const seen = new Set<SuggestionType>();
  const result: SuggestionType[] = [];

  for (const priority of priorities) {
    for (const type of PRIORITY_TO_SUGGESTIONS[priority]) {
      if (!seen.has(type)) {
        seen.add(type);
        result.push(type);
      }
    }
  }

  return result;
}

/**
 * Build human-readable rationale for the plan.
 */
function buildRationale(
  maturity: NoteMaturity,
  vitals: AgentContext["metadata"]["vitals"],
  priorities: EnhancementPriority[],
): string {
  const parts: string[] = [];

  parts.push(`maturity=${maturity}`);
  parts.push(`health=${vitals.healthScore}%`);

  if (vitals.connectivity < 30) {
    parts.push("low-connectivity");
  }
  if (vitals.structure < 30) {
    parts.push("low-structure");
  }

  parts.push(`priorities=[${priorities.join(", ")}]`);

  return parts.join("; ");
}

// =============================================================================
// Class Wrapper (for lifecycle management)
// =============================================================================

/**
 * PlannerAgent class wrapper.
 * Provides lifecycle management around the functional core.
 */
export class PlannerAgent {
  /**
   * Execute planning to determine enhancement strategy.
   *
   * @param context - Agent context with note content and metadata
   * @param config - Optional abort signal
   * @returns Enhancement plan with priorities and suggestion types
   */
  async run(
    context: AgentContext,
    config?: AgentConfig,
  ): Promise<AgentResult<EnhancementPlan>> {
    return plan(context, config);
  }
}
