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
    const isReady = this.kernel.isServicesInitialized;

    const statusRow = containerEl.createDiv({ cls: "notient-settings-status-row" });

    // Ollama status
    const ollamaStatus = statusRow.createDiv({ cls: "notient-settings-status-item" });
    ollamaStatus.createSpan({ cls: `notient-settings-dot status-${health.ollama.status}` });
    ollamaStatus.createSpan({ text: "Ollama" });

    // LM Studio status
    const lmStatus = statusRow.createDiv({ cls: "notient-settings-status-item" });
    lmStatus.createSpan({ cls: `notient-settings-dot status-${health.lmstudio.status}` });
    lmStatus.createSpan({ text: "LM Studio" });

    // Index stats - only show if services are ready
    if (isReady) {
      const indexManager = this.kernel.getService<{ 
        getIndexedCount(): number;
        getActiveModelKey(): string;
      }>("indexManager");
      
      if (indexManager) {
        const count = indexManager.getIndexedCount();
        const indexStatus = statusRow.createDiv({ cls: "notient-settings-status-item" });
        indexStatus.createSpan({ text: `📊 ${count} notes indexed` });
      }
    } else if (this.kernel.isServicesInitializing) {
      const initStatus = statusRow.createDiv({ cls: "notient-settings-status-item" });
      initStatus.createSpan({ text: "⏳ Initializing..." });
    } else {
      const notReady = statusRow.createDiv({ cls: "notient-settings-status-item" });
      notReady.createSpan({ text: "⚠️ Run setup wizard" });
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
    const section = containerEl.createDiv({ cls: "notient-settings-section notient-index-management" });
    section.createEl("h2", { text: "Index Management" });

    const isReady = this.kernel.isServicesInitialized;

    const indexManager = isReady ? this.kernel.getService<{
      getIndexedCount(): number;
      getActiveModelKey(): string;
      listAvailableIndices(): string[];
      exportIndex(): Promise<string>;
      importIndex(json: string): Promise<{ modelKey: string; noteCount: number }>;
      trimIndex(): Promise<{ removed: number }>;
      deleteIndex(modelKey: string): Promise<boolean>;
    }>("indexManager") : null;

    // Info box showing current state
    const infoBox = section.createDiv({ cls: "notient-settings-info-box" });
    
    if (!isReady) {
      infoBox.createEl("div", { 
        text: this.kernel.isServicesInitializing 
          ? "⏳ Services initializing..." 
          : "⚠️ Services not ready. Complete setup wizard first.",
        cls: "notient-settings-info-dim" 
      });
    } else if (indexManager) {
      const activeKey = indexManager.getActiveModelKey() || "none";
      const noteCount = indexManager.getIndexedCount();
      
      infoBox.createEl("div", { text: `🔑 Active Index: ${activeKey}` });
      infoBox.createEl("div", { text: `📊 Notes: ${noteCount}`, cls: "notient-settings-info-dim" });

      const indices = indexManager.listAvailableIndices();
      if (indices.length > 1) {
        infoBox.createEl("div", {
          text: `📁 All indexes: ${indices.join(", ")}`,
          cls: "notient-settings-info-dim",
        });
      }
    } else {
      infoBox.createEl("div", { text: "No index data available", cls: "notient-settings-info-dim" });
    }

    // Actions section
    const actionsDiv = section.createDiv({ cls: "notient-settings-index-actions" });

    // Sync button
    new Setting(actionsDiv)
      .setName("Sync Index")
      .setDesc("Index new and changed notes")
      .addButton((btn) => btn.setButtonText("▶️ Sync").onClick(() => {
        (this.app as App & { commands: { executeCommandById: (id: string) => void } })
          .commands.executeCommandById("notient:reindex-vault");
      }));

    // Trim button
    new Setting(actionsDiv)
      .setName("Trim Stale Entries")
      .setDesc("Remove vectors for deleted notes")
      .addButton((btn) => btn.setButtonText("🧹 Trim").onClick(async () => {
        if (!indexManager) {
          this.kernel.obsidian.notice("Index manager not ready");
          return;
        }
        try {
          const result = await indexManager.trimIndex();
          this.kernel.obsidian.notice(`Removed ${result.removed} stale entries`);
          this.display();
        } catch (error) {
          this.kernel.obsidian.notice(`Trim failed: ${error}`);
        }
      }));

    // Export/Import row
    const ioDiv = section.createDiv({ cls: "notient-settings-index-io" });
    
    new Setting(ioDiv)
      .setName("Export")
      .setDesc("Backup to file")
      .addButton((btn) => btn.setButtonText("📤 Export").onClick(async () => {
        if (!indexManager) {
          this.kernel.obsidian.notice("Index manager not ready");
          return;
        }
        try {
          const json = await indexManager.exportIndex();
          const blob = new Blob([json], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `notient-index-${indexManager.getActiveModelKey()}-${Date.now()}.json`;
          a.click();
          URL.revokeObjectURL(url);
          this.kernel.obsidian.notice("Index exported");
        } catch (error) {
          this.kernel.obsidian.notice(`Export failed: ${error}`);
        }
      }));

    new Setting(ioDiv)
      .setName("Import")
      .setDesc("Load from backup")
      .addButton((btn) => btn.setButtonText("📥 Import").onClick(() => {
        if (!indexManager) {
          this.kernel.obsidian.notice("Index manager not ready");
          return;
        }
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";
        input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (!file) return;
          try {
            const text = await file.text();
            const result = await indexManager.importIndex(text);
            this.kernel.obsidian.notice(
              `Imported ${result.noteCount} notes for ${result.modelKey}`
            );
            this.display();
          } catch (error) {
            this.kernel.obsidian.notice(`Import failed: ${error}`);
          }
        };
        input.click();
      }));

    // Danger zone
    const dangerDiv = section.createDiv({ cls: "notient-settings-danger-zone" });
    dangerDiv.createEl("h4", { text: "⚠️ Danger Zone" });

    new Setting(dangerDiv)
      .setName("Rebuild Index")
      .setDesc("Clear and re-index everything from scratch")
      .addButton((btn) => btn.setButtonText("🔄 Rebuild").setWarning().onClick(() => {
        (this.app as App & { commands: { executeCommandById: (id: string) => void } })
          .commands.executeCommandById("notient:full-reindex");
      }));

    // Delete other indexes (if multiple exist)
    if (indexManager) {
      const indices = indexManager.listAvailableIndices();
      const activeKey = indexManager.getActiveModelKey();
      const otherIndices = indices.filter((k) => k !== activeKey);

      if (otherIndices.length > 0) {
        new Setting(dangerDiv)
          .setName("Delete Old Indexes")
          .setDesc(`Other indexes: ${otherIndices.join(", ")}`)
          .addButton((btn) => btn.setButtonText("🗑️ Delete All Old").setWarning().onClick(async () => {
            for (const key of otherIndices) {
              await indexManager.deleteIndex(key);
            }
            this.kernel.obsidian.notice(`Deleted ${otherIndices.length} old indexes`);
            this.display();
          }));
      }
    }
  }

  private renderParaSection(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({ cls: "notient-settings-section" });
    section.createEl("h2", { text: "IPARA Folder Mapping" });

    // Description
    const desc = section.createDiv({ cls: "notient-settings-para-desc" });
    desc.innerHTML = `
      <p>Map your vault folders to IPARA pillars. Each pillar can span <b>multiple folders</b> (comma-separated).</p>
      <p class="notient-settings-info-dim">Examples: <code>1-projects</code> or <code>1-projects/active, 4-archive/completed-projects</code></p>
      <p class="notient-settings-info-dim">Subfolders are automatically included when matching.</p>
    `;

    const paraTypes: Array<{ key: keyof NotientSettings["para"]; label: string; hint: string }> = [
      { key: "inbox", label: "📥 Inbox", hint: "Unsorted notes, daily captures" },
      { key: "projects", label: "🎯 Projects", hint: "Active work with deadlines" },
      { key: "areas", label: "🏠 Areas", hint: "Ongoing responsibilities" },
      { key: "resources", label: "📚 Resources", hint: "Reference material, knowledge" },
      { key: "archive", label: "📦 Archive", hint: "Completed/inactive items" },
    ];

    for (const { key, label, hint } of paraTypes) {
      new Setting(section)
        .setName(label)
        .setDesc(hint)
        .addText((text) =>
          text
            .setPlaceholder(`folder1, folder2/subfolder`)
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
          const indexMgr = this.kernel.getService<{ clearAll(): Promise<void> }>("indexManager");
          if (indexMgr) {
            await indexMgr.clearAll();
            this.kernel.obsidian.notice("All indexes cleared");
          }
        })
      );
  }
}
