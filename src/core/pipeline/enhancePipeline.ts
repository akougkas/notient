/**
 * Enhancement Pipeline Orchestrator for Notient
 * Runs the 4-step pipeline: Planner → ContextBuilder → Analyst → (Writer on apply)
 * Source of truth: .planning/PHASE-GALAXY.md (Phase G3)
 *
 * Per spec decisions:
 * - Communication: Direct calls for pipeline, events for UI updates
 * - Error Handling: Abort entire pipeline on any failure
 * - Cancel: Hard abort (kill immediately, discard partial)
 * - Returns suggestions only; Writer called separately on apply
 */

import type { AgentContext, EnhancementSuggestion, PipelineStage } from "../../types";
import { analyze } from "../agents/analyst";
import { buildContext } from "../agents/contextBuilder";
import { plan } from "../agents/planner";
import type { EventBus } from "../events";
import { kernel } from "../kernel";
import type { PipelineOptions, PipelineResult } from "./types";

// =============================================================================
// Progress Constants
// =============================================================================

/** Progress percentages for each pipeline stage (weighted by expected execution time) */
const STAGE_PROGRESS: Record<PipelineStage, number> = {
  idle: 0,
  planner: 15,
  "context-builder": 35,
  analyst: 85,
  writer: 100, // Writer is not part of enhance pipeline (called on apply)
};

// =============================================================================
// Helper Functions
// =============================================================================

/** Check if pipeline should abort based on signal */
function isAborted(options?: PipelineOptions): boolean {
  return options?.abortSignal?.aborted ?? false;
}

/** Emit progress event and call progress callback */
function emitProgress(
  eventBus: EventBus,
  noteId: string,
  stage: PipelineStage,
  options?: PipelineOptions,
): void {
  const percent = STAGE_PROGRESS[stage];
  eventBus.emit("enhance:progress", { noteId, percent, stage });
  options?.onProgress?.(stage, percent);
}

/** Create abort result */
function abortResult(): PipelineResult {
  return { success: false, aborted: true };
}

/** Create error result */
function errorResult(error: string): PipelineResult {
  return { success: false, error };
}

/** Create success result */
function successResult(suggestions: EnhancementSuggestion[]): PipelineResult {
  return { success: true, suggestions };
}

// =============================================================================
// Stage Runner
// =============================================================================

/** Generic agent result with optional data */
interface AgentResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Run a single pipeline stage with abort check and progress emission.
 * @returns The stage data on success, or throws with error message
 */
async function runStage<T>(
  stageName: PipelineStage,
  defaultError: string,
  stageFn: () => Promise<AgentResult<T>>,
  eventBus: EventBus,
  noteId: string,
  options?: PipelineOptions,
): Promise<T> {
  if (isAborted(options)) {
    throw new AbortError();
  }

  emitProgress(eventBus, noteId, stageName, options);

  const result = await stageFn();
  if (!result.success || result.data === undefined) {
    const error = result.error ?? defaultError;
    eventBus.emit("enhance:error", { noteId, error });
    throw new StageError(error);
  }

  return result.data;
}

/** Marker error for abort */
class AbortError extends Error {
  constructor() {
    super("aborted");
  }
}

/** Marker error for stage failure */
class StageError extends Error {}

// =============================================================================
// Main Pipeline Function
// =============================================================================

/**
 * Run the enhancement pipeline for a note.
 *
 * Pipeline stages:
 * 1. Planner - Analyze note and determine enhancement strategy
 * 2. ContextBuilder - Build LLM context from note and vault
 * 3. Analyst - Generate enhancement suggestions via LLM
 * 4. Return suggestions (Writer called separately on apply)
 *
 * @param context - Agent context with note content and metadata
 * @param options - Pipeline options (abort signal, progress callback)
 * @returns Pipeline result with suggestions or error
 */
export async function runEnhancePipeline(
  context: AgentContext,
  options?: PipelineOptions,
): Promise<PipelineResult> {
  const noteId = context.notePath;
  const abortOpts = { abortSignal: options?.abortSignal };

  // Get EventBus from kernel
  let eventBus: EventBus;
  try {
    eventBus = kernel.get("eventBus");
  } catch {
    return errorResult("EventBus not available - kernel not initialized");
  }

  eventBus.emit("enhance:start", { noteId, timestamp: Date.now() });

  try {
    // Stage 1: Planner
    const enhancementPlan = await runStage(
      "planner",
      "Planner failed to produce plan",
      () => plan(context, abortOpts),
      eventBus,
      noteId,
      options,
    );

    // Stage 2: ContextBuilder
    const builtContext = await runStage(
      "context-builder",
      "ContextBuilder failed to build context",
      () => buildContext(context, enhancementPlan, abortOpts),
      eventBus,
      noteId,
      options,
    );

    // Stage 3: Analyst
    const suggestions = await runStage(
      "analyst",
      "Analyst failed to generate suggestions",
      () => analyze(builtContext, abortOpts),
      eventBus,
      noteId,
      options,
    );

    // Final abort check before returning
    if (isAborted(options)) {
      return abortResult();
    }

    eventBus.emit("enhance:complete", { noteId, suggestionCount: suggestions.length, suggestions });
    return successResult(suggestions);
  } catch (error) {
    if (error instanceof AbortError) {
      return abortResult();
    }
    if (error instanceof StageError) {
      return errorResult(error.message);
    }
    // Unexpected error
    const errorMessage = error instanceof Error ? error.message : String(error);
    eventBus.emit("enhance:error", { noteId, error: errorMessage });
    return errorResult(errorMessage);
  }
}

// =============================================================================
// Class Wrapper
// =============================================================================

/**
 * EnhancePipeline class wrapper for consumers who prefer class-based API.
 * Delegates to the functional runEnhancePipeline implementation.
 */
export class EnhancePipeline {
  /**
   * Run the enhancement pipeline for a note.
   * @param context - Agent context with note content and metadata
   * @param options - Pipeline options (abort signal, progress callback)
   * @returns Pipeline result with suggestions or error
   */
  async run(context: AgentContext, options?: PipelineOptions): Promise<PipelineResult> {
    return runEnhancePipeline(context, options);
  }
}
