/**
 * Settings management for Notient
 *
 * Features:
 * - Local/Network buttons with default IPs (always visible IP input)
 * - Model dimension auto-detected (read-only)
 * - Chunk size slider (32-8192) with performance tooltip
 * - Multi-index management
 */

import { App, Plugin, PluginSettingTab, Setting, debounce } from "obsidian";
import {
  NotientSettings,
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  SettingsValidation,
  SettingsError,
  SettingsWarning,
} from "./types/settings";
import type { Kernel } from "./core/kernel";
import { MODEL_DEFAULTS } from "./core/constants";

// Default IPs per service
const DEFAULT_IPS = {
  ollama: { local: "localhost", network: "192.168.86.249" },
  lmstudio: { local: "127.0.0.1", network: "192.168.86.249" },
};

const DEFAULT_PORTS = {
  ollama: "11434",
  lmstudio: "1234",
};

/**
 * Load settings from plugin data
 */
export async function loadSettings(plugin: Plugin): Promise<NotientSettings> {
  const data = await plugin.loadData();

  if (!data) {
    return { ...DEFAULT_SETTINGS };
  }

  const settings = mergeWithDefaults(data);

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

function migrateSettings(settings: NotientSettings): NotientSettings {
  const migrated = { ...settings };
  migrated.version = SETTINGS_VERSION;
  return migrated;
}

export function validateSettings(settings: NotientSettings): SettingsValidation {
  const errors: SettingsError[] = [];
  const warnings: SettingsWarning[] = [];

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

  if (settings.indexing.chunkSize < 32) {
    errors.push({
      field: "indexing.chunkSize",
      message: "Chunk size must be at least 32 characters",
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

interface ServiceNetworkConfig {
  ip: string;
  port: string;
}

/**
 * Settings tab
 */
export class NotientSettingTab extends PluginSettingTab {
  private kernel: Kernel;
  private settings: NotientSettings;
  private onSettingsChange: (settings: NotientSettings) => Promise<void>;

  // Network configs per service
  private ollamaConfig: ServiceNetworkConfig = { ip: DEFAULT_IPS.ollama.local, port: DEFAULT_PORTS.ollama };
  private lmstudioConfig: ServiceNetworkConfig = { ip: DEFAULT_IPS.lmstudio.local, port: DEFAULT_PORTS.lmstudio };

  // Track original embedding model
  private originalEmbeddingModel: string = "";

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
    this.parseHostSettings();
    this.originalEmbeddingModel = settings.ollama.embeddingModel;
  }

  updateSettings(settings: NotientSettings): void {
    this.settings = settings;
    this.parseHostSettings();
  }

  private parseHostSettings(): void {
    // Parse Ollama
    const ollamaMatch = this.settings.ollama.host.match(/https?:\/\/([^:]+):?(\d+)?/);
    if (ollamaMatch) {
      this.ollamaConfig.ip = ollamaMatch[1];
      if (ollamaMatch[2]) this.ollamaConfig.port = ollamaMatch[2];
    }

    // Parse LM Studio
    const lmMatch = this.settings.lmstudio.host.match(/https?:\/\/([^:]+):?(\d+)?/);
    if (lmMatch) {
      this.lmstudioConfig.ip = lmMatch[1];
      if (lmMatch[2]) this.lmstudioConfig.port = lmMatch[2];
    }
  }

  private buildHost(config: ServiceNetworkConfig): string {
    return `http://${config.ip}:${config.port}`;
  }

  private isLocalIP(ip: string, service: "ollama" | "lmstudio"): boolean {
    const local = DEFAULT_IPS[service].local;
    return ip === local || ip === "127.0.0.1" || ip === "localhost";
  }

  private getModelDimension(modelName: string): number | null {
    return MODEL_DEFAULTS.EMBEDDING_DIMENSIONS[modelName] ?? null;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("notient-settings");

    containerEl.createEl("h1", { text: "Notient Settings" });

    // Connection Status
    this.renderConnectionStatus(containerEl);

    // Embeddings Service (Ollama)
    this.renderOllamaSection(containerEl);

    // Chat Service (LM Studio)
    this.renderLMStudioSection(containerEl);

    // Indexing (with chunk size slider)
    this.renderIndexingSection(containerEl);

    // Index Management
    this.renderIndexManagement(containerEl);

    // PARA Folders
    this.renderParaSection(containerEl);

    // Advanced
    this.renderAdvancedSection(containerEl);
  }

  private renderConnectionStatus(containerEl: HTMLElement): void {
    const health = this.kernel.serviceHealth;

    const statusRow = containerEl.createDiv({ cls: "notient-settings-status-row" });

    const ollamaStatus = statusRow.createDiv({ cls: "notient-settings-status-item" });
    ollamaStatus.createSpan({ cls: `notient-settings-dot status-${health.ollama.status}` });
    ollamaStatus.createSpan({ text: "Ollama" });

    const lmStatus = statusRow.createDiv({ cls: "notient-settings-status-item" });
    lmStatus.createSpan({ cls: `notient-settings-dot status-${health.lmstudio.status}` });
    lmStatus.createSpan({ text: "LM Studio" });

    const indexManager = this.kernel.getService<{ getIndexedCount(): number }>("indexer");
    if (indexManager) {
      const indexStatus = statusRow.createDiv({ cls: "notient-settings-status-item" });
      indexStatus.createSpan({ text: `📊 ${indexManager.getIndexedCount()} indexed` });
    }
  }

  private renderOllamaSection(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({ cls: "notient-settings-section" });
    section.createEl("h2", { text: "🦙 Embeddings (Ollama)" });

    // Local/Network buttons
    const toggleRow = section.createDiv({ cls: "notient-settings-toggle-row" });
    const toggle = toggleRow.createDiv({ cls: "notient-settings-toggle" });

    const localBtn = toggle.createEl("button", {
      text: "🏠 Local",
      cls: `notient-settings-toggle-btn ${this.isLocalIP(this.ollamaConfig.ip, "ollama") ? "active" : ""}`,
    });
    localBtn.addEventListener("click", async () => {
      this.ollamaConfig.ip = DEFAULT_IPS.ollama.local;
      await this.updateOllamaHost();
      this.display();
    });

    const networkBtn = toggle.createEl("button", {
      text: "📡 Network",
      cls: `notient-settings-toggle-btn ${this.ollamaConfig.ip === DEFAULT_IPS.ollama.network ? "active" : ""}`,
    });
    networkBtn.addEventListener("click", async () => {
      this.ollamaConfig.ip = DEFAULT_IPS.ollama.network;
      await this.updateOllamaHost();
      this.display();
    });

    // Host input (always visible)
    new Setting(section)
      .setName("Host")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_IPS.ollama.network)
          .setValue(this.ollamaConfig.ip)
          .onChange(
            debounce(async (value) => {
              this.ollamaConfig.ip = value.trim() || DEFAULT_IPS.ollama.local;
              await this.updateOllamaHost();
            }, 500, true)
          )
      )
      .addText((text) =>
        text
          .setPlaceholder("11434")
          .setValue(this.ollamaConfig.port)
          .onChange(
            debounce(async (value) => {
              this.ollamaConfig.port = value.trim() || DEFAULT_PORTS.ollama;
              await this.updateOllamaHost();
            }, 500, true)
          )
      );

    // Model with dimension display
    const dim = this.getModelDimension(this.settings.ollama.embeddingModel);
    const modelSetting = new Setting(section)
      .setName("Embedding Model")
      .setDesc(dim ? `${dim}-dimensional vectors (auto-detected)` : "Dimension detected on first use");

    modelSetting.addText((text) =>
      text
        .setPlaceholder("nomic-embed-text")
        .setValue(this.settings.ollama.embeddingModel)
        .onChange(async (value) => {
          this.settings.ollama.embeddingModel = value;
          await this.onSettingsChange(this.settings);
          this.display();
        })
    );

    // Model change notice
    if (
      this.originalEmbeddingModel &&
      this.settings.ollama.embeddingModel !== this.originalEmbeddingModel
    ) {
      const notice = section.createDiv({ cls: "notient-settings-notice" });
      notice.innerHTML = `ℹ️ New index for <b>${this.settings.ollama.embeddingModel}</b>. <b>${this.originalEmbeddingModel}</b> preserved.`;
    }
  }

  private async updateOllamaHost(): Promise<void> {
    this.settings.ollama.host = this.buildHost(this.ollamaConfig);
    await this.onSettingsChange(this.settings);
  }

  private renderLMStudioSection(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({ cls: "notient-settings-section" });
    section.createEl("h2", { text: "🤖 Chat (LM Studio)" });

    // Local/Network buttons
    const toggleRow = section.createDiv({ cls: "notient-settings-toggle-row" });
    const toggle = toggleRow.createDiv({ cls: "notient-settings-toggle" });

    const localBtn = toggle.createEl("button", {
      text: "🏠 Local",
      cls: `notient-settings-toggle-btn ${this.isLocalIP(this.lmstudioConfig.ip, "lmstudio") ? "active" : ""}`,
    });
    localBtn.addEventListener("click", async () => {
      this.lmstudioConfig.ip = DEFAULT_IPS.lmstudio.local;
      await this.updateLMStudioHost();
      this.display();
    });

    const networkBtn = toggle.createEl("button", {
      text: "📡 Network",
      cls: `notient-settings-toggle-btn ${this.lmstudioConfig.ip === DEFAULT_IPS.lmstudio.network ? "active" : ""}`,
    });
    networkBtn.addEventListener("click", async () => {
      this.lmstudioConfig.ip = DEFAULT_IPS.lmstudio.network;
      await this.updateLMStudioHost();
      this.display();
    });

    // Host input (always visible)
    new Setting(section)
      .setName("Host")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_IPS.lmstudio.network)
          .setValue(this.lmstudioConfig.ip)
          .onChange(
            debounce(async (value) => {
              this.lmstudioConfig.ip = value.trim() || DEFAULT_IPS.lmstudio.local;
              await this.updateLMStudioHost();
            }, 500, true)
          )
      )
      .addText((text) =>
        text
          .setPlaceholder("1234")
          .setValue(this.lmstudioConfig.port)
          .onChange(
            debounce(async (value) => {
              this.lmstudioConfig.port = value.trim() || DEFAULT_PORTS.lmstudio;
              await this.updateLMStudioHost();
            }, 500, true)
          )
      );

    // Model
    new Setting(section)
      .setName("Reasoning Model")
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

  private async updateLMStudioHost(): Promise<void> {
    this.settings.lmstudio.host = this.buildHost(this.lmstudioConfig);
    await this.onSettingsChange(this.settings);
  }

  private renderIndexingSection(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({ cls: "notient-settings-section" });
    section.createEl("h2", { text: "Indexing" });

    // Chunk Size Slider
    const sliderSection = section.createDiv({ cls: "notient-settings-slider-section" });
    
    const sliderHeader = sliderSection.createDiv({ cls: "notient-settings-slider-header" });
    sliderHeader.createEl("label", { text: "Chunk Size:" });
    const sliderValue = sliderHeader.createEl("span", { 
      text: `${this.settings.indexing.chunkSize} chars`,
      cls: "notient-settings-slider-value",
    });

    const slider = sliderSection.createEl("input", {
      type: "range",
      cls: "notient-settings-slider",
      attr: {
        min: "32",
        max: "8192",
        step: "32",
        value: String(this.settings.indexing.chunkSize),
      },
    });

    slider.addEventListener("input", (e) => {
      const value = parseInt((e.target as HTMLInputElement).value, 10);
      sliderValue.textContent = `${value} chars`;
    });

    slider.addEventListener("change", async (e) => {
      this.settings.indexing.chunkSize = parseInt((e.target as HTMLInputElement).value, 10);
      await this.onSettingsChange(this.settings);
    });

    // Tooltip
    const tooltip = sliderSection.createDiv({ cls: "notient-settings-tooltip" });
    tooltip.innerHTML = `
      <span class="notient-tooltip-small">⚡ Smaller</span> = precise matches, more chunks
      <span class="notient-tooltip-sep">|</span>
      <span class="notient-tooltip-large">📚 Larger</span> = more context, fewer chunks
    `;

    // Excluded folders
    new Setting(section)
      .setName("Excluded folders")
      .setDesc("Comma-separated list")
      .addText((text) =>
        text
          .setPlaceholder(".obsidian, .trash, templates")
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

  private renderIndexManagement(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({ cls: "notient-settings-section" });
    section.createEl("h2", { text: "Index Management" });

    const indexManager = this.kernel.getService<{
      getIndexedCount(): number;
      getActiveModelKey(): string;
      listAvailableIndices(): string[];
    }>("indexer");

    if (indexManager) {
      const infoBox = section.createDiv({ cls: "notient-settings-info-box" });
      infoBox.createEl("div", { text: `Active: ${indexManager.getActiveModelKey() || "none"}` });

      const indices = indexManager.listAvailableIndices();
      if (indices.length > 0) {
        infoBox.createEl("div", {
          text: `Available: ${indices.join(", ")}`,
          cls: "notient-settings-info-dim",
        });
      }
    }

    new Setting(section)
      .setName("Export index")
      .setDesc("Save to file for backup")
      .addButton((btn) => btn.setButtonText("Export...").onClick(() => {
        this.kernel.obsidian.notice("Export coming soon");
      }));

    new Setting(section)
      .setName("Import index")
      .setDesc("Load from file")
      .addButton((btn) => btn.setButtonText("Import...").onClick(() => {
        this.kernel.obsidian.notice("Import coming soon");
      }));

    new Setting(section)
      .setName("Trim index")
      .setDesc("Remove deleted notes")
      .addButton((btn) => btn.setButtonText("Trim").onClick(() => {
        this.kernel.obsidian.notice("Trim coming soon");
      }));

    new Setting(section)
      .setName("Delete index")
      .setDesc("Remove specific model index")
      .addButton((btn) => btn.setButtonText("Delete...").setWarning().onClick(() => {
        this.kernel.obsidian.notice("Delete coming soon");
      }));
  }

  private renderParaSection(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({ cls: "notient-settings-section" });
    section.createEl("h2", { text: "PARA Folders" });

    const paraTypes: Array<{ key: keyof NotientSettings["para"]; label: string }> = [
      { key: "inbox", label: "📥 Inbox" },
      { key: "projects", label: "🎯 Projects" },
      { key: "areas", label: "🏠 Areas" },
      { key: "resources", label: "📚 Resources" },
      { key: "archive", label: "📦 Archive" },
    ];

    for (const { key, label } of paraTypes) {
      new Setting(section).setName(label).addText((text) =>
        text.setValue(this.settings.para[key].join(", ")).onChange(async (value) => {
          this.settings.para[key] = value
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          await this.onSettingsChange(this.settings);
        })
      );
    }
  }

  private renderAdvancedSection(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({ cls: "notient-settings-section" });
    section.createEl("h2", { text: "Advanced" });

    new Setting(section).setName("Debug logging").addToggle((toggle) =>
      toggle.setValue(this.settings.advanced.debugLogging).onChange(async (value) => {
        this.settings.advanced.debugLogging = value;
        await this.onSettingsChange(this.settings);
      })
    );

    new Setting(section).setName("Run setup wizard").addButton((btn) =>
      btn.setButtonText("Open").onClick(() => {
        (this.app as App & { commands: { executeCommandById: (id: string) => void } }).commands.executeCommandById(
          "notient:run-setup"
        );
      })
    );

    new Setting(section)
      .setName("Full reindex")
      .setDesc("Rebuild current index")
      .addButton((btn) =>
        btn.setButtonText("Reindex").setWarning().onClick(() => {
          (this.app as App & { commands: { executeCommandById: (id: string) => void } }).commands.executeCommandById(
            "notient:full-reindex"
          );
        })
      );

    new Setting(section)
      .setName("Clear all indexes")
      .setDesc("Delete ALL data")
      .addButton((btn) =>
        btn.setButtonText("Clear All").setWarning().onClick(async () => {
          const indexManager = this.kernel.getService<{ clearAll(): Promise<void> }>("indexer");
          if (indexManager) {
            await indexManager.clearAll();
            this.kernel.obsidian.notice("All indexes cleared");
          }
        })
      );
  }
}
