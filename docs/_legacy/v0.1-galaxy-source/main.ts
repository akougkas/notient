/**
 * Notient v0.1.0 - Phase Galaxy
 * AI-powered vault management for Obsidian using local LLMs only.
 */

import { Notice, Plugin } from "obsidian";
import { ObsidianFacade } from "./adapters/obsidian";
import { Database } from "./core/db/database";
import { EventBus } from "./core/events";
import { type FileAccessor, Indexer } from "./core/indexer";
import { kernel } from "./core/kernel";
import { startPipelineListener } from "./core/pipeline";
import { DEFAULT_SETTINGS, type NotientSettings } from "./types";
import { SetupWizard } from "./ui/modals";
import { NotientSettingsTab } from "./ui/settings/SettingsTab";
import { setNoteCount } from "./ui/sidebar/App";
import { SidebarView, VIEW_TYPE_SIDEBAR } from "./ui/sidebar/SidebarView";

const PLUGIN_DIR = ".obsidian/plugins/notient";
const DB_PATH = `${PLUGIN_DIR}/notient.db`;
const WASM_PATH = `${PLUGIN_DIR}/sql-wasm.wasm`;

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
    const eventBus = new EventBus();
    const database = new Database();
    const obsidianFacade = new ObsidianFacade(this.app);

    kernel.register("eventBus", () => eventBus);
    kernel.register("database", () => database);
    kernel.register("obsidianFacade", () => obsidianFacade);

    // Initialize database with SQLite
    await database.init(this.app.vault.adapter, {
      dbPath: DB_PATH,
      wasmPath: WASM_PATH,
    });

    // Create FileAccessor adapter for Indexer
    const fileAccessor: FileAccessor = {
      listMarkdownFiles: () => this.app.vault.getMarkdownFiles().map((f) => ({ path: f.path })),
      readFile: (path) => this.app.vault.adapter.read(path),
      getFileSize: (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return file && "stat" in file ? (file.stat as { size: number }).size : null;
      },
    };

    // Register indexer
    kernel.register("indexer", () => new Indexer(database, eventBus, fileAccessor));

    // Subscribe to index events to update UI
    eventBus.on("index:complete", (payload) => {
      setNoteCount(payload.noteCount);
    });

    // Log index events in dev mode
    if (this.settings.devMode) {
      eventBus.on("index:start", (p) => console.log(`[Indexer] Starting: ${p.noteCount} notes`));
      eventBus.on("index:progress", (p) =>
        console.log(`[Indexer] Progress: ${p.completed}/${p.total}`),
      );
      eventBus.on("index:complete", (p) =>
        console.log(`[Indexer] Complete: ${p.noteCount} notes in ${p.duration}ms`),
      );
      eventBus.on("index:error", (p) => console.error(`[Indexer] Error: ${p.error}`));
    }

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
      // First run - show wizard and index on completion
      new SetupWizard(this.app, this, () => {
        this.startIndexing();
      }).open();
    } else {
      // Returning user - start indexing immediately
      this.startIndexing();
    }
  }

  private startIndexing(): void {
    const indexer = kernel.get("indexer");
    indexer.indexVault(this.settings.excludedFolders).catch((error) => {
      console.error("[Notient] Indexing failed:", error);
      new Notice("Notient: Indexing failed. Check console for details.");
    });
  }
}
