/**
 * Multi-Agent System Exports
 *
 * 4-Agent Swarm Architecture:
 * - User = President (decision maker)
 * - Orchestrator = Brain (reasoning, planning, delegation)
 * - NoteEditor = Obsidian I/O specialist
 * - ContextBuilder = Vault awareness specialist
 * - Worker = Unified workflow executor
 *
 * Two-Tier Identity System:
 * - Tier 1: Core Notient Identity (Research Chief of Staff + user profile)
 * - Tier 2: Agent Specialization (role + mission + output format)
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

// Specialized agents (4-Agent Swarm)
export { NoteEditorAgent } from "./noteEditorAgent";
export { ContextBuilderAgent } from "./contextBuilderAgent";

// Worker Agent (Phase 2 Swarm) - Unified workflow executor
// Includes all workflow configurations (consolidated from workflowAgents.ts)
export {
  WorkerAgent,
  createWorkerAgent,
  isValidWorkflowType,
  getAllWorkflowConfigs,
  getWorkflowByCommand,
  isWorkflowCommand,
  WORKFLOW_CONFIGS,
} from "./workerAgent";
export type { WorkflowType, WorkflowAgentType, WorkflowAgentConfig } from "./workerAgent";

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
