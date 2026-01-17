/**
 * Notient Sidebar View - Obsidian ItemView wrapper
 * Mounts the Preact App component into Obsidian's workspace
 * Source of truth: .planning/PHASE-GALAXY.md (Phase G4)
 */

import { ItemView, type WorkspaceLeaf } from "obsidian";
import { render } from "preact";
import { kernel } from "../../core/kernel";
import { App, setActiveFile } from "./App";

export const VIEW_TYPE_SIDEBAR = "notient-sidebar";

export class SidebarView extends ItemView {
  private preactRoot: HTMLElement | null = null;
  private unsubscribeActiveLeaf: (() => void) | null = null;

  getViewType(): string {
    return VIEW_TYPE_SIDEBAR;
  }

  getDisplayText(): string {
    return "Notient";
  }

  getIcon(): string {
    return "brain";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("notient-sidebar");
    this.preactRoot = container;

    // Subscribe to active leaf changes via ObsidianFacade
    const obsidianFacade = kernel.get("obsidianFacade");
    this.unsubscribeActiveLeaf = obsidianFacade.onActiveLeafChange((file) => {
      setActiveFile(file);
    });

    // Set initial active file
    setActiveFile(obsidianFacade.getActiveFile());

    render(<App />, this.preactRoot);
  }

  async onClose(): Promise<void> {
    // Unsubscribe from active leaf changes
    if (this.unsubscribeActiveLeaf) {
      this.unsubscribeActiveLeaf();
      this.unsubscribeActiveLeaf = null;
    }

    if (this.preactRoot) {
      render(null, this.preactRoot);
    }
    this.preactRoot = null;
  }
}
