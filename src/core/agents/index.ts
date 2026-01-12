/**
 * Multi-Agent System Exports
 *
 * White House Model Architecture:
 * - President = User (decision maker)
 * - Chief of Staff = Notient core (coordinator, dispatcher, router, aggregator)
 * - Department Heads = Specialized agents (core + workflow)
 *
 * Two-Tier Identity System:
 * - Tier 1: Core Notient Identity (Research Chief of Staff + user profile)
 * - Tier 2: Agent Specialization (role + mission + output format)
 *
 * Agent Types:
 * - Core Agents: chat, note-editor, classifier, connection, context-builder
 * - Workflow Agents: enhance, atomic, synthesis, task, brand, connection, antagonist, clipping
 */

// Types
export * from "./types";

// Base agent
export { BaseAgent, isConversationalOutput, isStructuredOutput, isInternalOutput } from "./base";

// Agent identity system (two-tier prompts)
export {
  buildAgentSystemPrompt,
  getAgentSpecialization,
  isStructuredOutputAgent,
  canDelegate,
  getDelegationTargets,
  AGENT_SPECIALIZATIONS,
} from "./agentIdentity";
export type { AgentSpecialization, AgentOutputFormat, AgentDelegationSpec } from "./agentIdentity";

// Core agents (Department Heads)
export { ChatAgent } from "./chatAgent";
export { NoteEditorAgent } from "./noteEditorAgent";
export { ClassifierAgent } from "./classifierAgent";
export { ConnectionAgent } from "./connectionAgent";
export { ContextBuilderAgent } from "./contextBuilderAgent";

// Workflow agents (Intelligence 2.0)
export {
  WorkflowAgent,
  createWorkflowAgent,
  getAllWorkflowConfigs,
  getWorkflowByCommand,
  isWorkflowCommand,
  WORKFLOW_CONFIGS,
} from "./workflowAgents";
export type { WorkflowAgentType, WorkflowAgentConfig } from "./workflowAgents";

// Chief of Staff (main entry point)
export { ChiefOfStaff } from "./chiefOfStaff";
export type { ChiefOfStaffTask } from "./chiefOfStaff";

// Model selection
export {
  ModelSelector,
  createModelSelector,
  getDefaultOptions,
  MODEL_PROFILES,
} from "./modelSelector";
export type { ModelProfile } from "./modelSelector";
