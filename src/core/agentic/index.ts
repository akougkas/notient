/**
 * Agentic Module
 *
 * Phase 2: Trust levels, bulk operations, undo support.
 */

// Types
export * from "./types";

// Services
export { ActionHistory } from "./actionHistory";
export type { ActionRetentionConfig, UndoResult } from "./actionHistory";

export { ActionApplier } from "./actionApplier";
export type { ApplyResult } from "./actionApplier";

export { TrustLevelManager } from "./trustLevelManager";

// Command parsing (Milestone 2.4)
export {
  parseSlashCommand,
  isSlashCommand,
  getCommandSuggestions,
  getCommandDescription,
} from "./commandParser";
export type {
  SlashCommand,
  ParsedCommand,
  ParseError,
  ParseResult,
} from "./commandParser";

// Workflow runner (Milestone 2.4)
export { WorkflowRunner } from "./workflowRunner";
export type { WorkflowConfig, StartWorkflowResult } from "./workflowRunner";
