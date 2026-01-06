/**
 * Settings management for Notient
 * 
 * Handles loading, saving, validation, and the settings UI tab.
 */

import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import {
  NotientSettings,
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  SettingsValidation,
  SettingsError,
  SettingsWarning,
} from "./types/settings";
import type { Kernel } from "./core/kernel";

/**
 * Load settings from plugin data, applying defaults and migrations
 */
export async function loadSettings(plugin: Plugin): Promise<NotientSettings> {
  const data = await plugin.loadData();
  
  if (!data) {
    return { ...DEFAULT_SETTINGS };
  }

  // Merge with defaults for any missing fields
  const settings = mergeWithDefaults(data);

  // Run migrations if needed
  if (settings.version < SETTINGS_VERSION) {
    return migrateSettings(settings);
  }

  return settings;
}

/**
 * Save settings to plugin data
 */
export async function saveSettings(
  plugin: Plugin,
  settings: NotientSettings
): Promise<void> {
  await plugin.saveData(settings);
}

/**
 * Deep merge user settings with defaults
 */
function mergeWithDefaults(data: Partial<NotientSettings>): NotientSettings {
  return {
    version: data.version ?? DEFAULT_SETTINGS.version,
    ollama: { ...DEFAULT_SETTINGS.ollama, ...data.ollama },
    lmstudio: { ...DEFAULT_SETTINGS.lmstudio, ...data.lmstudio },
    indexing: { ...DEFAULT_SETTINGS.indexing, ...data.indexing },
    para: { ...DEFAULT_SETTINGS.para, ...data.para },
    ui: { ...DEFAULT_SETTINGS.ui, ...data.ui },
    advanced: { ...DEFAULT_SETTINGS.advanced, ...data.advanced },
    setupComplete: data.setupComplete ?? DEFAULT_SETTINGS.setupComplete,
  };
}

/**
 * Migrate settings from older versions
 */
function migrateSettings(settings: NotientSettings): NotientSettings {
  const migrated = { ...settings };
  
  // Add migrations here as versions change
  // Example:
  // if (migrated.version < 2) {
  //   migrated.newField = defaultValue;
  //   migrated.version = 2;
  // }

  migrated.version = SETTINGS_VERSION;
  return migrated;
}

/**
 * Validate settings and return any errors/warnings
 */
