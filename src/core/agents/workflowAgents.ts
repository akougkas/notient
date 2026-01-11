/**
 * Workflow Agents
 *
 * Specialized agents for Intelligence 2.0 workflows.
 * These agents extend the base agent system with workflow-specific
 * prompts from the intelligence/prompts system.
 *
 * Workflows map to slash commands:
 * - /enhance → EnhanceAgent
 * - /atomize → AtomicSplitAgent
 * - /synthesize → SynthesisAgent
 * - /tasks → TaskExtractionAgent
 * - /brand → BrandCheckAgent
 * - /connect → ConnectionAgent
 * - /challenge → AntagonistAgent
 * - /clipping → ClippingAgent
 */

import type { UserProfile } from "../../types/profile";
import {
  ANTAGONIST_PROMPT,
  ATOMIC_SPLIT_PROMPT,
  type AgentPrompt,
  BRAND_CHECK_PROMPT,
  CLIPPING_PROMPT,
  CONNECTION_PROMPT,
  ENHANCE_PROMPT,
  SYNTHESIS_PROMPT,
  TASK_EXTRACTION_PROMPT,
  buildAntagonistPrompt,
  buildAtomicSplitPrompt,
  buildBrandCheckPrompt,
  buildClippingPrompt,
  buildConnectionPrompt,
  buildEnhancePrompt,
  buildSynthesisPrompt,
  buildTaskExtractionPrompt,
} from "../intelligence/prompts";
import type { LLMProvider } from "../llm/provider";
import { BaseAgent } from "./base";
import type { AgentContext, AgentEvent, AgentType, StructuredOutput } from "./types";

/**
 * Workflow agent types (Intelligence 2.0)
 */
export type WorkflowAgentType =
  | "enhance"
  | "atomic"
  | "synthesis"
  | "task"
  | "brand"
  | "connection"
  | "antagonist"
  | "clipping";

/**
 * Configuration for workflow agents
 */
export interface WorkflowAgentConfig {
  type: WorkflowAgentType;
  name: string;
  slashCommand: string;
  description: string;
  temperature: number;
  maxTokens: number;
  getPrompt: (profile?: UserProfile) => string;
  staticPrompt: AgentPrompt;
}

/**
 * Workflow agent configurations
 */
export const WORKFLOW_CONFIGS: Record<WorkflowAgentType, WorkflowAgentConfig> = {
  enhance: {
    type: "enhance",
    name: "Enhance Agent",
    slashCommand: "/enhance",
    description: "Transform captures into well-structured vault notes",
    temperature: 0.3,
    maxTokens: 2000,
    getPrompt: buildEnhancePrompt,
    staticPrompt: ENHANCE_PROMPT,
  },
  atomic: {
    type: "atomic",
    name: "Atomic Split Agent",
    slashCommand: "/atomize",
    description: "Break complex notes into atomic concepts (100-300 words each)",
    temperature: 0.2,
    maxTokens: 2000,
    getPrompt: buildAtomicSplitPrompt,
    staticPrompt: ATOMIC_SPLIT_PROMPT,
  },
  synthesis: {
    type: "synthesis",
    name: "Synthesis Agent",
    slashCommand: "/synthesize",
    description: "Create synthesis notes from related concept clusters",
    temperature: 0.3,
    maxTokens: 3000,
    getPrompt: buildSynthesisPrompt,
    staticPrompt: SYNTHESIS_PROMPT,
  },
  task: {
    type: "task",
    name: "Task Extraction Agent",
    slashCommand: "/tasks",
    description: "Extract actionable items, decisions, and deadlines",
    temperature: 0.2,
    maxTokens: 2000,
    getPrompt: buildTaskExtractionPrompt,
    staticPrompt: TASK_EXTRACTION_PROMPT,
  },
  brand: {
    type: "brand",
    name: "Brand Check Agent",
    slashCommand: "/brand",
    description: "Evaluate content against brand voice and standards",
    temperature: 0.3,
    maxTokens: 2000,
    getPrompt: buildBrandCheckPrompt,
    staticPrompt: BRAND_CHECK_PROMPT,
  },
  connection: {
    type: "connection",
    name: "Connection Agent",
    slashCommand: "/connect",
    description: "Build semantic connections with 6 relationship types",
    temperature: 0.3,
    maxTokens: 2000,
    getPrompt: buildConnectionPrompt,
    staticPrompt: CONNECTION_PROMPT,
  },
  antagonist: {
    type: "antagonist",
    name: "Antagonist Agent",
    slashCommand: "/challenge",
    description: "Provide counterpoints and devil's advocate perspective",
    temperature: 0.4,
    maxTokens: 2000,
    getPrompt: buildAntagonistPrompt,
    staticPrompt: ANTAGONIST_PROMPT,
  },
  clipping: {
    type: "clipping",
    name: "Clipping Agent",
    slashCommand: "/clipping",
    description: "Process web clippings into structured vault notes",
    temperature: 0.3,
    maxTokens: 2000,
    getPrompt: buildClippingPrompt,
    staticPrompt: CLIPPING_PROMPT,
  },
};

