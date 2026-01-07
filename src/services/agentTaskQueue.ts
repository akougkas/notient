/**
 * Agent Task Queue (Legacy)
 *
 * @deprecated Use core/agent/taskQueue.ts for new code.
 * This file re-exports from the new location for backward compatibility.
 */

// Re-export everything from the new location
export { AgentTaskQueue } from "../core/agent/taskQueue";
export type { AgentTask, TaskStatus, AgentType, TaskResult } from "../core/agent/types";
