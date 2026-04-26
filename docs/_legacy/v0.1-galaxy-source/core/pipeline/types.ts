/**
 * Pipeline Types for Notient Enhancement Pipeline
 * Source of truth: .planning/PHASE-GALAXY.md (Phase G3)
 *
 * Per spec decisions:
 * - Communication: Direct calls for pipeline, events for UI updates
 * - Error Handling: Abort entire pipeline on any failure
 * - Cancel: Hard abort (kill immediately, discard partial)
 * - Timeout: Ask user ('LLM slow. Wait or cancel?')
 * - Streaming: Wait for complete (buffer, parse at end)
 */

import type { AgentContext, EnhancementSuggestion, PipelineStage } from "../../types";

// =============================================================================
// Pipeline Configuration
// =============================================================================

/**
 * Options for running the enhancement pipeline.
 */
export interface PipelineOptions {
  /** AbortSignal for cancellation support */
  abortSignal?: AbortSignal;
  /** Progress callback for UI updates */
  onProgress?: (stage: PipelineStage, percent: number) => void;
  /** Timeout in milliseconds before asking user (not implemented in MVP) */
  timeoutMs?: number;
}

// =============================================================================
// Pipeline Results
// =============================================================================

/**
 * Result from running the enhancement pipeline.
 * Returns suggestions on success, error details on failure.
 */
export interface PipelineResult {
  /** Whether the pipeline completed successfully */
  success: boolean;
  /** Enhancement suggestions (only present on success) */
  suggestions?: EnhancementSuggestion[];
  /** Error message (only present on failure) */
  error?: string;
  /** Whether pipeline was aborted by user */
  aborted?: boolean;
}

// =============================================================================
// Pipeline Input
// =============================================================================

/**
 * Input for running the enhancement pipeline.
 */
export interface PipelineInput {
  /** Agent context with note content and metadata */
  context: AgentContext;
  /** Optional pipeline options */
  options?: PipelineOptions;
}
