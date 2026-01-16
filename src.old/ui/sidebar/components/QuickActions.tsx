/**
 * QuickActions - Quick action buttons (Section 3 of Note Vitals)
 *
 * Per spec: 3 pinned + 3 contextual actions (6 total)
 * Pinned: Always visible (Enhance, Classify, Connect)
 * Contextual: Smart-filtered based on note state
 */

import { useCallback } from "preact/hooks";
import { debugLog } from "../../../utils/debugLog";
import { Icon } from "./Icon";

// =============================================================================
// Types
// =============================================================================

export interface QuickAction {
  id: string;
  icon: string;
  label: string;
  primary: boolean;
  description?: string;
  onClick: () => void;
}

interface QuickActionsProps {
  actions: QuickAction[];
}

/**
 * Note state for contextual action filtering.
 */
export interface NoteState {
  wordCount: number;
  linkCount: number;
  hasCheckboxes: boolean;
}

/**
 * Callbacks for Quick Actions.
 * All actions route through Agent Streams via ChiefOfStaff.
 */
export interface QuickActionCallbacks {
  /** Trigger expert agent (shows in Agent Streams) */
  triggerAgent: (prompt: string, agentType: "note-editor" | "classifier" | "connection") => void;
}

// =============================================================================
// Pinned Actions (Always visible)
// =============================================================================

/**
 * Pinned actions definition (static config, no callbacks).
 * These 3 actions are always visible in the Quick Actions bar.
 */
const PINNED_ACTIONS = [
  { id: "enhance", icon: "sparkles", label: "Enhance", agentType: "note-editor" as const },
  { id: "classify", icon: "tag", label: "Classify", agentType: "classifier" as const },
  { id: "connect", icon: "link", label: "Connect", agentType: "connection" as const },
] as const;

// =============================================================================
// Contextual Actions (Smart-filtered)
// =============================================================================

/**
 * Available contextual actions pool.
 * getContextualActions() selects 3 based on note state.
 * All actions are agent-type only (no chat actions).
 */
interface ContextualActionDef {
  id: string;
  icon: string;
  label: string;
  description: string;
  /** Priority when condition matches (lower = higher priority) */
  priority: number;
  /** Condition to check if this action is relevant */
  condition: (state: NoteState) => boolean;
  /** Agent type to invoke */
  agentType: "note-editor" | "classifier" | "connection";
  /** Prompt builder */
  buildPrompt: (noteTitle: string) => string;
}

const CONTEXTUAL_ACTIONS: ContextualActionDef[] = [
  {
    id: "find-related",
    icon: "search",
    label: "Related",
    description: "Find related notes",
    priority: 1,
    condition: (state) => state.linkCount === 0,
    agentType: "connection",
    buildPrompt: (title) => `Find notes semantically related to "${title}" and explain connections`,
  },
  {
    id: "expand",
    icon: "expand",
    label: "Expand",
    description: "Expand short note",
    priority: 2,
    condition: (state) => state.wordCount < 200,
    agentType: "note-editor",
    buildPrompt: (title) => `Expand "${title}" with more detail, context, and examples`,
  },
  {
    id: "suggest-tags",
    icon: "tags",
    label: "Tags",
    description: "Suggest relevant tags",
    priority: 3,
    condition: (state) => state.linkCount > 0,
    agentType: "classifier",
    buildPrompt: (title) =>
      `Analyze "${title}" and suggest relevant tags based on content and context`,
  },
  {
    id: "link-suggestions",
    icon: "git-branch",
    label: "Link",
    description: "Suggest links to add",
    priority: 10,
    condition: () => true, // Fallback
    agentType: "connection",
    buildPrompt: (title) =>
      `Suggest internal wiki-links to add to "${title}" that connect it to related notes`,
  },
  {
    id: "structure",
    icon: "list",
    label: "Structure",
    description: "Improve note structure",
    priority: 11,
    condition: () => true, // Fallback
    agentType: "note-editor",
    buildPrompt: (title) =>
      `Analyze the structure of "${title}" and suggest improvements to headings, sections, and organization`,
  },
  {
    id: "categorize",
    icon: "folder",
    label: "Categorize",
    description: "Suggest folder placement",
    priority: 12,
    condition: () => true, // Fallback
    agentType: "classifier",
    buildPrompt: (title) => `Suggest the best folder location for "${title}" based on its content`,
  },
];

