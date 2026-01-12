/**
 * Typed event definitions for the EventBus
 */

import type { AgentTask } from "../core/agent/types";
import type { AppliedActionRecord, ProposedAction, WorkflowRun } from "../core/agentic/types";
import type { IntelligenceRecord } from "../core/intelligence/types";
import type { IndexProgress } from "./indexer";
import type { SearchResult } from "./search";
import type { InitializationContext, InitializationState, ServiceHealth } from "./services";
import type { VaultVitalsData } from "./vitals";

/** All event types supported by the EventBus */
export type EventType =
  | "health:changed"
  | "init:state-changed"
  | "services:initialized"
  | "services:failed"
  | "index:progress"
  | "index:complete"
  | "index:error"
  | "search:started"
  | "search:progress"
  | "search:complete"
  | "search:error"
  | "vitals:updated"
  | "intelligence:updated"
  | "settings:changed"
  | "agent:task-update"
  // Phase 2: Workflow events
  | "workflow:started"
  | "workflow:progress"
  | "workflow:completed"
  | "workflow:cancelled"
  | "workflow:failed"
  | "workflow:reviewDismissed"
  // Phase 2: Action events
  | "action:proposed"
  | "action:applied"
  | "action:undone"
  | "action:apply-requested"
  | "action:undo-requested"
  // Identity system events
  | "profile:updated"
  // Lock management events
  | "lock:lost"
  // Migration events
  | "migration:started"
  | "migration:progress"
  | "migration:completed"
  | "migration:failed"
  // Progressive search events
  | "search:progressive-instant"
  | "search:progressive-evolving"
  | "search:deep-started"
  | "search:deep-complete"
  | "search:deep-cancelled";

/** Event payload mapping */
export interface EventPayloads {
  "health:changed": HealthChangedEvent;
  "init:state-changed": InitStateChangedEvent;
  "services:initialized": ServicesInitializedEvent;
  "services:failed": ServicesFailedEvent;
  "index:progress": IndexProgressEvent;
  "index:complete": IndexCompleteEvent;
  "index:error": IndexErrorEvent;
  "search:started": SearchStartedEvent;
  "search:progress": SearchProgressEvent;
  "search:complete": SearchCompleteEvent;
  "search:error": SearchErrorEvent;
  "vitals:updated": VitalsUpdatedEvent;
  "intelligence:updated": IntelligenceUpdatedEvent;
  "settings:changed": SettingsChangedEvent;
  "agent:task-update": AgentTaskUpdateEvent;
  // Phase 2: Workflow events
  "workflow:started": WorkflowStartedEvent;
  "workflow:progress": WorkflowProgressEvent;
  "workflow:completed": WorkflowCompletedEvent;
  "workflow:cancelled": WorkflowCancelledEvent;
  "workflow:failed": WorkflowFailedEvent;
  "workflow:reviewDismissed": WorkflowReviewDismissedEvent;
  // Phase 2: Action events
  "action:proposed": ActionProposedEvent;
  "action:applied": ActionAppliedEvent;
  "action:undone": ActionUndoneEvent;
  "action:apply-requested": ActionApplyRequestedEvent;
  "action:undo-requested": ActionUndoRequestedEvent;
  // Identity system events
  "profile:updated": ProfileUpdatedEvent;
  // Lock management events
  "lock:lost": LockLostEvent;
  // Migration events
  "migration:started": MigrationStartedEvent;
  "migration:progress": MigrationProgressEvent;
  "migration:completed": MigrationCompletedEvent;
  "migration:failed": MigrationFailedEvent;
  // Progressive search events
  "search:progressive-instant": ProgressiveInstantEvent;
  "search:progressive-evolving": ProgressiveEvolvingEvent;
  "search:deep-started": DeepSearchStartedEvent;
  "search:deep-complete": DeepSearchCompleteEvent;
  "search:deep-cancelled": DeepSearchCancelledEvent;
}

export interface AgentTaskUpdateEvent {
  task: AgentTask;
}

export interface HealthChangedEvent {
  service: "ollama" | "lmstudio";
  health: ServiceHealth;
}

