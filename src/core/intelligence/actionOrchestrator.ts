/**
 * Action Orchestrator
 *
 * Dispatches specialized agent actions and manages action pipelines.
 * Central coordinator for Intelligence 2.0 Genetic UI actions.
 */

import type { UserProfile } from "../../types/profile";
import type { LLMProvider } from "../llm/provider";
import type { SearchPipeline } from "../search/pipeline";
import type { ActionPipeline, ActionPipelineConfig, PipelineEvent } from "./actionPipeline";
import { createActionPipeline } from "./actionPipeline";
import { type AgentPrompt, type IntelligenceActionType, getProfileAwarePrompt } from "./prompts";

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
  /** Existing vault paths for duplicate detection */
  existingPaths?: Set<string>;
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
 * Profile provider function type
 * Returns the current user profile (or undefined if not set)
 */
export type ProfileProvider = () => UserProfile | undefined;

/**
 * Action Orchestrator - Central coordinator for Intelligence 2.0 actions
 */
export class ActionOrchestrator {
  private profileProvider: ProfileProvider;

  constructor(
    private llm: LLMProvider,
    private search: SearchPipeline,
    profileProvider?: ProfileProvider,
  ) {
    // Default to no profile if not provided
    this.profileProvider = profileProvider ?? (() => undefined);
  }

  /**
   * Update the profile provider (e.g., when ProfileManager becomes available)
   */
  setProfileProvider(provider: ProfileProvider): void {
    this.profileProvider = provider;
  }

  /**
   * Dispatch an intelligence action
   */
  async dispatch(
    actionType: IntelligenceActionType,
    context: ActionContext,
    triggerConfig?: TriggerConfig,
  ): Promise<DispatchResult> {
    // Load specialized prompt with current user profile
    const profile = this.profileProvider();
    const prompt = getProfileAwarePrompt(actionType, profile);

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
      existingPaths: triggerConfig?.existingPaths,
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

      case "antagonist":
        return "simple"; // Single-phase analysis

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
      case "antagonist":
        return "~15-30s";

      default:
        return "~30s";
    }
  }

  /**
   * Check if an action type creates multiple notes
   */
  requiresMultipleNotes(actionType: IntelligenceActionType): boolean {
    return actionType === "synthesis" || actionType === "atomic" || actionType === "clipping";
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

      case "antagonist":
        return {
          icon: "flame",
          label: "Challenge",
          description: "Review with Antagonist Agent",
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
