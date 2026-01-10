/**
 * Agent Module Exports
 *
 * Clean public API for the Notient agent system.
 * 
 * Architecture Note:
 * ChiefOfStaff (from src/core/agents/) is the new multi-agent orchestrator
 * that replaces the legacy NotientAgent. We export it as NotientAgent for
 * backward compatibility with existing code (main.ts, kernel.ts).
 */

// Types from legacy system (still used by TaskQueue)
export type {
  TaskType,
  TaskStatus,
  NoteContext,
  AgentTask,
  TaskResult,
  AgentStreamEvent,
  PromptParams,
} from "./types";

// Re-export AgentType from new system (superset of legacy)
export type { AgentType } from "../agents/types";

// Core components
export { AgentTaskQueue } from "./taskQueue";

// NEW: ChiefOfStaff is the NotientAgent replacement
// Export as both names for clarity and backward compatibility
export { ChiefOfStaff, ChiefOfStaff as NotientAgent } from "../agents/chiefOfStaff";
export type { ChiefOfStaffTask } from "../agents/chiefOfStaff";

// Identity system (Tier 1 - used by all agents)
export { ProfileManager } from "./profileManager";
export {
  buildBaseIdentity,
  getTaskOverlay,
  buildSystemPromptWithIdentity,
} from "./identity";
