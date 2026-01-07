/**
 * Agent Type Definitions
 *
 * Core types for the Notient agent system.
 */

import type { ProposedAction } from "../agentic/types";
import type { ChatMessage } from "../llm/types";

/**
 * Types of tasks the agent can perform
 */
export type TaskType = "enrich" | "link" | "classify" | "analyze" | "chat";

/**
 * Execution status of a task
 */
export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/**
 * Types of agents in the system
 */
export type AgentType = "search" | "context" | "chat";

/**
 * Context about the current note being processed
 */
export interface NoteContext {
  title: string;
  path: string;
  content: string;
}

/**
 * A task for the agent to execute
 */
export interface AgentTask {
  id: string;
  agent: AgentType;
  taskType?: TaskType;
  notePath: string;
  noteTitle: string;
  status: TaskStatus;
  /** Progress percentage (0-100) */
  progress?: number;
  startedAt: Date;
  completedAt?: Date;
  result?: TaskResult;
  error?: string;
  /** Per-task conversation history */
  chatHistory: ChatMessage[];
}

/**
 * Result of a completed task
 */
export interface TaskResult {
  type: "enrichment" | "links" | "classification" | "chat" | "action_plan";
  data: unknown;
  /** Note paths used as RAG context */
  citations: string[];
  /** Proposed actions from LLM (when type is "action_plan") */
  actions?: ProposedAction[];
}

/**
 * Events emitted during streaming execution
 */
export type AgentStreamEvent =
  | { type: "progress"; progress: number }
  | { type: "chunk"; content: string }
  | { type: "citations"; paths: string[] }
  | { type: "actions"; actions: ProposedAction[] }
  | { type: "complete"; result: TaskResult }
  | { type: "error"; error: Error };

/**
 * Parameters for building agent prompts
 */
export interface PromptParams {
  currentNote?: NoteContext;
  relatedNotes: Array<{ title: string; path: string; text: string }>;
  contextSummary: string;
  taskType?: TaskType;
  query?: string;
}
