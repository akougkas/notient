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
  // Phase 2 (Existing)
  | "frontmatter_set"
  | "frontmatter_add_tags"
  | "append_section"
  | "append_related_links"
  | "move_note"
  // Intelligence 2.0 (NEW)
  | "create_note"
  | "batch_create_notes"
  | "restructure_note"
  | "create_task_note"
  | "extract_to_calendar"
  | "append_review_section"
  | "highlight_text_issues"
  | "batch_append_links"
  | "create_synthesis_note"
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

// =============================================================================
// Intelligence 2.0 Action Types (NEW)
// =============================================================================

/**
 * Create a new note with content
 */
export interface CreateNoteAction extends ProposedActionBase {
  type: "create_note";
  payload: {
    /** Path where note should be created */
    path: string;
    /** Note content (markdown) */
    content: string;
    /** Frontmatter to include */
    frontmatter?: Record<string, unknown>;
  };
}

/**
 * Create multiple notes in batch (atomic split, clipping)
 */
export interface BatchCreateNotesAction extends ProposedActionBase {
  type: "batch_create_notes";
  payload: {
    /** Notes to create */
    notes: Array<{
      path: string;
      content: string;
      frontmatter?: Record<string, unknown>;
    }>;
    /** Whether to create bidirectional links between notes */
    createBidirectionalLinks: boolean;
  };
}

/**
 * Restructure existing note (keep overview, extract sections)
 */
export interface RestructureNoteAction extends ProposedActionBase {
  type: "restructure_note";
  payload: {
    /** New content structure */
    content: string;
    /** Sections that were extracted (for linking) */
    extractedSections: Array<{
      heading: string;
      newNotePath: string;
    }>;
  };
}

/**
 * Create a task note with deadline tracking
 */
export interface CreateTaskNoteAction extends ProposedActionBase {
  type: "create_task_note";
  payload: {
    /** Path for task note */
    path: string;
    /** Structured task list */
    tasks: Array<{
      text: string;
      category: "immediate" | "planned" | "backlog" | "blocked";
      deadline?: string; // YYYY-MM-DD
      project?: string;
    }>;
    /** Decisions extracted */
    decisions?: Array<{
      decision: string;
      rationale: string;
      date?: string;
    }>;
  };
}

/**
 * Extract deadline to calendar integration
 */
export interface ExtractToCalendarAction extends ProposedActionBase {
  type: "extract_to_calendar";
  payload: {
    /** Task description */
    task: string;
    /** Deadline in YYYY-MM-DD format */
    deadline: string;
    /** Project context */
    project?: string;
  };
}

/**
 * Append review results (brand check, quality check)
 */
export interface AppendReviewSectionAction extends ProposedActionBase {
  type: "append_review_section";
  payload: {
    /** Review type */
    reviewType: "brand" | "quality" | "technical" | "antagonist";
    /** Score (0-10) */
    score: number;
    /** Structured findings */
    findings: {
      strengths: string[];
      concerns: string[];
      suggestions: string[];
    };
    /** Review date */
    date: string;
  };
}

/**
 * Highlight specific text issues (inline annotations)
 */
export interface HighlightTextIssuesAction extends ProposedActionBase {
  type: "highlight_text_issues";
  payload: {
    /** Issues to highlight */
    issues: Array<{
      /** Line number or text snippet to find */
      location: string;
      /** Issue type */
      type: "accuracy" | "tone" | "clarity" | "evidence";
      /** Description of issue */
      issue: string;
      /** Suggested fix */
      suggestion: string;
    }>;
  };
}

/**
 * Batch append links to multiple notes (bidirectional)
 */
export interface BatchAppendLinksAction extends ProposedActionBase {
  type: "batch_append_links";
  payload: {
    /** Links to add */
    linkPairs: Array<{
      fromNote: string;
      toNote: string;
      context: string; // Why these should be linked
    }>;
  };
}

/**
 * Create synthesis note from related concepts
 */
export interface CreateSynthesisNoteAction extends ProposedActionBase {
  type: "create_synthesis_note";
  payload: {
    /** Path for synthesis note */
    path: string;
    /** Note content */
    content: string;
    /** Frontmatter */
    frontmatter?: Record<string, unknown>;
    /** Source notes used for synthesis */
    sourceNotes?: string[];
  };
}

/**
 * Union of all proposed action types
 */
export type ProposedAction =
  // Phase 2 (Existing)
  | FrontmatterSetAction
  | FrontmatterAddTagsAction
  | AppendSectionAction
  | AppendRelatedLinksAction
  | MoveNoteAction
  | MergeNotesAction
  | TrashNoteAction
  // Intelligence 2.0 (NEW)
  | CreateNoteAction
  | BatchCreateNotesAction
  | RestructureNoteAction
  | CreateTaskNoteAction
  | ExtractToCalendarAction
  | AppendReviewSectionAction
  | HighlightTextIssuesAction
  | BatchAppendLinksAction
  | CreateSynthesisNoteAction;

