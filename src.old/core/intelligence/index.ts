/**
 * Intelligence 2.0 Module
 *
 * Exports for the Genetic UI Intelligence system.
 */

// Action Orchestrator
export { ActionOrchestrator } from "./actionOrchestrator";
export type {
  ActionContext,
  DispatchResult,
  TriggerConfig,
  WorkflowComplexity,
} from "./actionOrchestrator";

// Action Pipeline
export { createActionPipeline, executeBatchesInOrder } from "./actionPipeline";
export type {
  ActionApplierFn,
  ActionBatch,
  ActionPipeline,
  ActionPipelineConfig,
  BatchExecutionResult,
  PipelineEvent,
  PipelinePhase,
  PipelineResult,
} from "./actionPipeline";

// Prompts
export { AGENT_PROMPTS, getPrompt } from "./prompts";
export type { AgentPrompt, IntelligenceActionType } from "./prompts";

// Re-export prompt modules
export { ANTAGONIST_PROMPT, buildAntagonistPrompt } from "./prompts/antagonist";
export { ATOMIC_SPLIT_PROMPT } from "./prompts/atomic";
export { BRAND_CHECK_PROMPT } from "./prompts/brand";
export { CLIPPING_PROMPT } from "./prompts/clipping";
export { CONNECTION_PROMPT } from "./prompts/connection";
export { ENHANCE_PROMPT } from "./prompts/enhance";
export { SYNTHESIS_PROMPT } from "./prompts/synthesis";
export { TASK_EXTRACTION_PROMPT } from "./prompts/task";

// Types (re-export for convenience)
export type {
  IntelligenceEntity,
  IntelligenceFile,
  IntelligenceHealth,
  IntelligenceHealthBreakdown,
  IntelligenceRecord,
  IntelligenceSuggestedLink,
  IntelligenceSuggestedTag,
  IntelligenceSummaryStructured,
  IntelligenceTriageAction,
} from "./types";
