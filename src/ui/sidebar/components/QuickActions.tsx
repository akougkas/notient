/**
 * QuickActions - Quick action buttons (Section 3 of Note Vitals)
 *
 * Per spec: 6 smart-filtered actions based on note state
 * [🔍 Find Connections] [✨ Enrich Note] [🔗 Link Ideas]
 * [📝 Summarize] [🏷️ Suggest Tags] [📋 Extract Tasks]
 */

import { setIcon } from "obsidian";
import { useCallback, useEffect, useRef } from "preact/hooks";
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
  const iconRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (iconRef.current) {
      setIcon(iconRef.current, action.icon);
    }
  }, [action.icon]);

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
      <span class="nv2-quick-action-icon" ref={iconRef} aria-hidden="true" />
      <span class="nv2-quick-action-label">{action.label}</span>
    </button>
  );
}

/**
 * Callbacks for Quick Actions
 * All 6 actions now route through Agent Streams for consistent UX
 */
export interface QuickActionCallbacks {
  /** Trigger agentic background workflow (shows in Agent Streams) */
  triggerAgent: (prompt: string, taskType: "link" | "enrich" | "classify" | "analyze") => void;
  /** Send to conversational chat (kept for Chat input, not used by Quick Actions) */
  sendToChat: (prompt: string) => void;
}

/**
 * Factory function to create standard quick actions for a note
 * Per spec: 6 actions, smart-filtered to show 4-6 most relevant
 *
 * All 6 actions are agentic: run in background, show results in Agent Streams
 */
export function createNoteQuickActions(
  noteTitle: string,
  callbacks: QuickActionCallbacks,
): QuickAction[] {
  const { triggerAgent } = callbacks;

  return [
    {
      id: "find-connections",
      icon: "search",
      label: "Find",
      primary: true,
      description: "Find related notes (Agent)",
      onClick: () =>
        triggerAgent(
          `Find notes semantically related to "${noteTitle}" and explain the connections`,
          "link",
        ),
    },
    {
      id: "link-ideas",
      icon: "link",
      label: "Link",
      primary: false,
      description: "Suggest links (Agent)",
      onClick: () =>
        triggerAgent(
          `Suggest internal wiki-links to add to "${noteTitle}" that connect it to related notes`,
          "link",
        ),
    },
    {
      id: "enrich",
      icon: "sparkles",
      label: "Enrich",
      primary: false,
      description: "Enrich with context (Agent)",
      onClick: () =>
        triggerAgent(
          `Enrich and expand "${noteTitle}" with additional context, examples, and insights`,
          "enrich",
        ),
    },
    {
      id: "suggest-tags",
      icon: "tag",
      label: "Tags",
      primary: false,
      description: "Suggest tags (Agent)",
      onClick: () =>
        triggerAgent(
          `Classify and suggest relevant tags for "${noteTitle}" based on its content`,
          "classify",
        ),
    },

    {
      id: "summarize",
      icon: "file-text",
      label: "Summary",
      primary: false,
      description: "Generate summary (Agent)",
      onClick: () =>
        triggerAgent(
          `Create a concise summary of "${noteTitle}" that captures the key points`,
          "analyze",
        ),
    },
    {
      id: "extract-tasks",
      icon: "check-square",
      label: "Tasks",
      primary: false,
      description: "Extract tasks (Agent)",
      onClick: () =>
        triggerAgent(
          `Extract any actionable items or tasks mentioned in "${noteTitle}"`,
          "analyze",
        ),
    },
  ];
}