export interface InitStateChangedEvent {
  previousState: InitializationState;
  currentState: InitializationState;
  context: InitializationContext;
}

export type ServicesInitializedEvent = Record<string, never>;

export interface ServicesFailedEvent {
  reason: "missing_config" | "connection_failed" | "unknown";
}

export interface IndexProgressEvent {
  progress: IndexProgress;
}

export interface IndexCompleteEvent {
  totalIndexed: number;
  durationMs: number;
}

export interface IndexErrorEvent {
  /** Path of the file that caused the error (optional for system-level errors) */
  path?: string;
  /** Error message */
  error: string;
  /** Source of the error (e.g., "save", "beginIndexing", "vectorStore") */
  source?: string;
}

export interface SearchStartedEvent {
  query: string;
}

/** Search progress stages */
export type SearchStage =
  | "native"
  | "embedding"
  | "vector-search"
  | "reranking"
  | "expanding"
  | "graph"
  | "aggregating";

export interface SearchProgressEvent {
  query: string;
  stage: SearchStage;
  /** Optional detail about the current stage */
  detail?: string;
}

export interface SearchCompleteEvent {
  query: string;
  results: SearchResult[];
  durationMs: number;
  cached: boolean;
  /** Whether LLM reranking was applied */
  reranked?: boolean;
  /** Which search strategy was used */
  strategy?: "quick" | "balanced" | "thorough";
}

export interface SearchErrorEvent {
  query: string;
  error: string;
  /** Operation that failed: "search" or "findRelated" */
  operation: "search" | "findRelated";
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

export interface ActionProposedEvent {
  /** The proposed action awaiting user review */
  action: ProposedAction;
  /** Context about the target note */
  noteContext: {
    path: string;
    title: string;
  };
  /** Source of the proposal (workflow, agent, etc.) */
  source?: string;
}

export interface ActionAppliedEvent {
  record: AppliedActionRecord;
}

export interface ActionUndoneEvent {
  recordId: string;
}

export interface ActionApplyRequestedEvent {
  /** ID of the action to apply */
  actionId: string;
  /** The action to apply (included to avoid need for central lookup) */
  action?: ProposedAction;
}

export interface ActionUndoRequestedEvent {
  /** ID of the action record to undo */
  actionId: string;
}

// =============================================================================
// Identity System Events
// =============================================================================

export interface ProfileUpdatedEvent {
  /** The updated profile (undefined if profile was reset/cleared) */
  profile: import("./profile").UserProfile | undefined;
}

// =============================================================================
// Lock Management Events
// =============================================================================

export interface LockLostEvent {
  /** Reason for lock loss */
  reason: "refresh_failed" | "stale_detected" | "manual_release";
  /** Original error message if applicable */
  error?: string;
}

// =============================================================================
// Migration Events
// =============================================================================

export interface MigrationStartedEvent {
  migration: import("../core/importer/migrationService").MigrationStatus;
}

export interface MigrationProgressEvent {
  migration: import("../core/importer/migrationService").MigrationStatus;
  phase: "importing" | "indexing" | "analyzing";
}

export interface MigrationCompletedEvent {
  migration: import("../core/importer/migrationService").MigrationStatus;
}

export interface MigrationFailedEvent {
  migration: import("../core/importer/migrationService").MigrationStatus;
  error: string;
}

// =============================================================================
// Progressive Search Events
// =============================================================================

export interface ProgressiveInstantEvent {
  query: string;
  results: SearchResult[];
}

export interface ProgressiveEvolvingEvent {
  query: string;
  results: SearchResult[];
  reordered: boolean;
}

export interface DeepSearchStartedEvent {
  searchId: string;
  query: string;
}

export interface DeepSearchCompleteEvent {
  searchId: string;
  query: string;
  results: SearchResult[];
  durationMs: number;
}

export interface DeepSearchCancelledEvent {
  searchId: string;
}

/** Event listener function type */
export type EventListener<T extends EventType> = (payload: EventPayloads[T]) => void;

/** Unsubscribe function returned by subscribe */
export type Unsubscribe = () => void;