// =============================================================================
// Action Results / Undo Records
// =============================================================================

/**
 * Type of undo payload
 */
export type UndoPayloadType = "restore_content" | "rename_back" | "diff";

/**
 * Undo payload for content restoration (legacy, still supported for migration)
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
 * Diff-based undo payload (smaller than full content)
 */
export interface DiffUndoPayload {
  type: "diff";
  /** Patches to apply to restore original content (reversed diff format) */
  patches: Array<{
    path: string;
    diff: string;
  }>;
}

/**
 * Union of all undo payload types
 */
export type UndoPayload = RestoreContentUndo | RenameBackUndo | DiffUndoPayload;

/**
 * Status of an applied action
 */
export type AppliedActionStatus = "pending" | "applied" | "undone" | "failed";

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
  /** Why the agent made this decision */
  reasoning: string;
  /** Paths that were changed */
  changedPaths: string[];
  /** Data needed to undo this action */
  undo: UndoPayload;
  /** Current status of the action */
  status: AppliedActionStatus;
}

// =============================================================================
// Action Storage Structures
// =============================================================================

/** Hot actions file structure (recent 200 actions) */
export interface HotActionsFile {
  version: number;
  records: AppliedActionRecord[];
  oldestTimestamp: number;
  newestTimestamp: number;
}

/** Monthly archive file structure */
export interface ActionsArchiveFile {
  version: number;
  yearMonth: string;
  records: AppliedActionRecord[];
  recordCount: number;
  archivedAt: number;
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
  /** IDs of actions that have been approved and applied */
  appliedActionIds: string[];
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
  // Phase 2 (Existing)
  frontmatter_set: "low",
  frontmatter_add_tags: "low",
  append_section: "low",
  append_related_links: "medium",
  move_note: "medium",
  merge_notes: "high",
  trash_note: "high",
  // Intelligence 2.0 (NEW)
  create_note: "low",
  batch_create_notes: "medium",
  restructure_note: "medium",
  create_task_note: "low",
  extract_to_calendar: "low",
  append_review_section: "low",
  highlight_text_issues: "low",
  batch_append_links: "medium",
  create_synthesis_note: "low",
};

// =============================================================================
// Validation Constants
// =============================================================================

/** Action types that are currently supported (Phase 2) */
export const SUPPORTED_ACTION_TYPES: ProposedActionType[] = [
  "frontmatter_set",
  "frontmatter_add_tags",
  "append_section",
  "append_related_links",
  "move_note",
];

/** Intelligence 2.0 action types */
export const INTELLIGENCE_2_ACTION_TYPES: ProposedActionType[] = [
  "create_note",
  "batch_create_notes",
  "restructure_note",
  "create_task_note",
  "extract_to_calendar",
  "append_review_section",
  "highlight_text_issues",
  "batch_append_links",
  "create_synthesis_note",
];

/** Action types reserved for Phase 3 */
export const RESERVED_ACTION_TYPES: ProposedActionType[] = ["merge_notes", "trash_note"];

// =============================================================================
// Insight Container (Agent Output Grouping)
// =============================================================================

/**
 * A suggestion from an agent (not yet applied)
 * ID format: sug_{uuid8}
 */
export interface Suggestion {
  /** Unique identifier (sug_{uuid8}) */
  id: string;
  /** The suggestion content */
  content: string;
  /** Related notes that informed this suggestion */
  relatedNotes?: string[];
  /** Confidence score (0-1) */
  confidence: number;
}

/**
 * Insight container - groups agent outputs with reasoning
 * ID format: ins_{uuid8}
 *
 * This is the primary output container for all agent executions.
 * It bundles actions, suggestions, and reasoning together for:
 * - User-facing display (InsightStream summary)
 * - Pending actions review
 * - Provenance tracking (developer debugging)
 */
export interface Insight {
  /** Unique identifier (ins_{uuid8}) */
  id: string;
  /** When the insight was created */
  timestamp: number;
  /** Which agent produced this insight */
  agentType: string;
  /** Context about the target note */
  noteContext: {
    path: string;
    title: string;
  };
  /** Agent's reasoning for its decisions */
  reasoning: string;
  /** Proposed actions (each has act_{uuid8} ID) */
  actions: ProposedAction[];
  /** Suggestions (not applied, each has sug_{uuid8} ID) */
  suggestions: Suggestion[];
  /** One-liner summary for InsightStream UI */
  summary: string;
}
