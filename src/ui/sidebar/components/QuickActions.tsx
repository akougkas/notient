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
  /** Send to conversational chat (for contextual actions that need chat) */
  sendToChat: (prompt: string) => void;
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
  /** Action type: agent or chat */
  type: "agent" | "chat";
  /** Agent type (if type is "agent") */
  agentType?: "note-editor" | "classifier" | "connection";
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
    type: "agent",
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
    type: "agent",
    agentType: "note-editor",
    buildPrompt: (title) => `Expand "${title}" with more detail, context, and examples`,
  },
  {
    id: "extract-tasks",
    icon: "check-square",
    label: "Tasks",
    description: "Extract action items",
    priority: 3,
    condition: (state) => state.hasCheckboxes,
    type: "chat",
    buildPrompt: (title) => `Extract any actionable items or tasks mentioned in "${title}"`,
  },
  {
    id: "summarize",
    icon: "file-text",
    label: "Summary",
    description: "Generate summary",
    priority: 10,
    condition: () => true, // Always available as fallback
    type: "chat",
    buildPrompt: (title) => `Create a concise summary of "${title}" that captures the key points`,
  },
  {
    id: "link-ideas",
    icon: "git-branch",
    label: "Link",
    description: "Suggest links to add",
    priority: 11,
    condition: () => true, // Always available as fallback
    type: "agent",
    agentType: "connection",
    buildPrompt: (title) =>
      `Suggest internal wiki-links to add to "${title}" that connect it to related notes`,
  },
  {
    id: "brainstorm",
    icon: "lightbulb",
    label: "Ideas",
    description: "Brainstorm related ideas",
    priority: 12,
    condition: () => true, // Always available as fallback
    type: "chat",
    buildPrompt: (title) => `Brainstorm ideas and questions related to "${title}"`,
  },
];

/**
 * Select up to 3 contextual actions based on note state.
 * Prioritizes condition-matching actions, then fills with fallbacks.
 */
function getContextualActions(noteState?: NoteState): ContextualActionDef[] {
  const state = noteState ?? { wordCount: 500, linkCount: 2, hasCheckboxes: false };

  // Sort by condition match (matching first) then by priority
  const sorted = [...CONTEXTUAL_ACTIONS].sort((a, b) => {
    const aMatches = a.condition(state) && a.priority < 10;
    const bMatches = b.condition(state) && b.priority < 10;

    if (aMatches && !bMatches) return -1;
    if (!aMatches && bMatches) return 1;
    return a.priority - b.priority;
  });

  return sorted.slice(0, 3);
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create quick actions for a note.
 * Returns 6 actions: 3 pinned (always visible) + 3 contextual (smart-filtered).
 */
export function createNoteQuickActions(
  noteTitle: string,
  callbacks: QuickActionCallbacks,
  noteState?: NoteState,
): QuickAction[] {
  const { triggerAgent, sendToChat } = callbacks;

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

  // Build contextual actions (next 3)
  const contextual = getContextualActions(noteState);
  const contextualActions: QuickAction[] = contextual.map((action) => ({
    id: action.id,
    icon: action.icon,
    label: action.label,
    primary: false,
    description: action.description,
    onClick: () => {
      const prompt = action.buildPrompt(noteTitle);
      if (action.type === "agent" && action.agentType) {
        triggerAgent(prompt, action.agentType);
      } else {
        sendToChat(prompt);
      }
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
  }, [action.onClick]);

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
