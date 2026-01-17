/**
 * Agent Types for Notient Pipeline
 * Common interfaces used by all agents: Planner, ContextBuilder, Analyst, Writer
 * Source of truth: .planning/PHASE-GALAXY.md (Phase G2)
 */

import type {
  AgentContext,
  EnhancementSuggestion,
  NoteMaturity,
  SuggestionType,
} from "../../types";

// =============================================================================
// Core Agent Types
// =============================================================================

/**
 * Standard result wrapper for all agent operations.
 * Provides consistent success/error handling across the pipeline.
 */
export interface AgentResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Configuration options passed to agent operations.
 * Supports abort signals for cancellation.
 */
export interface AgentConfig {
  abortSignal?: AbortSignal;
}

// =============================================================================
// Planner Agent Types
// =============================================================================

/**
 * Enhancement priority levels based on note maturity and vitals.
 * Per spec: young→structure, adolescent→connections, mature→synthesis
 */
export type EnhancementPriority = "structure" | "connections" | "synthesis" | "metadata";

/**
 * Output from the Planner agent.
 * Determines what enhancements to prioritize based on note analysis.
 */
export interface EnhancementPlan {
  /** What types of enhancements to focus on, in priority order */
  priorities: EnhancementPriority[];
  /** Suggestion types to generate, derived from priorities */
  suggestionTypes: SuggestionType[];
  /** Note maturity assessment */
  maturity: NoteMaturity;
  /** Brief analysis rationale (for debugging/logging) */
  rationale: string;
}

// =============================================================================
// ContextBuilder Agent Types
// =============================================================================

/**
 * Context layers as defined in PHASE-GALAXY.md.
 * MVP implements layers 0-2 only.
 */
export type ContextLayer = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/**
 * Built context passed to the Analyst agent.
 * Contains structured information about the note for LLM processing.
 */
export interface BuiltContext {
  /** Original agent context */
  agentContext: AgentContext;
  /** Enhancement plan from Planner */
  plan: EnhancementPlan;
  /** Layers included in this context (for debugging) */
  includedLayers: ContextLayer[];
  /** Structured context sections for LLM prompt */
  sections: ContextSection[];
}

/**
 * A section of context to include in the LLM prompt.
 */
export interface ContextSection {
  /** Section header (e.g., "Note Content", "Frontmatter") */
  header: string;
  /** Section content */
  content: string;
  /** Which layer this section belongs to */
  layer: ContextLayer;
}

// =============================================================================
// Analyst Agent Types
// =============================================================================

/**
 * Raw LLM response before validation.
 * Used for flexible JSON parsing with fallback.
 */
export interface RawAnalystResponse {
  suggestions?: Array<{
    type?: string;
    description?: string;
    preview?: string;
    confidence?: number;
    reasoning?: string;
    // Type-specific fields
    tags?: string[];
    linkTarget?: string;
    sectionTitle?: string;
    frontmatterKey?: string;
    frontmatterValue?: unknown;
  }>;
}

// =============================================================================
// Writer Agent Types
// =============================================================================

/**
 * Input for the Writer agent - selected suggestions to apply.
 */
export interface WriteRequest {
  /** Path to the note to modify */
  notePath: string;
  /** Current note content (for hash verification) */
  currentContent: string;
  /** Expected hash (abort if note changed) */
  expectedHash: string;
  /** Selected suggestions to apply */
  suggestions: EnhancementSuggestion[];
}

/**
 * Result of applying suggestions to a note.
 */
export interface WriteResult {
  /** Modified note content */
  newContent: string;
  /** Hash of new content */
  newHash: string;
  /** IDs of successfully applied suggestions */
  appliedSuggestionIds: string[];
  /** IDs of suggestions that failed to apply */
  failedSuggestionIds: string[];
}
