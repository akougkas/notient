/**
 * Agent Task Types (Legacy)
 *
 * @deprecated Use core/agent/types.ts for new code.
 * This file re-exports from the new location for backward compatibility.
 */

export type {
  AgentType,
  TaskStatus,
  AgentTask,
  TaskResult,
} from "../core/agent/types";

// Also re-export ChatMessage for files that import it from here
export type { ChatMessage } from "../core/llm/types";
