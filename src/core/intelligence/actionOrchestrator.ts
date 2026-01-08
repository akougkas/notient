/**
 * Action Orchestrator
 *
 * Dispatches specialized agent actions and manages action pipelines.
 * Central coordinator for Intelligence 2.0 Genetic UI actions.
 */

import type { LMStudioService } from "../../services/lmstudio";
import type { SearchPipeline } from "../search/pipeline";
import type { ActionPipeline, ActionPipelineConfig, PipelineEvent } from "./actionPipeline";
import { createActionPipeline } from "./actionPipeline";
import { type AgentPrompt, type IntelligenceActionType, getPrompt } from "./prompts";

/**
 * Workflow complexity level
 */
export type WorkflowComplexity = "simple" | "complex" | "batch";

/**
 * Context for action execution
 */
export interface ActionContext {
  /** Current note path */
  notePath: string;
  /** Current note title */
  noteTitle: string;
  /** Current note content */
  noteContent: string;
  /** Related notes for context */
  relatedNotes?: Array<{
    path: string;
    title: string;
    content: string;
  }>;
  /** Additional configuration */
  config?: Record<string, unknown>;
}

/**
 * Configuration for triggering an agent action
 */
export interface TriggerConfig {
  /** Scope of the action */
  scope?: "note" | "selection" | "folder" | "tags";
  /** Expected number of notes to create */
  estimatedNotes?: string;
  /** Whether to show connection types */
  showTypes?: boolean;
  /** Score threshold for quality checks */
  scoreThreshold?: number;
  /** Content type for brand checks */
  contentType?: string;
  /** Target audience */
  targetAudience?: string;
  /** Source URL for clippings */
  sourceUrl?: string;
  /** Extract deadlines */
  extractDeadlines?: boolean;
}

/**
 * Result of dispatching an action
 */
export interface DispatchResult {
  /** The created pipeline */
  pipeline: ActionPipeline;
  /** Action type */
  actionType: IntelligenceActionType;
  /** Workflow complexity */
  complexity: WorkflowComplexity;
  /** The prompt being used */
  prompt: AgentPrompt;
}

/**
 * Action Orchestrator - Central coordinator for Intelligence 2.0 actions
 */
export class ActionOrchestrator {
  constructor(
    private llm: LMStudioService,
    private search: SearchPipeline,
  ) {}

  /**
   * Dispatch an intelligence action
   */
  async dispatch(
    actionType: IntelligenceActionType,
    context: ActionContext,
    triggerConfig?: TriggerConfig,
  ): Promise<DispatchResult> {
    // Load specialized prompt
    const prompt = getPrompt(actionType);

    // Detect workflow complexity
    const complexity = this.detectComplexity(actionType);

    // Build pipeline configuration
    const pipelineConfig: ActionPipelineConfig = {
      actionType,
      prompt,
      complexity,
      context,
      triggerConfig: triggerConfig as Record<string, unknown> | undefined,
      llm: this.llm,
      search: this.search,
    };

    // Create pipeline
    const pipeline = createActionPipeline(pipelineConfig);

    return {
      pipeline,
      actionType,
      complexity,
      prompt,
    };
  }

  /**
   * Execute an action and yield events
   */
  async *execute(
    actionType: IntelligenceActionType,
    context: ActionContext,
    triggerConfig?: TriggerConfig,
  ): AsyncGenerator<PipelineEvent> {
    const { pipeline } = await this.dispatch(actionType, context, triggerConfig);
    yield* pipeline.execute();
  }

  /**
   * Detect workflow complexity based on action type
   */
  private detectComplexity(actionType: IntelligenceActionType): WorkflowComplexity {
    switch (actionType) {
      case "atomic":
      case "synthesis":
      case "clipping":
        return "batch"; // Multiple notes created

      case "task":
      case "brand":
        return "complex"; // Multi-phase analysis

      case "enhance":
      case "connection":
        return "simple"; // Single-note operation

      default:
        return "simple";
    }
  }

  /**
   * Get estimated duration for an action type
   */
  getEstimatedDuration(actionType: IntelligenceActionType): string {
    switch (actionType) {
      case "atomic":
      case "synthesis":
      case "clipping":
        return "~45-90s";

      case "task":
      case "brand":
        return "~30-60s";

      case "enhance":
      case "connection":
        return "~15-30s";

      default:
        return "~30s";
    }
  }

  /**
   * Check if an action type requires multiple notes
   */
  requiresMultipleNotes(actionType: IntelligenceActionType): boolean {
    return actionType === "synthesis";
  }

  /**
   * Get action type display info
   */
  getActionInfo(actionType: IntelligenceActionType): {
    icon: string;
    label: string;
    description: string;
  } {
    switch (actionType) {
      case "atomic":
        return {
          icon: "split",
          label: "Atomize",
          description: "Break into atomic concepts (100-300 words each)",
        };

      case "synthesis":
        return {
          icon: "network",
          label: "Synthesize",
          description: "Create synthesis from related notes",
        };

      case "clipping":
        return {
          icon: "clipboard",
          label: "Process Clipping",
          description: "Web article → atomic notes",
        };

      case "task":
        return {
          icon: "check-square",
          label: "Extract Tasks",
          description: "Find actions & deadlines",
        };

      case "brand":
        return {
          icon: "shield",
          label: "Brand Check",
          description: "Verify brand alignment",
        };

      case "connection":
        return {
          icon: "link",
          label: "Connect",
          description: "Find semantic connections (6 types)",
        };

      case "enhance":
        return {
          icon: "sparkles",
          label: "Enhance",
          description: "Transform informal → structured",
        };

      default:
        return {
          icon: "zap",
          label: actionType,
          description: "Unknown action",
        };
    }
  }
}
