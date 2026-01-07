/**
 * Phase 2 Agentic Types
 *
 * Core type definitions for the agentic operations system:
 * - Trust levels and gating
 * - Proposed actions from LLM
 * - Action history and undo records
 * - Workflow primitives
 */

// =============================================================================
// Trust & Gating
// =============================================================================

/**
 * Risk level for proposed actions
 */
export type RiskLevel = "low" | "medium" | "high";

/**
 * User's trust policy configuration
 */
export interface TrustPolicy {
  /** Auto-apply low-risk actions without confirmation (default: false) */
  autoApplyLowRisk: boolean;
  /** Require confirmation for medium-risk actions (default: true, always true in Phase 2) */
  requireConfirmMediumRisk: boolean;
  /** Require explicit confirmation for high-risk actions (default: true, always true) */
  requireConfirmHighRisk: boolean;
}

/**
 * Result of evaluating whether an action is allowed
 */
export interface TrustDecision {
  /** Whether the action is allowed at all */
  allowed: boolean;
  /** Whether user confirmation is required before applying */
  requiresConfirmation: boolean;
  /** Whether extra danger confirmation is required (high-risk) */
  requiresDangerConfirm: boolean;
  /** Human-readable reason for the decision */
  reason?: string;
}

// =============================================================================
// Proposed Actions (LLM Output)
// =============================================================================

/**
 * Types of actions the LLM can propose
 */
export type ProposedActionType =
  | "frontmatter_set"
  | "frontmatter_add_tags"
  | "append_section"
  | "append_related_links"
  | "move_note"
  // Reserved for Phase 3 (schema stability):
  | "merge_notes"
  | "trash_note";

/**
 * Base interface for all proposed actions
 */
export interface ProposedActionBase {
  /** Unique identifier for this action */
  id: string;
  /** Type discriminator */
  type: ProposedActionType;
  /** Risk level of this action */
  risk: RiskLevel;
  /** Short description (max 50 chars) */
  title: string;
  /** Why this action helps */
  reason: string;
  /** Primary note path this action targets */
  target: string;
  /** Whether this action requires write lock */
  requiresWriteLock: boolean;
}

/**
 * Set a frontmatter field to a value
 */
export interface FrontmatterSetAction extends ProposedActionBase {
  type: "frontmatter_set";
  payload: {
    key: string;
    value: unknown;
  };
}

/**
 * Add tags to frontmatter
 */
export interface FrontmatterAddTagsAction extends ProposedActionBase {
  type: "frontmatter_add_tags";
  payload: {
    tags: string[];
  };
}

/**
 * Append a section to the note
 */
export interface AppendSectionAction extends ProposedActionBase {
  type: "append_section";
  payload: {
    /** Optional heading for the section */
    heading?: string;
    /** Markdown content to append */
    content: string;
  };
}

/**
 * Append a "## Related Notes" section with links
 */
export interface AppendRelatedLinksAction extends ProposedActionBase {
  type: "append_related_links";
  payload: {
    /** Note names to link (will be formatted as [[Name]]) */
    links: string[];
  };
}

/**
 * Move a note to a different location
 */
export interface MoveNoteAction extends ProposedActionBase {
  type: "move_note";
  payload: {
    /** Current path (will be overridden for safety) */
    from: string;
    /** Destination path */
    to: string;
  };
}

/**
 * Merge notes (Phase 3 - reserved)
 */
export interface MergeNotesAction extends ProposedActionBase {
  type: "merge_notes";
  payload: {
    /** Notes to merge into target */
    sources: string[];
  };
}

/**
 * Trash a note (Phase 3 - reserved)
 */
export interface TrashNoteAction extends ProposedActionBase {
  type: "trash_note";
  payload: {
    /** Whether to use system trash vs vault trash */
    useSystemTrash?: boolean;
  };
}

/**
 * Union of all proposed action types
 */
export type ProposedAction =
  | FrontmatterSetAction
  | FrontmatterAddTagsAction
  | AppendSectionAction
  | AppendRelatedLinksAction
  | MoveNoteAction
  | MergeNotesAction
  | TrashNoteAction;