/**
 * Select up to 3 contextual actions based on note state.
 * Prioritizes condition-matching actions, then fills with fallbacks.
 */
function getContextualActions(noteState?: NoteState): ContextualActionDef[] {
  const state = noteState ?? { wordCount: 500, linkCount: 2, hasCheckboxes: false };

  // Separate into matching conditionals and fallbacks
  const matching: ContextualActionDef[] = [];
  const fallbacks: ContextualActionDef[] = [];

  for (const action of CONTEXTUAL_ACTIONS) {
    if (action.priority < 10 && action.condition(state)) {
      // Conditional action whose condition matches
      matching.push(action);
    } else if (action.priority >= 10) {
      // Fallback action (always available)
      fallbacks.push(action);
    }
    // Skip conditional actions whose conditions don't match
  }

  // Sort each group by priority, then combine
  matching.sort((a, b) => a.priority - b.priority);
  fallbacks.sort((a, b) => a.priority - b.priority);

  return [...matching, ...fallbacks].slice(0, 3);
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create quick actions for a note.
 * Returns 6 actions: 3 pinned (always visible) + 3 contextual (smart-filtered).
 * All actions route to expert agents only - no chat path.
 */
export function createNoteQuickActions(
  noteTitle: string,
  callbacks: QuickActionCallbacks,
  noteState?: NoteState,
): QuickAction[] {
  const { triggerAgent } = callbacks;

  // Build pinned actions (always first 3)
  const pinnedActions: QuickAction[] = PINNED_ACTIONS.map((action) => ({
    id: action.id,
    icon: action.icon,
    label: action.label,
    primary: true,
    description: `${action.label} (${action.agentType})`,
    onClick: () => {
      const prompts: Record<string, string> = {
        enhance: `Enhance and expand "${noteTitle}" with additional context, examples, and insights`,
        classify: `Classify and suggest relevant tags for "${noteTitle}" based on its content`,
        connect: `Find notes semantically related to "${noteTitle}" and suggest internal links`,
      };
      triggerAgent(prompts[action.id], action.agentType);
    },
  }));

  // Build contextual actions (next 3) - all agent-type
  const contextual = getContextualActions(noteState);
  const contextualActions: QuickAction[] = contextual.map((action) => ({
    id: action.id,
    icon: action.icon,
    label: action.label,
    primary: false,
    description: action.description,
    onClick: () => {
      triggerAgent(action.buildPrompt(noteTitle), action.agentType);
    },
  }));

  return [...pinnedActions, ...contextualActions];
}

// =============================================================================
// Component
// =============================================================================

export function QuickActions({ actions }: QuickActionsProps) {
  return (
    <section class="nv2-quick-actions-section" aria-label="Quick actions">
      <h3 class="nv2-section-label">Quick Actions</h3>
      {/* biome-ignore lint/a11y/useSemanticElements: role="toolbar" is correct ARIA pattern for action groups */}
      <div class="nv2-quick-actions" role="toolbar" aria-label="Note actions">
        {actions.map((action) => (
          <ActionButton key={action.id} action={action} />
        ))}
      </div>
    </section>
  );
}

interface ActionButtonProps {
  action: QuickAction;
}

function ActionButton({ action }: ActionButtonProps) {
  const handleClick = useCallback(() => {
    debugLog("QuickActions", `${action.id} clicked`);
    action.onClick();
  }, [action.id, action.onClick]);

  return (
    <button
      type="button"
      class={`nv2-quick-action ${action.primary ? "nv2-quick-action--primary" : ""}`}
      onClick={handleClick}
      title={action.description || action.label}
      aria-label={action.description || action.label}
    >
      <Icon name={action.icon} className="nv2-quick-action-icon" />
      <span class="nv2-quick-action-label">{action.label}</span>
    </button>
  );
}
