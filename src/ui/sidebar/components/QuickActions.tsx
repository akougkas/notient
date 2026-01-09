/**
 * QuickActions - Preact component for action buttons
 *
 * Displays: Enrich, Link, Move buttons
 */

import { setIcon } from "obsidian";
import { useCallback, useEffect, useRef } from "preact/hooks";

export interface QuickAction {
  icon: string;
  label: string;
  primary: boolean;
  onClick: () => void;
}

interface QuickActionsProps {
  actions: QuickAction[];
}

export function QuickActions({ actions }: QuickActionsProps) {
  return (
    <div class="nv2-section">
      <div class="nv2-section-label">Quick Actions</div>
      <div class="nv2-quick-actions">
        {actions.map((action) => (
          <ActionButton key={action.label} action={action} />
        ))}
      </div>
    </div>
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
    action.onClick();
  }, [action.onClick]);

  return (
    <div
      class={`nv2-quick-action${action.primary ? " nv2-quick-action--primary" : ""}`}
      onClick={handleClick}
    >
      <div class="nv2-quick-action-icon" ref={iconRef} />
      <div class="nv2-quick-action-label">{action.label}</div>
    </div>
  );
}

/**
 * Factory function to create standard quick actions for a note
 */
export function createNoteQuickActions(
  noteTitle: string,
  prefillChatAndSwitch: (prompt: string) => void,
): QuickAction[] {
  return [
    {
      icon: "sparkles",
      label: "Enrich",
      primary: true,
      onClick: () =>
        prefillChatAndSwitch(
          `Enrich and expand "${noteTitle}" with additional context and insights`,
        ),
    },
    {
      icon: "link",
      label: "Link",
      primary: false,
      onClick: () => prefillChatAndSwitch(`Find notes that should be linked to "${noteTitle}"`),
    },
    {
      icon: "arrow-right-circle",
      label: "Move",
      primary: false,
      onClick: () =>
        prefillChatAndSwitch(
          `Suggest the best folder/category for "${noteTitle}" based on its content`,
        ),
    },
  ];
}
