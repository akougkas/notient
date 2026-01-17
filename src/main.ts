/**
 * Notient v0.1.0 - Phase Galaxy
 * AI-powered vault management for Obsidian using local LLMs only.
 */

import { Notice, Plugin } from "obsidian";
import { ObsidianFacade } from "./adapters/obsidian";
import { Database } from "./core/db/database";
import { EventBus } from "./core/events";
import { kernel } from "./core/kernel";
import { startPipelineListener } from "./core/pipeline";
import { DEFAULT_SETTINGS, type NotientSettings } from "./types";
import { SetupWizard } from "./ui/modals";
import { NotientSettingsTab } from "./ui/settings/SettingsTab";
import { SidebarView, VIEW_TYPE_SIDEBAR } from "./ui/sidebar/SidebarView";

export default class NotientPlugin extends Plugin {
  settings: NotientSettings = DEFAULT_SETTINGS;
  private unsubscribePipelineListener?: () => void;

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.initializeKernel();

    // Start pipeline event listener
    const eventBus = kernel.get("eventBus");
    this.unsubscribePipelineListener = startPipelineListener(eventBus);

    this.registerView(VIEW_TYPE_SIDEBAR, (leaf) => new SidebarView(leaf));
    this.addSettingTab(new NotientSettingsTab(this.app, this));
    this.registerCommands();

    this.app.workspace.onLayoutReady(() => {
      this.activateSidebarView();
      this.checkFirstRun();
    });
  }

  async onunload(): Promise<void> {
    this.unsubscribePipelineListener?.();
    await kernel.shutdown();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_SIDEBAR);
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = { ...DEFAULT_SETTINGS, ...data };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async initializeKernel(): Promise<void> {
    kernel.register("eventBus", () => new EventBus());
    kernel.register("database", () => new Database());
    kernel.register("obsidianFacade", () => new ObsidianFacade(this.app));

    await kernel.initialize({
      app: this.app,
      plugin: this,
      settings: this.settings,
    });
  }

  private registerCommands(): void {
    this.addCommand({
      id: "enhance-note",
      name: "Enhance note",
      editorCallback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("No active note to enhance");
          return;
        }
        const eventBus = kernel.get("eventBus");
        eventBus.emit("enhance:start", {
          noteId: file.path,
          timestamp: Date.now(),
        });
        new Notice("Enhancement started...");
      },
    });
  }

  private async activateSidebarView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR);
    if (existing.length > 0) {
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE_SIDEBAR, active: true });
    }
  }

  private checkFirstRun(): void {
    const hasSettings =
      this.settings.reasoningProvider.baseUrl !== DEFAULT_SETTINGS.reasoningProvider.baseUrl ||
      this.settings.embeddingProvider.baseUrl !== DEFAULT_SETTINGS.embeddingProvider.baseUrl;

    if (!hasSettings) {
      new SetupWizard(this.app, this, () => {
        const eventBus = kernel.get("eventBus");
        const files = this.app.vault.getMarkdownFiles();
        eventBus.emit("index:start", { noteCount: files.length });
      }).open();
    }
  }
}