export function validateSettings(settings: NotientSettings): SettingsValidation {
  const errors: SettingsError[] = [];
  const warnings: SettingsWarning[] = [];

  // Validate Ollama settings
  if (settings.ollama.enabled) {
    if (!settings.ollama.host) {
      errors.push({ field: "ollama.host", message: "Ollama host is required" });
    }
    if (!settings.ollama.embeddingModel) {
      warnings.push({
        field: "ollama.embeddingModel",
        message: "No embedding model selected",
      });
    }
  }

  // Validate indexing settings
  if (settings.indexing.chunkSize < 100) {
    errors.push({
      field: "indexing.chunkSize",
      message: "Chunk size must be at least 100 characters",
    });
  }
  if (settings.indexing.chunkOverlap >= settings.indexing.chunkSize) {
    errors.push({
      field: "indexing.chunkOverlap",
      message: "Chunk overlap must be less than chunk size",
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Settings tab UI for Notient
 */
export class NotientSettingTab extends PluginSettingTab {
  private kernel: Kernel;
  private settings: NotientSettings;
  private onSettingsChange: (settings: NotientSettings) => Promise<void>;

  constructor(
    app: App,
    plugin: Plugin,
    kernel: Kernel,
    settings: NotientSettings,
    onSettingsChange: (settings: NotientSettings) => Promise<void>
  ) {
    super(app, plugin);
    this.kernel = kernel;
    this.settings = settings;
    this.onSettingsChange = onSettingsChange;
  }

  updateSettings(settings: NotientSettings): void {
    this.settings = settings;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h1", { text: "Notient Settings" });

    // Connection Status Section
    this.renderConnectionStatus(containerEl);

    // Ollama Settings
    this.renderOllamaSettings(containerEl);

    // LM Studio Settings
    this.renderLMStudioSettings(containerEl);

    // Indexing Settings
    this.renderIndexingSettings(containerEl);

    // PARA Settings
    this.renderParaSettings(containerEl);

    // Advanced Settings
    this.renderAdvancedSettings(containerEl);
  }

  private renderConnectionStatus(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "Connection Status" });

    const statusDiv = containerEl.createDiv({ cls: "notient-status-grid" });
    
    const health = this.kernel.serviceHealth;

    // Ollama status
    this.createStatusItem(statusDiv, "Ollama (Embeddings)", health.ollama.status, health.ollama.error);
    
    // LM Studio status
    this.createStatusItem(statusDiv, "LM Studio (Reasoning)", health.lmstudio.status, health.lmstudio.error);
  }

  private createStatusItem(
    container: HTMLElement,
    name: string,
    status: string,
    error: string | null
  ): void {
    const item = container.createDiv({ cls: "notient-status-item" });
    
    const indicator = item.createSpan({ cls: `notient-status-indicator status-${status}` });
    indicator.setText(this.getStatusEmoji(status));
    
    const label = item.createSpan({ cls: "notient-status-label" });
    label.setText(name);
    
    if (error) {
      const errorText = item.createSpan({ cls: "notient-status-error" });
      errorText.setText(error);
    }
  }

  private getStatusEmoji(status: string): string {
    switch (status) {
      case "healthy": return "✓";
      case "unhealthy": return "✗";
      case "checking": return "⋯";
      default: return "?";
    }
  }

  private renderOllamaSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "Ollama (Embeddings)" });

    new Setting(containerEl)
      .setName("Enable Ollama")
      .setDesc("Use Ollama for generating embeddings")
      .addToggle((toggle) =>
        toggle
          .setValue(this.settings.ollama.enabled)
          .onChange(async (value) => {
            this.settings.ollama.enabled = value;
            await this.onSettingsChange(this.settings);
          })
      );

    new Setting(containerEl)
      .setName("Ollama Host")
      .setDesc("URL of the Ollama server")
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:11434")
          .setValue(this.settings.ollama.host)
          .onChange(async (value) => {
            this.settings.ollama.host = value;
            await this.onSettingsChange(this.settings);
          })
      );

    new Setting(containerEl)
      .setName("Embedding Model")
      .setDesc("Ollama model to use for embeddings")
      .addText((text) =>
        text
          .setPlaceholder("nomic-embed-text")
          .setValue(this.settings.ollama.embeddingModel)
          .onChange(async (value) => {
            this.settings.ollama.embeddingModel = value;
            await this.onSettingsChange(this.settings);
          })
      );
  }

  private renderLMStudioSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "LM Studio (Reasoning)" });

    new Setting(containerEl)
      .setName("Enable LM Studio")
      .setDesc("Use LM Studio for AI reasoning")
      .addToggle((toggle) =>
        toggle
          .setValue(this.settings.lmstudio.enabled)
          .onChange(async (value) => {
            this.settings.lmstudio.enabled = value;
            await this.onSettingsChange(this.settings);
          })
      );

    new Setting(containerEl)
      .setName("LM Studio Host")
      .setDesc("URL of the LM Studio server (OpenAI-compatible API)")
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:1234")
          .setValue(this.settings.lmstudio.host)
          .onChange(async (value) => {
            this.settings.lmstudio.host = value;
            await this.onSettingsChange(this.settings);
          })
      );

    new Setting(containerEl)
      .setName("Reasoning Model")
      .setDesc("Model to use for AI reasoning (must be loaded in LM Studio)")
      .addText((text) =>
        text
          .setPlaceholder("ministral-3b-instruct")
          .setValue(this.settings.lmstudio.reasoningModel)
          .onChange(async (value) => {
            this.settings.lmstudio.reasoningModel = value;
            await this.onSettingsChange(this.settings);
          })
      );
  }

  private renderIndexingSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "Indexing" });

    new Setting(containerEl)
      .setName("Chunk Size")
      .setDesc("Target size for text chunks (characters)")
      .addText((text) =>
        text
          .setPlaceholder("1000")
          .setValue(String(this.settings.indexing.chunkSize))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 100) {
              this.settings.indexing.chunkSize = num;
              await this.onSettingsChange(this.settings);
            }
          })
      );

    new Setting(containerEl)
      .setName("Chunk Overlap")
      .setDesc("Overlap between chunks (characters)")
      .addText((text) =>
        text
          .setPlaceholder("200")
          .setValue(String(this.settings.indexing.chunkOverlap))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 0) {
              this.settings.indexing.chunkOverlap = num;
              await this.onSettingsChange(this.settings);
            }
          })
      );

    new Setting(containerEl)
      .setName("Debounce Delay")
      .setDesc("Delay before processing file changes (ms)")
      .addText((text) =>
        text
          .setPlaceholder("5000")
          .setValue(String(this.settings.indexing.debounceMs))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 1000) {
              this.settings.indexing.debounceMs = num;
              await this.onSettingsChange(this.settings);
            }
          })
      );

    new Setting(containerEl)
      .setName("Excluded Folders")
      .setDesc("Folders to exclude from indexing (comma-separated)")
      .addText((text) =>
        text
          .setPlaceholder(".obsidian, .trash")
          .setValue(this.settings.indexing.excludedFolders.join(", "))
          .onChange(async (value) => {
            this.settings.indexing.excludedFolders = value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.onSettingsChange(this.settings);
          })
      );
  }

  private renderParaSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "PARA Folders" });
    containerEl.createEl("p", {
      text: "Configure folder paths for PARA method detection. Use comma-separated values for multiple folders.",
      cls: "setting-item-description",
    });

    const paraTypes: Array<{ key: keyof NotientSettings["para"]; label: string }> = [
      { key: "inbox", label: "Inbox" },
      { key: "projects", label: "Projects" },
      { key: "areas", label: "Areas" },
      { key: "resources", label: "Resources" },
      { key: "archive", label: "Archive" },
    ];

    for (const { key, label } of paraTypes) {
      new Setting(containerEl)
        .setName(`${label} Folders`)
        .addText((text) =>
          text
            .setValue(this.settings.para[key].join(", "))
            .onChange(async (value) => {
              this.settings.para[key] = value
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
              await this.onSettingsChange(this.settings);
            })
        );
    }
  }

  private renderAdvancedSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "Advanced" });

    new Setting(containerEl)
      .setName("Debug Logging")
      .setDesc("Enable verbose logging for troubleshooting")
      .addToggle((toggle) =>
        toggle
          .setValue(this.settings.advanced.debugLogging)
          .onChange(async (value) => {
            this.settings.advanced.debugLogging = value;
            await this.onSettingsChange(this.settings);
          })
      );

    new Setting(containerEl)
      .setName("Reindex Vault")
      .setDesc("Force a complete re-index of all notes")
      .addButton((button) =>
        button
          .setButtonText("Reindex")
          .setWarning()
          .onClick(async () => {
            // Will be implemented with indexer
            button.setButtonText("Queued...");
            button.setDisabled(true);
          })
      );
  }
}
