/**
 * Worker Agent - Unified Workflow Executor
 *
 * Phase 2 of Swarm Architecture refactor.
 *
 * WorkerAgent absorbs ALL workflow execution:
 * - Classify (PARA categorization)
 * - Enhance (quick capture improvement)
 * - Atomize (break down complex notes)
 * - Connect (find semantic relationships)
 * - Synthesize (combine related notes)
 * - Challenge (devil's advocate)
 * - Extract tasks
 * - Process clippings
 * - Brand check
 *
 * Key principle: Reuses existing workflow prompts from intelligence/prompts.
 * We're not rewriting prompts, just changing WHO executes them.
 */

import type { UserProfile } from "../../types/profile";
import type { LLMProvider } from "../llm/provider";
import { BaseAgent } from "./base";
import type { AgentContext, AgentEvent, AgentType, StructuredOutput } from "./types";
import {
  WORKFLOW_CONFIGS,
  type WorkflowAgentConfig,
  type WorkflowAgentType,
} from "./workflowAgents";

/**
 * Workflow types the Worker can execute.
 * Maps directly to existing WorkflowAgentType.
 */
export type WorkflowType = WorkflowAgentType;

/**
 * WorkerAgent - Unified workflow executor for the 4-Agent Swarm.
 *
 * Receives workflow delegation from Orchestrator (ChiefOfStaff),
 * loads the appropriate prompt config, executes against LLM,
 * and returns structured output.
 */
export class WorkerAgent extends BaseAgent {
  private workflowType: WorkflowType;
  private workflowConfig: WorkflowAgentConfig;
  private profile?: UserProfile;

  constructor(llm: LLMProvider, workflowType: WorkflowType, profile?: UserProfile) {
    // Use "note-editor" as base agent type for config (structured output)
    super(llm, "note-editor");
    this.workflowType = workflowType;
    this.workflowConfig = WORKFLOW_CONFIGS[workflowType];
    this.profile = profile;
  }

  /**
   * Get the workflow type this agent is executing
   */
  getWorkflowType(): WorkflowType {
    return this.workflowType;
  }

  /**
   * Get the workflow configuration
   */
  getWorkflowConfig(): Readonly<WorkflowAgentConfig> {
    return this.workflowConfig;
  }

  /**
   * Update user profile for identity system
   */
  setProfile(profile: UserProfile | undefined): void {
    this.profile = profile;
  }

  /**
   * Build system prompt using the workflow's profile-aware builder.
   * Reuses existing prompt builders from intelligence/prompts.
   */
  protected buildSystemPrompt(context: AgentContext): string {
    // Get profile-aware system prompt from workflow config
    const systemPrompt = this.workflowConfig.getPrompt(this.profile);

    // Add context (current note formatted for prompt)
    const contextParts: string[] = [systemPrompt];
    contextParts.push(this.formatNoteForPrompt(context.currentNote, 4000));

    // Add related notes if available
    if (context.relatedNotes?.length) {
      const relatedFormatted = context.relatedNotes
        .slice(0, 5)
        .map((note) => `### [[${note.title}]] (${note.path})\n${note.text.slice(0, 300)}...`)
        .join("\n\n");
      contextParts.push(`\nRELATED NOTES:\n${relatedFormatted}`);
    }

    return contextParts.join("\n");
  }

  /**
   * Parse structured output from LLM response.
   * Returns generic structured output with workflow-specific schema.
   */
  protected parseOutput(rawOutput: string, _context: AgentContext): StructuredOutput {
    const sanitized = this.sanitizeLLMOutput(rawOutput);
    const parsed = this.parseJSON<Record<string, unknown>>(sanitized);

    return {
      kind: "structured",
      agentType: "note-editor", // Generic type for workflow outputs
      schema: this.workflowType,
      data: parsed || {},
    };
  }

  /**
   * Execute the workflow.
   *
   * Flow:
   * 1. Build system prompt from workflow config + context
   * 2. Build user message from template
   * 3. Call LLM with appropriate temperature
   * 4. Parse and return structured output
   */
  async *execute(context: AgentContext, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const agentType = this.workflowType as unknown as AgentType;

    yield { type: "started", agentType };
    yield { type: "progress", agentType, progress: 10 };

    const systemPrompt = this.buildSystemPrompt(context);
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
   * Build user message from workflow template.
   * Replaces placeholders with actual context values.
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
        .map((note) => `## ${note.title}\n${note.text.slice(0, 500)}`)
        .join("\n\n");
      message = message.replace("{{relatedNotes}}", relatedText);
    }

    return message;
  }
}

/**
 * Factory function to create a WorkerAgent for a specific workflow.
 */
export function createWorkerAgent(
  llm: LLMProvider,
  workflowType: WorkflowType,
  profile?: UserProfile,
): WorkerAgent {
  return new WorkerAgent(llm, workflowType, profile);
}

/**
 * Check if a workflow type is valid
 */
export function isValidWorkflowType(type: string): type is WorkflowType {
  return type in WORKFLOW_CONFIGS;
}