/**
 * Base class for workflow agents
 */
export class WorkflowAgent extends BaseAgent {
  protected profile?: UserProfile;
  protected workflowConfig: WorkflowAgentConfig;

  constructor(llm: LLMProvider, workflowType: WorkflowAgentType, profile?: UserProfile) {
    // Map workflow types to generic "note-editor" agent type for base config
    super(llm, "note-editor");
    this.profile = profile;
    this.workflowConfig = WORKFLOW_CONFIGS[workflowType];
  }

  /**
   * Update user profile
   */
  setProfile(profile: UserProfile | undefined): void {
    this.profile = profile;
  }

  /**
   * Get workflow configuration
   */
  getWorkflowConfig(): Readonly<WorkflowAgentConfig> {
    return this.workflowConfig;
  }

  /**
   * Build system prompt using the workflow's profile-aware builder
   */
  protected buildSystemPrompt(context: AgentContext): string {
    // Get profile-aware system prompt from Intelligence 2.0
    const systemPrompt = this.workflowConfig.getPrompt(this.profile);

    // Add context
    const contextParts: string[] = [systemPrompt];

    // Add current note
    contextParts.push(this.formatNoteForPrompt(context.currentNote, 4000));

    // Add related notes if available
    if (context.relatedNotes?.length) {
      const relatedFormatted = context.relatedNotes
        .slice(0, 5)
        .map((n) => `### [[${n.title}]] (${n.path})\n${n.text.slice(0, 300)}...`)
        .join("\n\n");
      contextParts.push(`\nRELATED NOTES:\n${relatedFormatted}`);
    }

    return contextParts.join("\n");
  }

  /**
   * Parse structured output
   */
  protected parseOutput(rawOutput: string, context: AgentContext): StructuredOutput {
    const parsed = this.parseJSON<Record<string, unknown>>(rawOutput);

    return {
      kind: "structured",
      agentType: "note-editor", // Generic type for workflow outputs
      schema: this.workflowConfig.type,
      data: parsed || {},
    };
  }

  /**
   * Execute workflow agent
   */
  async *execute(context: AgentContext, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const agentType = this.workflowConfig.type as unknown as AgentType;

    yield { type: "started", agentType };
    yield { type: "progress", agentType, progress: 10 };

    const systemPrompt = this.buildSystemPrompt(context);

    // Build user message from workflow template
    const userMessage = this.buildUserMessage(context);

    const messages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userMessage },
    ];

    this.log(`Executing workflow: ${this.workflowConfig.name}`);

    try {
      yield { type: "progress", agentType, progress: 30 };

      const rawOutput = await this.llm.complete(messages, {
        temperature: this.workflowConfig.temperature,
        maxTokens: this.workflowConfig.maxTokens,
      });

      yield { type: "progress", agentType, progress: 70 };

      const output = this.parseOutput(rawOutput, context);

      this.log(`Workflow completed: ${this.workflowConfig.name}`);

      yield { type: "progress", agentType, progress: 100 };
      yield { type: "complete", agentType, output };
    } catch (error) {
      yield { type: "error", agentType, error: error as Error };
    }
  }

  /**
   * Build user message from workflow template
   */
  private buildUserMessage(context: AgentContext): string {
    const template = this.workflowConfig.staticPrompt.userTemplate;

    // Replace placeholders
    let message = template
      .replace("{{noteTitle}}", context.currentNote.title)
      .replace("{{notePath}}", context.currentNote.path)
      .replace("{{noteContent}}", context.currentNote.content.slice(0, 6000));

    // Replace relatedNotes placeholder if present
    if (template.includes("{{relatedNotes}}") && context.relatedNotes?.length) {
      const relatedText = context.relatedNotes
        .map((n) => `## ${n.title}\n${n.text.slice(0, 500)}`)
        .join("\n\n");
      message = message.replace("{{relatedNotes}}", relatedText);
    }

    return message;
  }
}

/**
 * Factory function to create workflow agents
 */
export function createWorkflowAgent(
  llm: LLMProvider,
  workflowType: WorkflowAgentType,
  profile?: UserProfile,
): WorkflowAgent {
  return new WorkflowAgent(llm, workflowType, profile);
}

/**
 * Get all available workflow configurations
 */
export function getAllWorkflowConfigs(): WorkflowAgentConfig[] {
  return Object.values(WORKFLOW_CONFIGS);
}

/**
 * Get workflow config by slash command
 */
export function getWorkflowByCommand(command: string): WorkflowAgentConfig | undefined {
  const normalized = command.startsWith("/") ? command : `/${command}`;
  return Object.values(WORKFLOW_CONFIGS).find((c) => c.slashCommand === normalized);
}

/**
 * Check if a command is a workflow command
 */
export function isWorkflowCommand(command: string): boolean {
  return getWorkflowByCommand(command) !== undefined;
}
