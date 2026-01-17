/**
 * ContextBuilder Agent for Notient Pipeline
 * Builds LLM context from note content + vault metadata.
 * Source of truth: .planning/PHASE-GALAXY.md (Phase G2)
 *
 * Context Layers (MVP = 0-2 only):
 * - Layer 0: Note content
 * - Layer 1: Frontmatter
 * - Layer 2: Obsidian metadata (links, tags)
 *
 * Per spec decisions:
 * - Start minimal, add layers iteratively
 * - Direct calls for pipeline
 */

import type { AgentContext } from "../../types";
import type {
  AgentConfig,
  AgentResult,
  BuiltContext,
  ContextLayer,
  ContextSection,
  EnhancementPlan,
} from "./types";

// =============================================================================
// Layer Builders
// =============================================================================

/**
 * Build Layer 0: Note content only
 */
function buildLayer0(context: AgentContext): ContextSection {
  return {
    header: "Note Content",
    content: context.noteContent,
    layer: 0,
  };
}

/**
 * Build Layer 1: Frontmatter metadata
 */
function buildLayer1(context: AgentContext): ContextSection | null {
  const { frontmatter } = context;

  // Skip if no frontmatter
  if (!frontmatter || Object.keys(frontmatter).length === 0) {
    return null;
  }

  // Format frontmatter as YAML-like string
  const lines = Object.entries(frontmatter).map(([key, value]) => {
    if (Array.isArray(value)) {
      return `${key}: [${value.join(", ")}]`;
    }
    if (typeof value === "object" && value !== null) {
      return `${key}: ${JSON.stringify(value)}`;
    }
    return `${key}: ${value}`;
  });

  return {
    header: "Frontmatter",
    content: lines.join("\n"),
    layer: 1,
  };
}

/**
 * Build Layer 2: Obsidian metadata (links, tags)
 */
function buildLayer2(context: AgentContext): ContextSection | null {
  const { metadata } = context;
  const lines: string[] = [];

  // Title
  if (metadata.title) {
    lines.push(`Title: ${metadata.title}`);
  }

  // Tags
  if (metadata.tags.length > 0) {
    lines.push(`Tags: ${metadata.tags.join(", ")}`);
  }

  // Inbound links (backlinks)
  if (metadata.links.inbound.length > 0) {
    lines.push(`Inbound Links (${metadata.links.inbound.length}): ${metadata.links.inbound.slice(0, 5).join(", ")}${metadata.links.inbound.length > 5 ? "..." : ""}`);
  }

  // Outbound links
  if (metadata.links.outbound.length > 0) {
    lines.push(`Outbound Links (${metadata.links.outbound.length}): ${metadata.links.outbound.slice(0, 5).join(", ")}${metadata.links.outbound.length > 5 ? "..." : ""}`);
  }

  // Vitals summary
  const { vitals, maturity, origin } = metadata;
  lines.push(`Maturity: ${maturity}`);
  lines.push(`Origin: ${origin}`);
  lines.push(`Health: ${vitals.healthScore}% (connectivity: ${vitals.connectivity}, structure: ${vitals.structure}, freshness: ${vitals.freshness})`);

  if (lines.length === 0) {
    return null;
  }

  return {
    header: "Obsidian Metadata",
    content: lines.join("\n"),
    layer: 2,
  };
}

// =============================================================================
// Functional Core
// =============================================================================

/**
 * Build LLM context from note and plan.
 * MVP: Layers 0-2 only (content, frontmatter, obsidian metadata).
 *
 * @param context - Agent context with note content and metadata
 * @param plan - Enhancement plan from Planner
 * @param config - Optional abort signal
 * @returns Built context with structured sections
 */
export async function buildContext(
  context: AgentContext,
  plan: EnhancementPlan,
  config?: AgentConfig,
): Promise<AgentResult<BuiltContext>> {
  // Check for abort
  if (config?.abortSignal?.aborted) {
    return { success: false, error: "Aborted" };
  }

  const sections: ContextSection[] = [];
  const includedLayers: ContextLayer[] = [];

  // Layer 0: Note content (always included)
  const layer0 = buildLayer0(context);
  sections.push(layer0);
  includedLayers.push(0);

  // Layer 1: Frontmatter (if present)
  const layer1 = buildLayer1(context);
  if (layer1) {
    sections.push(layer1);
    includedLayers.push(1);
  }

  // Layer 2: Obsidian metadata
  const layer2 = buildLayer2(context);
  if (layer2) {
    sections.push(layer2);
    includedLayers.push(2);
  }

  return {
    success: true,
    data: {
      agentContext: context,
      plan,
      includedLayers,
      sections,
    },
  };
}

/**
 * Format built context as a single string for LLM prompt.
 * Used by Analyst agent.
 */
export function formatContextForLLM(builtContext: BuiltContext): string {
  const parts: string[] = [];

  for (const section of builtContext.sections) {
    parts.push(`## ${section.header}`);
    parts.push(section.content);
    parts.push(""); // blank line between sections
  }

  // Add plan info
  parts.push("## Enhancement Focus");
  parts.push(`Priorities: ${builtContext.plan.priorities.join(", ")}`);
  parts.push(`Target suggestion types: ${builtContext.plan.suggestionTypes.join(", ")}`);

  return parts.join("\n");
}

// =============================================================================
// Class Wrapper (for lifecycle management)
// =============================================================================

/**
 * ContextBuilderAgent class wrapper.
 * Provides lifecycle management around the functional core.
 */
export class ContextBuilderAgent {
  /**
   * Build LLM context from note and plan.
   *
   * @param context - Agent context with note content and metadata
   * @param plan - Enhancement plan from Planner
   * @param config - Optional abort signal
   * @returns Built context with structured sections
   */
  async run(
    context: AgentContext,
    plan: EnhancementPlan,
    config?: AgentConfig,
  ): Promise<AgentResult<BuiltContext>> {
    return buildContext(context, plan, config);
  }

  /**
   * Format built context for LLM prompt.
   */
  format(builtContext: BuiltContext): string {
    return formatContextForLLM(builtContext);
  }
}
