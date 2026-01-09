/**
 * QuickActions - Renders action buttons (Enrich, Link, Move)
 *
 * Extracted from sidebar.ts for modularity.
 */

import { setIcon } from "obsidian";

export interface QuickAction {
  icon: string;
  label: string;
  primary: boolean;
  onClick: () => void;
}

export class QuickActions {
  constructor(private actions: QuickAction[]) {}

  render(container: HTMLElement): HTMLElement {
    const section = container.createDiv({ cls: "nv2-section" });
    section.createDiv({ cls: "nv2-section-label", text: "Quick Actions" });

    const actionsContainer = section.createDiv({ cls: "nv2-quick-actions" });

    for (const action of this.actions) {
      this.renderAction(actionsContainer, action);
    }

    return section;
  }

  private renderAction(container: HTMLElement, action: QuickAction): void {
    const btn = container.createDiv({
      cls: `nv2-quick-action${action.primary ? " nv2-quick-action--primary" : ""}`,
    });

    const iconEl = btn.createDiv({ cls: "nv2-quick-action-icon" });
    setIcon(iconEl, action.icon);

    btn.createDiv({ cls: "nv2-quick-action-label", text: action.label });
    btn.addEventListener("click", action.onClick);
  }
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
