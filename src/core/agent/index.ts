/**
 * Agent Module Exports
 *
 * Clean public API for the Notient agent system.
 */

// Types
export type {
  TaskType,
  TaskStatus,
  AgentType,
  NoteContext,
  AgentTask,
  TaskResult,
  AgentStreamEvent,
  PromptParams,
} from "./types";

// Core components
export { NotientPromptBuilder } from "./promptBuilder";
export { NotientAgent } from "./agentLoop";
export { AgentTaskQueue } from "./taskQueue";

// Utilities
export { inferTaskType, getTaskInstructions } from "./taskInference";
