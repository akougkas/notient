/**
 * Notient Sidebar View - Obsidian ItemView wrapper
 * Mounts the Preact App component into Obsidian's workspace
 * Source of truth: .planning/PHASE-GALAXY.md (Phase G4)
 */

import { ItemView, type WorkspaceLeaf } from "obsidian";
import { render } from "preact";
import { kernel } from "../../core/kernel";
import { checkLLMHealth } from "../../core/llm/healthCheck";
import type { IndexCompletePayload, IndexProgressPayload } from "../../types";
import { App, setActiveFile, setOpenSettingsCallback, setSystemStatus } from "./App";

export const VIEW_TYPE_SIDEBAR = "notient-sidebar";

export class SidebarView extends ItemView {
  private preactRoot: HTMLElement | null = null;
  private unsubscribeActiveLeaf: (() => void) | null = null;
  private unsubscribeIndexComplete: (() => void) | null = null;
  private unsubscribeIndexProgress: (() => void) | null = null;

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

    // Subscribe to EventBus events for status updates
    const eventBus = kernel.get("eventBus");

    const handleIndexComplete = (payload: IndexCompletePayload) => {
      setSystemStatus({ noteCount: payload.noteCount });
    };
    eventBus.on("index:complete", handleIndexComplete);
    this.unsubscribeIndexComplete = () => eventBus.off("index:complete", handleIndexComplete);

    const handleIndexProgress = (_payload: IndexProgressPayload) => {
      // Progress updates could be used for UI feedback in future
    };
    eventBus.on("index:progress", handleIndexProgress);
    this.unsubscribeIndexProgress = () => eventBus.off("index:progress", handleIndexProgress);

    // Check LLM health on mount
    const settings = kernel.getContext().settings;
    const health = await checkLLMHealth(settings);
    setSystemStatus({ connected: health.reasoning && health.embedding });

    // Set callback to open Obsidian settings to Notient tab
    setOpenSettingsCallback(() => {
      // Use type assertion for internal Obsidian API
      const app = this.app as unknown as {
        setting: { open: () => void; openTabById: (id: string) => void };
      };
      app.setting.open();
      app.setting.openTabById("notient");
    });

    render(<App />, this.preactRoot);
  }

  async onClose(): Promise<void> {
    // Unsubscribe from active leaf changes
    if (this.unsubscribeActiveLeaf) {
      this.unsubscribeActiveLeaf();
      this.unsubscribeActiveLeaf = null;
    }

    // Unsubscribe from EventBus events
    if (this.unsubscribeIndexComplete) {
      this.unsubscribeIndexComplete();
      this.unsubscribeIndexComplete = null;
    }
    if (this.unsubscribeIndexProgress) {
      this.unsubscribeIndexProgress();
      this.unsubscribeIndexProgress = null;
    }

    if (this.preactRoot) {
      render(null, this.preactRoot);
    }
    this.preactRoot = null;
  }
}