// =============================================================================
// Action Results / Undo Records
// =============================================================================

/**
 * Type of undo payload
 */
export type UndoPayloadType = "restore_content" | "rename_back";

/**
 * Undo payload for content restoration
 */
export interface RestoreContentUndo {
  type: "restore_content";
  /** Files to restore with their previous content */
  files: Array<{
    path: string;
    before: string;
  }>;
}

/**
 * Undo payload for rename/move operations
 */
export interface RenameBackUndo {
  type: "rename_back";
  /** Current path (after the move) */
  from: string;
  /** Original path (restore to this) */
  to: string;
}

/**
 * Union of all undo payload types
 */
export type UndoPayload = RestoreContentUndo | RenameBackUndo;

/**
 * Record of an applied action for history/undo
 */
export interface AppliedActionRecord {
  /** Unique identifier */
  id: string;
  /** When the action was applied */
  timestamp: number;
  /** ID of the workflow this action belongs to (if any) */
  workflowId?: string;
  /** ID of the task that produced this action */
  taskId?: string;
  /** The action that was applied */
  action: ProposedAction;
  /** Paths that were changed */
  changedPaths: string[];
  /** Data needed to undo this action */
  undo: UndoPayload;
}

// =============================================================================
// Workflow Primitives
// =============================================================================

/**
 * Scope of a workflow operation
 */
export type WorkflowScope = "note" | "folder" | "vault";

/**
 * Specification for a workflow to execute
 */
export interface WorkflowSpec {
  /** Unique identifier */
  id: string;
  /** The command that triggered this workflow (e.g., "enrich") */
  command: string;
  /** Scope of the workflow */
  scope: WorkflowScope;
  /** Target note paths to process */
  targets: string[];
  /** When the workflow was created */
  createdAt: number;
  /** Delay between tasks in milliseconds (default: 500) */
  delayBetweenTasksMs: number;
}

/**
 * Status of a workflow run
 */
export type WorkflowStatus = "queued" | "running" | "completed" | "cancelled" | "failed";

/**
 * State of a running or completed workflow
 */
export interface WorkflowRun {
  /** Unique identifier */
  id: string;
  /** The workflow specification */
  spec: WorkflowSpec;
  /** Current status */
  status: WorkflowStatus;
  /** Progress tracking */
  progress: {
    total: number;
    completed: number;
    failed: number;
  };
  /** When the workflow started executing */
  startedAt?: number;
  /** When the workflow finished */
  completedAt?: number;
  /** Medium/high-risk actions awaiting review */
  reviewQueue: ProposedAction[];
  /** Errors that occurred during execution */
  errors: Array<{
    taskId: string;
    error: string;
  }>;
}

// =============================================================================
// LLM Response Schema
// =============================================================================

/**
 * Expected JSON output from action plan prompt
 */
export interface ActionPlanResponse {
  actions: Array<{
    type: ProposedActionType;
    risk: RiskLevel;
    title: string;
    reason: string;
    target: string;
    payload: Record<string, unknown>;
  }>;
}

// =============================================================================
// Risk Level Mapping
// =============================================================================

/**
 * Map of action types to their inherent risk levels
 * Used to override any incorrect risk declared by LLM
 */
export const ACTION_RISK_MAP: Record<ProposedActionType, RiskLevel> = {
  frontmatter_set: "low",
  frontmatter_add_tags: "low",
  append_section: "low",
  append_related_links: "medium",
  move_note: "medium",
  merge_notes: "high",
  trash_note: "high",
};

// =============================================================================
// Validation Constants
// =============================================================================

/** Maximum actions per LLM response */
export const MAX_ACTIONS_PER_RESPONSE = 10;

/** Action types that are currently supported (Phase 2) */
export const SUPPORTED_ACTION_TYPES: ProposedActionType[] = [
  "frontmatter_set",
  "frontmatter_add_tags",
  "append_section",
  "append_related_links",
  "move_note",
];

/** Action types reserved for Phase 3 */
export const RESERVED_ACTION_TYPES: ProposedActionType[] = ["merge_notes", "trash_note"];
