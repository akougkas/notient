/**
 * QuickActions - Quick action buttons (Section 3 of Note Vitals)
 *
 * Per spec: 6 smart-filtered actions based on note state
 * [🔍 Find Connections] [✨ Enrich Note] [🔗 Link Ideas]
 * [📝 Summarize] [🏷️ Suggest Tags] [📋 Extract Tasks]
 */

import { useCallback } from "preact/hooks";
import { Icon } from "./Icon";
import { debugLog } from "../../../utils/debugLog";

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

/**
 * Factory function to create quick actions for a note.
 * Temporary: Returns 6 actions using new agent types.
 * Task 2 will refactor to pinned + contextual structure.
 */
export function createNoteQuickActions(
  noteTitle: string,
  callbacks: QuickActionCallbacks,
): QuickAction[] {
  const { triggerAgent, sendToChat } = callbacks;

  return [
    {
      id: "enhance",
      icon: "sparkles",
      label: "Enhance",
      primary: true,
      description: "Enhance note content (Note Editor)",
      onClick: () =>
        triggerAgent(
          `Enhance and expand "${noteTitle}" with additional context, examples, and insights`,
          "note-editor",
        ),
    },
    {
      id: "classify",
      icon: "tag",
      label: "Classify",
      primary: true,
      description: "Classify and suggest tags (Classifier)",
      onClick: () =>
        triggerAgent(
          `Classify and suggest relevant tags for "${noteTitle}" based on its content`,
          "classifier",
        ),
    },
    {
      id: "connect",
      icon: "link",
      label: "Connect",
      primary: true,
      description: "Find connections (Connection Agent)",
      onClick: () =>
        triggerAgent(
          `Find notes semantically related to "${noteTitle}" and suggest internal links`,
          "connection",
        ),
    },
    {
      id: "summarize",
      icon: "file-text",
      label: "Summary",
      primary: false,
      description: "Generate summary",
      onClick: () =>
        sendToChat(`Create a concise summary of "${noteTitle}" that captures the key points`),
    },
    {
      id: "find-related",
      icon: "search",
      label: "Related",
      primary: false,
      description: "Find related notes",
      onClick: () =>
        triggerAgent(
          `Find notes semantically related to "${noteTitle}" and explain the connections`,
          "connection",
        ),
    },
    {
      id: "extract-tasks",
      icon: "check-square",
      label: "Tasks",
      primary: false,
      description: "Extract action items",
      onClick: () =>
        sendToChat(`Extract any actionable items or tasks mentioned in "${noteTitle}"`),
    },
  ];
}
