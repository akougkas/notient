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
import type { PipelineOptions, PipelineResult } from "./types";
import { plan, PlannerAgent } from "../agents/planner";
import { buildContext, ContextBuilderAgent } from "../agents/contextBuilder";
import { analyze, AnalystAgent } from "../agents/analyst";
import { kernel } from "../kernel";
import type { EventBus } from "../events";

// =============================================================================
// Progress Constants
// =============================================================================

/**
 * Progress percentages for each pipeline stage.
 * Weighted by expected execution time.
 */
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

/**
 * Check if pipeline should abort based on signal.
 */
function isAborted(options?: PipelineOptions): boolean {
  return options?.abortSignal?.aborted ?? false;
}

/**
 * Emit progress event and call progress callback.
 */
function emitProgress(
  eventBus: EventBus,
  noteId: string,
  stage: PipelineStage,
  options?: PipelineOptions,
): void {
  const percent = STAGE_PROGRESS[stage];

  // Emit event for UI
  eventBus.emit("enhance:progress", {
    noteId,
    percent,
    stage,
  });

  // Call callback if provided
  options?.onProgress?.(stage, percent);
}

/**
 * Create abort error result.
 */
function createAbortResult(): PipelineResult {
  return {
    success: false,
    aborted: true,
  };
}

/**
 * Create error result with message.
 */
function createErrorResult(error: string): PipelineResult {
  return {
    success: false,
    error,
  };
}

/**
 * Create success result with suggestions.
 */
function createSuccessResult(suggestions: EnhancementSuggestion[]): PipelineResult {
  return {
    success: true,
    suggestions,
  };
}

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

  // Get EventBus from kernel
  let eventBus: EventBus;
  try {
    eventBus = kernel.get("eventBus");
  } catch {
    return createErrorResult("EventBus not available - kernel not initialized");
  }

  // Emit start event
  eventBus.emit("enhance:start", {
    noteId,
    timestamp: Date.now(),
  });

  try {
    // =========================================================================
    // Stage 1: Planner
    // =========================================================================
    if (isAborted(options)) {
      return createAbortResult();
    }

    emitProgress(eventBus, noteId, "planner", options);

    const planResult = await plan(context, {
      abortSignal: options?.abortSignal,
    });

    if (!planResult.success || !planResult.data) {
      const error = planResult.error ?? "Planner failed to produce plan";
      eventBus.emit("enhance:error", { noteId, error });
      return createErrorResult(error);
    }

    const enhancementPlan = planResult.data;

    // =========================================================================
    // Stage 2: ContextBuilder
    // =========================================================================
    if (isAborted(options)) {
      return createAbortResult();
    }

    emitProgress(eventBus, noteId, "context-builder", options);

    const contextResult = await buildContext(context, enhancementPlan, {
      abortSignal: options?.abortSignal,
    });

    if (!contextResult.success || !contextResult.data) {
      const error = contextResult.error ?? "ContextBuilder failed to build context";
      eventBus.emit("enhance:error", { noteId, error });
      return createErrorResult(error);
    }

    const builtContext = contextResult.data;

    // =========================================================================
    // Stage 3: Analyst
    // =========================================================================
    if (isAborted(options)) {
      return createAbortResult();
    }

    emitProgress(eventBus, noteId, "analyst", options);

    const analyzeResult = await analyze(builtContext, {
      abortSignal: options?.abortSignal,
    });

    if (!analyzeResult.success) {
      const error = analyzeResult.error ?? "Analyst failed to generate suggestions";
      eventBus.emit("enhance:error", { noteId, error });
      return createErrorResult(error);
    }

    const suggestions = analyzeResult.data ?? [];

    // =========================================================================
    // Complete
    // =========================================================================
    if (isAborted(options)) {
      return createAbortResult();
    }

    // Emit complete event
    eventBus.emit("enhance:complete", {
      noteId,
      suggestionCount: suggestions.length,
    });

    return createSuccessResult(suggestions);
  } catch (error) {
    // Catch any unexpected errors
    const errorMessage = error instanceof Error ? error.message : String(error);
    eventBus.emit("enhance:error", { noteId, error: errorMessage });
    return createErrorResult(errorMessage);
  }
}

// =============================================================================
// Class Wrapper
// =============================================================================

/**
 * EnhancePipeline class wrapper.
 * Provides orchestration with agent instances for lifecycle management.
 */
export class EnhancePipeline {
  private planner: PlannerAgent;
  private contextBuilder: ContextBuilderAgent;
  private analyst: AnalystAgent;

  constructor() {
    this.planner = new PlannerAgent();
    this.contextBuilder = new ContextBuilderAgent();
    this.analyst = new AnalystAgent();
  }

  /**
   * Run the enhancement pipeline for a note.
   *
   * @param context - Agent context with note content and metadata
   * @param options - Pipeline options (abort signal, progress callback)
   * @returns Pipeline result with suggestions or error
   */
  async run(
    context: AgentContext,
    options?: PipelineOptions,
  ): Promise<PipelineResult> {
    return runEnhancePipeline(context, options);
  }
}
