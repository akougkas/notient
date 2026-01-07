/**
 * Typed event definitions for the EventBus
 */

import type { AppliedActionRecord, WorkflowRun } from "../core/agentic/types";
import type { IntelligenceRecord } from "../core/intelligence/types";
import type { AgentTask } from "./agentTask";
import type { IndexProgress } from "./indexer";
import type { SearchResult } from "./search";
import type { ServiceHealth } from "./services";
import type { VaultVitalsData } from "./vitals";

/** All event types supported by the EventBus */
export type EventType =
  | "health:changed"
  | "services:initialized"
  | "index:progress"
  | "index:complete"
  | "index:error"
  | "search:started"
  | "search:complete"
  | "vitals:updated"
  | "intelligence:updated"
  | "settings:changed"
  | "note:context-changed"
  | "agent:task-update"
  // Phase 2: Workflow events
  | "workflow:started"
  | "workflow:progress"
  | "workflow:completed"
  | "workflow:cancelled"
  | "workflow:failed"
  | "workflow:reviewDismissed"
  // Phase 2: Action events
  | "action:applied"
  | "action:undone";

/** Event payload mapping */
export interface EventPayloads {
  "health:changed": HealthChangedEvent;
  "services:initialized": ServicesInitializedEvent;
  "index:progress": IndexProgressEvent;
  "index:complete": IndexCompleteEvent;
  "index:error": IndexErrorEvent;
  "search:started": SearchStartedEvent;
  "search:complete": SearchCompleteEvent;
  "vitals:updated": VitalsUpdatedEvent;
  "intelligence:updated": IntelligenceUpdatedEvent;
  "settings:changed": SettingsChangedEvent;
  "note:context-changed": NoteContextChangedEvent;
  "agent:task-update": AgentTaskUpdateEvent;
  // Phase 2: Workflow events
  "workflow:started": WorkflowStartedEvent;
  "workflow:progress": WorkflowProgressEvent;
  "workflow:completed": WorkflowCompletedEvent;
  "workflow:cancelled": WorkflowCancelledEvent;
  "workflow:failed": WorkflowFailedEvent;
  "workflow:reviewDismissed": WorkflowReviewDismissedEvent;
  // Phase 2: Action events
  "action:applied": ActionAppliedEvent;
  "action:undone": ActionUndoneEvent;
}

export interface AgentTaskUpdateEvent {
  task: AgentTask;
}

export interface HealthChangedEvent {
  service: "ollama" | "lmstudio";
  health: ServiceHealth;
}

export type ServicesInitializedEvent = Record<string, never>;

export interface IndexProgressEvent {
  progress: IndexProgress;
}

export interface IndexCompleteEvent {
  totalIndexed: number;
  durationMs: number;
}

export interface IndexErrorEvent {
  path: string;
  error: string;
}

export interface SearchStartedEvent {
  query: string;
}

export interface SearchCompleteEvent {
  query: string;
  results: SearchResult[];
  durationMs: number;
  cached: boolean;
  /** Whether LLM reranking was applied */
  reranked?: boolean;
}

export interface VitalsUpdatedEvent {
  vitals: VaultVitalsData;
}

export interface IntelligenceUpdatedEvent {
  path: string;
  record: IntelligenceRecord;
}

export interface SettingsChangedEvent {
  changedFields: string[];
}

export interface NoteContextChangedEvent {
  path: string | null;
}

// =============================================================================
// Phase 2: Workflow Events
// =============================================================================

export interface WorkflowStartedEvent {
  workflow: WorkflowRun;
}

export interface WorkflowProgressEvent {
  workflow: WorkflowRun;
}

export interface WorkflowCompletedEvent {
  workflow: WorkflowRun;
}

export interface WorkflowCancelledEvent {
  workflow: WorkflowRun;
}

export interface WorkflowFailedEvent {
  workflow: WorkflowRun;
  error: string;
}

export interface WorkflowReviewDismissedEvent {
  workflowId: string;
  actionId: string;
}

// =============================================================================
// Phase 2: Action Events
// =============================================================================

export interface ActionAppliedEvent {
  record: AppliedActionRecord;
}

export interface ActionUndoneEvent {
  recordId: string;
}

/** Event listener function type */
export type EventListener<T extends EventType> = (payload: EventPayloads[T]) => void;

/** Unsubscribe function returned by subscribe */
export type Unsubscribe = () => void;
