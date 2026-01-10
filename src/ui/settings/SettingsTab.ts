/**
 * Settings management for Notient
 *
 * Features:
 * - Local/Network buttons with default IPs (always visible IP input)
 * - Model dimension auto-detected (read-only)
 * - Chunk size slider (32-8192) with performance tooltip
 * - Multi-index management
 */

import {
  type App,
  Notice,
  type Plugin,
  PluginSettingTab,
  Setting,
  debounce,
  setIcon,
} from "obsidian";
import type { NotientAgent } from "../../core/agent/agentLoop";
import type { ProfileManager } from "../../core/agent/profileManager";
import { MODEL_DEFAULTS } from "../../core/constants";
import type { Kernel } from "../../core/kernel";
import type { UserProfile } from "../../types/profile";
import {
  DEFAULT_SETTINGS,
  type NotientSettings,
  SETTINGS_VERSION,
  type SearchPreset,
  type SettingsError,
  type SettingsValidation,
  type SettingsWarning,
} from "../../types/settings";
import { ProfilePreviewModal } from "../modals/ProfilePreviewModal";
import { IndexManagementPanel } from "./panels/IndexManagementPanel";

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
 * Load settings from plugin data and validate
 */
export async function loadSettings(plugin: Plugin): Promise<NotientSettings> {
  const data = await plugin.loadData();

  if (!data) {
    return { ...DEFAULT_SETTINGS };
  }

  let settings = mergeWithDefaults(data);

  if (settings.version < SETTINGS_VERSION) {
    settings = migrateSettings(settings);
  }

  // Validate settings and log any issues
  const validation = validateSettings(settings);
  if (!validation.valid) {
    console.error("[Settings] Validation errors:", validation.errors);
  }
  if (validation.warnings.length > 0) {
    console.warn("[Settings] Validation warnings:", validation.warnings);
  }

  return settings;
}

/**
 * Save settings to plugin data with validation
 */
export async function saveSettings(plugin: Plugin, settings: NotientSettings): Promise<void> {
  // Validate before saving
  const validation = validateSettings(settings);
  if (!validation.valid) {
    console.error("[Settings] Validation errors:", validation.errors);
    // Show first error to user via Notice
    const firstError = validation.errors[0];
    new Notice(`Settings error: ${firstError.message}`, 5000);
  }
  if (validation.warnings.length > 0) {
    console.warn("[Settings] Validation warnings:", validation.warnings);
  }
  // Still save to avoid losing user data
  await plugin.saveData(settings);
}

function mergeWithDefaults(data: Partial<NotientSettings>): NotientSettings {
  return {
    version: data.version ?? DEFAULT_SETTINGS.version,
    ollama: { ...DEFAULT_SETTINGS.ollama, ...data.ollama },
    lmstudio: { ...DEFAULT_SETTINGS.lmstudio, ...data.lmstudio },
    indexing: {
      ...DEFAULT_SETTINGS.indexing,
      ...data.indexing,
      // activeIndexMeta is derived at runtime, don't persist stale values
      activeIndexMeta: null,
    },
    para: { ...DEFAULT_SETTINGS.para, ...data.para },
    ui: { ...DEFAULT_SETTINGS.ui, ...data.ui },
    search: { ...DEFAULT_SETTINGS.search, ...data.search },
    advanced: { ...DEFAULT_SETTINGS.advanced, ...data.advanced },
    setupComplete: data.setupComplete ?? DEFAULT_SETTINGS.setupComplete,
    // Phase 2 additions
    agent: {
      trustPolicy: {
        ...DEFAULT_SETTINGS.agent.trustPolicy,
        ...(data.agent?.trustPolicy ?? {}),
      },
      history: {
        ...DEFAULT_SETTINGS.agent.history,
        ...(data.agent?.history ?? {}),
      },
      bulk: {
        ...DEFAULT_SETTINGS.agent.bulk,
        ...(data.agent?.bulk ?? {}),
      },
    },
    chatRetention: {
      ...DEFAULT_SETTINGS.chatRetention,
      ...(data.chatRetention ?? {}),
    },
  };
}

function migrateSettings(settings: NotientSettings): NotientSettings {
  const migrated = { ...settings };
  migrated.version = SETTINGS_VERSION;
  return migrated;
}

/**
 * Validate URL format (http:// or https:// with host and optional port)
 */
function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateSettings(settings: NotientSettings): SettingsValidation {
  const errors: SettingsError[] = [];
  const warnings: SettingsWarning[] = [];

  // Ollama validation
  if (settings.ollama.enabled) {
    if (!settings.ollama.host) {
      errors.push({ field: "ollama.host", message: "Ollama host is required" });
    } else if (!isValidUrl(settings.ollama.host)) {
      errors.push({
        field: "ollama.host",
        message: "Invalid URL format (expected http://host:port)",
      });
    }
    if (!settings.ollama.embeddingModel || settings.ollama.embeddingModel.trim() === "") {
      warnings.push({
        field: "ollama.embeddingModel",
        message: "No embedding model selected",
      });
    }
  }

  // LM Studio validation
  if (settings.lmstudio.enabled) {
    if (!settings.lmstudio.host) {
      errors.push({ field: "lmstudio.host", message: "LM Studio host is required" });
    } else if (!isValidUrl(settings.lmstudio.host)) {
      errors.push({
        field: "lmstudio.host",
        message: "Invalid URL format (expected http://host:port)",
      });
    }
    if (!settings.lmstudio.reasoningModel || settings.lmstudio.reasoningModel.trim() === "") {
      warnings.push({
        field: "lmstudio.reasoningModel",
        message: "No reasoning model selected",
      });
    }
  }

  // Indexing validation
  if (settings.indexing.chunkSize < 32) {
    errors.push({
      field: "indexing.chunkSize",
      message: "Chunk size must be at least 32 characters",
    });
  }
  if (settings.indexing.chunkSize > 8192) {
    errors.push({
      field: "indexing.chunkSize",
      message: "Chunk size must be at most 8192 characters",
    });
  }

  // Agent history validation
  if (settings.agent.history.maxEntries < 1) {
    errors.push({
      field: "agent.history.maxEntries",
      message: "Max history entries must be positive",
    });
  }
  if (settings.agent.history.maxAgeDays < 1) {
    errors.push({
      field: "agent.history.maxAgeDays",
      message: "Max history age must be at least 1 day",
    });
  }

  // Chat retention validation
  if (settings.chatRetention.maxMessagesPerNote < 1) {
    errors.push({
      field: "chatRetention.maxMessagesPerNote",
      message: "Max messages per note must be positive",
    });
  }
  if (settings.chatRetention.maxAgeDays < 1) {
    errors.push({
      field: "chatRetention.maxAgeDays",
      message: "Chat retention must be at least 1 day",
    });
  }

  // Bulk workflow validation
  if (settings.agent.bulk.maxNotesPerWorkflow < 1) {
    errors.push({
      field: "agent.bulk.maxNotesPerWorkflow",
      message: "Max notes per workflow must be positive",
    });
  }
  if (settings.agent.bulk.delayBetweenTasksMs < 0) {
    errors.push({
      field: "agent.bulk.delayBetweenTasksMs",
      message: "Delay between tasks cannot be negative",
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
  private onSettingsChange: (settings: NotientSettings, changedFields?: string[]) => Promise<void>;

  // Network configs per service
  private ollamaConfig: ServiceNetworkConfig = {
    ip: DEFAULT_IPS.ollama.local,
    port: DEFAULT_PORTS.ollama,
  };
  private lmstudioConfig: ServiceNetworkConfig = {
    ip: DEFAULT_IPS.lmstudio.local,
    port: DEFAULT_PORTS.lmstudio,
  };

  // Track original embedding model
  private originalEmbeddingModel = "";

  // Available models from services
  private ollamaModels: string[] = [];
  private lmstudioModels: string[] = [];
  private modelsFetched = { ollama: false, lmstudio: false };

  // Extracted panel component
  private indexManagementPanel: IndexManagementPanel | null = null;

  constructor(
    app: App,
    plugin: Plugin,
    kernel: Kernel,
    settings: NotientSettings,
    onSettingsChange: (settings: NotientSettings, changedFields?: string[]) => Promise<void>,
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

  private getModelDimension(_modelName: string): number | null {
    // Dimensions are discovered at runtime via OllamaService.discoverCapabilities()
    // Return null here - actual dimension shown after service initializes
    return null;
  }

  /**
   * Fetch available models from Ollama
   */
  private async fetchOllamaModels(): Promise<string[]> {
    try {
      const host = this.buildHost(this.ollamaConfig);
      const response = await fetch(`${host}/api/tags`, { method: "GET" });
      if (!response.ok) return [];
      const data = await response.json();
      return (data.models || []).map((m: { name: string }) => m.name);
    } catch {
      return [];
    }
  }

  /**
   * Fetch available models from LM Studio (OpenAI-compatible endpoint)
   */
  private async fetchLMStudioModels(): Promise<string[]> {
    try {
      const host = this.buildHost(this.lmstudioConfig);
      const response = await fetch(`${host}/v1/models`, { method: "GET" });
      if (!response.ok) return [];
      const data = await response.json();
      return (data.data || []).map((m: { id: string }) => m.id);
    } catch {
      return [];
    }
  }

  /**
   * Refresh models for a service
   */
  private async refreshModels(service: "ollama" | "lmstudio"): Promise<void> {
    if (service === "ollama") {
      this.ollamaModels = await this.fetchOllamaModels();
      this.modelsFetched.ollama = true;
    } else {
      this.lmstudioModels = await this.fetchLMStudioModels();
      this.modelsFetched.lmstudio = true;
    }
  }

  /**
   * Auto-fetch models on first display (non-blocking)
   */
  private autoFetchModels(): void {
    // Fetch Ollama models if not already fetched
    if (!this.modelsFetched.ollama && this.settings.ollama.host) {
      this.fetchOllamaModels().then((models) => {
        if (models.length > 0 && !this.modelsFetched.ollama) {
          this.ollamaModels = models;
          this.modelsFetched.ollama = true;
          this.display(); // Re-render with dropdown
        }
      });
    }
    // Fetch LM Studio models if not already fetched
    if (!this.modelsFetched.lmstudio && this.settings.lmstudio.host) {
      this.fetchLMStudioModels().then((models) => {
        if (models.length > 0 && !this.modelsFetched.lmstudio) {
          this.lmstudioModels = models;
          this.modelsFetched.lmstudio = true;
          this.display(); // Re-render with dropdown
        }
      });
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("notient-settings");

    try {
      containerEl.createEl("h1", { text: "Notient Settings" });

      // Auto-fetch disabled pending agent redesign
      // this.autoFetchModels();

      this.renderConnectionStatus(containerEl);

      this.renderServiceSection(
        containerEl,
        "ollama",
        "Embeddings (Ollama)",
        "database",
        "Embedding Model",
        "nomic-embed-text",
      );

      this.renderServiceSection(
        containerEl,
        "lmstudio",
        "Chat (LM Studio)",
        "message-square",
        "Reasoning Model",
        "ministral-3b-instruct",
      );

      this.renderIndexingSection(containerEl);

      this.indexManagementPanel = new IndexManagementPanel(this.app, this.kernel, this.settings, () =>
        this.display(),
      );
      this.indexManagementPanel.render(containerEl);

      this.renderSearchSection(containerEl);
      this.renderIdentitySection(containerEl);
      this.renderParaSection(containerEl);
      this.renderAdvancedSection(containerEl);
    } catch (error) {
      console.error("[Notient Settings] Display error:", error);
      containerEl.createEl("p", {
        text: `Settings error: ${error instanceof Error ? error.message : String(error)}`,
        cls: "notient-settings-error",
      });
    }
  }

  private renderSearchSection(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({ cls: "notient-settings-section" });
    const header = section.createEl("h2", { cls: "notient-settings-header" });
    const iconEl = header.createSpan({ cls: "notient-settings-header-icon" });
    setIcon(iconEl, "search");
    header.createSpan({ text: "Search Configuration" });

    // Preset dropdown
    new Setting(section)
      .setName("Search Mode")
      .setDesc("Balance between speed and accuracy")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("quick", "Quick — Fast, no AI rerank")
          .addOption("balanced", "Balanced (Recommended)")
          .addOption("thorough", "Thorough — Deep search")
          .addOption("custom", "Custom...")
          .setValue(this.settings.search.preset)
          .onChange(async (value: string) => {
            this.settings.search.preset = value as SearchPreset;
            await this.onSettingsChange(this.settings);
            this.display(); // Re-render to show/hide custom options
          });
      });

    // Show custom sliders only when preset === 'custom'
    if (this.settings.search.preset === "custom") {
      this.renderCustomSearchSettings(section);
    }
  }

  private renderCustomSearchSettings(containerEl: HTMLElement): void {
    const customDiv = containerEl.createDiv({ cls: "notient-settings-custom-search" });

    // Top-K slider
    new Setting(customDiv)
      .setName("Result Count")
      .setDesc("Number of notes to retrieve (Top-K)")
      .addSlider((slider) => {
        slider
          .setLimits(1, 50, 1)
          .setValue(this.settings.search.custom.topK)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.settings.search.custom.topK = value;
            await this.onSettingsChange(this.settings);
          });
      });

    // Reranking toggle
    new Setting(customDiv)
      .setName("AI Reranking")
      .setDesc("Use LM Studio to reorder results by relevance")
      .addToggle((toggle) => {
        toggle.setValue(this.settings.search.custom.enableReranking).onChange(async (value) => {
          this.settings.search.custom.enableReranking = value;
          await this.onSettingsChange(this.settings);
        });
      });

    // Min score slider
    new Setting(customDiv)
      .setName("Minimum Similarity")
      .setDesc("Filter out unrelated results (0.0 - 1.0)")
      .addSlider((slider) => {
        slider
          .setLimits(0, 1, 0.05)
          .setValue(this.settings.search.custom.minScore)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.settings.search.custom.minScore = value;
            await this.onSettingsChange(this.settings);
          });
      });
  }

  private renderConnectionStatus(containerEl: HTMLElement): void {
    const health = this.kernel.serviceHealth;
    const caps = this.kernel.capabilities;
    const isReady = this.kernel.isServicesInitialized;

    const statusBox = containerEl.createDiv({ cls: "notient-settings-status-box" });

    // Service status row
    const statusRow = statusBox.createDiv({ cls: "notient-settings-status-row" });

    // Ollama status
    const ollamaStatus = statusRow.createDiv({ cls: "notient-settings-status-item" });
    ollamaStatus.createSpan({ cls: `notient-settings-dot status-${health.ollama.status}` });
    ollamaStatus.createSpan({ text: "Ollama" });
    if (caps.embedding) {
      ollamaStatus.createSpan({ text: "(embeddings)", cls: "notient-settings-cap" });
    }

    // LM Studio status
    const lmStatus = statusRow.createDiv({ cls: "notient-settings-status-item" });
    lmStatus.createSpan({ cls: `notient-settings-dot status-${health.lmstudio.status}` });
    lmStatus.createSpan({ text: "LM Studio" });
    if (caps.reasoning) {
      lmStatus.createSpan({ text: "(chat + rerank)", cls: "notient-settings-cap" });
    }

    // Capabilities row
    const capRow = statusBox.createDiv({ cls: "notient-settings-cap-row" });

    // Index stats
    if (isReady) {
      const indexManager = this.kernel.getService<{
        getIndexedCount(): number;
        getActiveModelKey(): string;
      }>("indexManager");

      if (indexManager) {
        const count = indexManager.getIndexedCount();
        const model = indexManager.getActiveModelKey();
        const statsEl = capRow.createSpan({ cls: "notient-settings-stats" });
        const statsIcon = statsEl.createSpan({ cls: "notient-settings-stats-icon" });
        setIcon(statsIcon, "bar-chart-2");
        statsEl.createSpan({ text: `${count} notes ready for search` });
        if (model) {
          capRow.createSpan({ text: `(${model})`, cls: "notient-settings-model-tag" });
        }
      }

      // Show capability icons
      const capIcons = capRow.createDiv({ cls: "notient-settings-cap-icons" });
      if (caps.search) {
        const searchIcon = capIcons.createSpan({
          cls: "notient-settings-cap-icon",
          attr: { title: "Search ready" },
        });
        setIcon(searchIcon, "search");
      }
      if (caps.reasoning) {
        const chatIcon = capIcons.createSpan({
          cls: "notient-settings-cap-icon",
          attr: { title: "Chat & rerank ready" },
        });
        setIcon(chatIcon, "bot");
      }
      if (caps.indexing) {
        const indexIcon = capIcons.createSpan({
          cls: "notient-settings-cap-icon",
          attr: { title: "Indexing available" },
        });
        setIcon(indexIcon, "file-text");
      }
    } else if (this.kernel.isServicesInitializing) {
      const initEl = capRow.createSpan({ cls: "notient-settings-info-dim notient-settings-init" });
      const spinnerIcon = initEl.createSpan({ cls: "notient-settings-spinner" });
      setIcon(spinnerIcon, "loader-2");
      initEl.createSpan({ text: "Connecting to your AI..." });
    } else {
      const warnEl = capRow.createSpan({ cls: "notient-settings-warning" });
      const warnIcon = warnEl.createSpan({ cls: "notient-settings-warning-icon" });
      setIcon(warnIcon, "alert-triangle");
      warnEl.createSpan({ text: "Run the setup wizard to get started" });
    }

    // Add Reconnect button when services are ready or failed
    if (isReady || (!this.kernel.isServicesInitializing && this.settings.setupComplete)) {
      const actionRow = statusBox.createDiv({ cls: "notient-settings-action-row" });
      const reconnectBtn = actionRow.createEl("button", { cls: "notient-settings-reconnect-btn" });
      const reconnectIcon = reconnectBtn.createSpan({ cls: "notient-settings-btn-icon" });
      setIcon(reconnectIcon, "refresh-cw");
      reconnectBtn.createSpan({ text: "Reconnect Services" });
      reconnectBtn.addEventListener("click", async () => {
        reconnectBtn.disabled = true;
        reconnectBtn.empty();
        const spinnerIcon = reconnectBtn.createSpan({ cls: "notient-settings-spinner" });
        setIcon(spinnerIcon, "loader-2");
        reconnectBtn.createSpan({ text: "Reconnecting..." });
        await this.onSettingsChange(this.settings, ["ollama.host", "lmstudio.host"]);
        setTimeout(() => this.display(), 2000);
      });
    }
  }

  private renderServiceSection(
    containerEl: HTMLElement,
    service: "ollama" | "lmstudio",
    title: string,
    iconName: string,
    modelLabel: string,
    modelPlaceholder: string,
  ): void {
    const config = service === "ollama" ? this.ollamaConfig : this.lmstudioConfig;
    const section = containerEl.createDiv({ cls: "notient-settings-section" });
    const header = section.createEl("h2", { cls: "notient-settings-header" });
    const iconEl = header.createSpan({ cls: "notient-settings-header-icon" });
    setIcon(iconEl, iconName);
    header.createSpan({ text: title });

    // Local/Network toggle buttons
    const toggleRow = section.createDiv({ cls: "notient-settings-toggle-row" });
    const toggle = toggleRow.createDiv({ cls: "notient-settings-toggle" });

    const localBtn = toggle.createEl("button", {
      cls: `notient-settings-toggle-btn ${this.isLocalIP(config.ip, service) ? "active" : ""}`,
    });
    const localIcon = localBtn.createSpan({ cls: "notient-settings-toggle-icon" });
    setIcon(localIcon, "home");
    localBtn.createSpan({ text: "Local" });
    localBtn.addEventListener("click", async () => {
      config.ip = DEFAULT_IPS[service].local;
      await this.updateServiceHost(service);
      this.display();
    });

    const networkBtn = toggle.createEl("button", {
      cls: `notient-settings-toggle-btn ${config.ip === DEFAULT_IPS[service].network ? "active" : ""}`,
    });
    const networkIcon = networkBtn.createSpan({ cls: "notient-settings-toggle-icon" });
    setIcon(networkIcon, "wifi");
    networkBtn.createSpan({ text: "Network" });
    networkBtn.addEventListener("click", async () => {
      config.ip = DEFAULT_IPS[service].network;
      await this.updateServiceHost(service);
      this.display();
    });

    // Host input (IP + port)
    new Setting(section)
      .setName("Host")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_IPS[service].network)
          .setValue(config.ip)
          .onChange(
            debounce(
              async (value) => {
                config.ip = value.trim() || DEFAULT_IPS[service].local;
                await this.updateServiceHost(service);
              },
              500,
              true,
            ),
          ),
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_PORTS[service])
          .setValue(config.port)
          .onChange(
            debounce(
              async (value) => {
                config.port = value.trim() || DEFAULT_PORTS[service];
                await this.updateServiceHost(service);
              },
              500,
              true,
            ),
          ),
      );

    // Model setting with dropdown + refresh
    this.renderModelSetting(section, service, modelLabel, modelPlaceholder);
  }

  private renderModelSetting(
    section: HTMLElement,
    service: "ollama" | "lmstudio",
    modelLabel: string,
    modelPlaceholder: string,
  ): void {
    const models = service === "ollama" ? this.ollamaModels : this.lmstudioModels;
    const currentModel =
      service === "ollama"
        ? this.settings.ollama.embeddingModel
        : this.settings.lmstudio.reasoningModel;
    const changedField = service === "ollama" ? "ollama.embeddingModel" : "lmstudio.reasoningModel";

    // Build description
    let desc = "";
    if (service === "ollama") {
      const dim = this.getModelDimension(currentModel);
      desc = dim ? `Embedding size: ${dim} dimensions` : "Size will be detected when you start";
    }

    const setting = new Setting(section).setName(modelLabel).setDesc(desc);

    // Add dropdown if we have models, otherwise text input
    if (models.length > 0) {
      setting.addDropdown((dropdown) => {
        // Add current value if not in list
        if (currentModel && !models.includes(currentModel)) {
          dropdown.addOption(currentModel, `${currentModel} (current)`);
        }
        // Add all fetched models
        for (const model of models) {
          dropdown.addOption(model, model);
        }
        dropdown.setValue(currentModel).onChange(async (value) => {
          if (service === "ollama") {
            this.settings.ollama.embeddingModel = value;
          } else {
            this.settings.lmstudio.reasoningModel = value;
          }
          await this.onSettingsChange(this.settings, [changedField]);
          this.display();
        });
      });
    } else {
      // Fall back to text input
      setting.addText((text) =>
        text
          .setPlaceholder(modelPlaceholder)
          .setValue(currentModel)
          .onChange(async (value) => {
            if (service === "ollama") {
              this.settings.ollama.embeddingModel = value;
            } else {
              this.settings.lmstudio.reasoningModel = value;
            }
            await this.onSettingsChange(this.settings, [changedField]);
            if (service === "ollama") this.display();
          }),
      );
    }

    // Add refresh button
    setting.addExtraButton((btn) =>
      btn
        .setIcon("refresh-cw")
        .setTooltip("Refresh available models")
        .onClick(async () => {
          btn.setDisabled(true);
          await this.refreshModels(service);
          btn.setDisabled(false);
          this.display();
        }),
    );

    // Model change notice for Ollama (embedding model change requires new index)
    if (
      service === "ollama" &&
      this.originalEmbeddingModel &&
      currentModel !== this.originalEmbeddingModel
    ) {
      const notice = section.createDiv({ cls: "notient-settings-notice" });
      notice.innerHTML = `ℹ️ New index for <b>${currentModel}</b>. <b>${this.originalEmbeddingModel}</b> preserved.`;
    }
  }

  private async updateServiceHost(service: "ollama" | "lmstudio"): Promise<void> {
    const config = service === "ollama" ? this.ollamaConfig : this.lmstudioConfig;
    this.settings[service].host = this.buildHost(config);
    const changedField = service === "ollama" ? "ollama.host" : "lmstudio.host";
    // Clear cached models when host changes
    if (service === "ollama") {
      this.ollamaModels = [];
      this.modelsFetched.ollama = false;
    } else {
      this.lmstudioModels = [];
      this.modelsFetched.lmstudio = false;
    }
    await this.onSettingsChange(this.settings, [changedField]);
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
      const value = Number.parseInt((e.target as HTMLInputElement).value, 10);
      sliderValue.textContent = `${value} chars`;
    });

    // Track original chunk size to detect changes
    const originalChunkSize = this.settings.indexing.chunkSize;

    slider.addEventListener("change", async (e) => {
      const newChunkSize = Number.parseInt((e.target as HTMLInputElement).value, 10);
      this.settings.indexing.chunkSize = newChunkSize;
      await this.onSettingsChange(this.settings);

      // Warn user that changing chunk size requires reindexing
      if (newChunkSize !== originalChunkSize) {
        new Notice(
          "Chunk size changed. Existing embeddings are now invalid. Please run a full reindex to apply the new chunk size.",
          8000,
        );
      }
    });

    // Tooltip
    const tooltip = sliderSection.createDiv({ cls: "notient-settings-tooltip" });
    tooltip.innerHTML = `
      <span class="notient-tooltip-small">Smaller passages</span> = precise search
      <span class="notient-tooltip-sep">|</span>
      <span class="notient-tooltip-large">Larger</span> = more context
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
          }),
      );
  }

  private renderIdentitySection(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({ cls: "notient-settings-section" });
    const header = section.createEl("h2", { cls: "notient-settings-header" });
    const iconEl = header.createSpan({ cls: "notient-settings-header-icon" });
    setIcon(iconEl, "user");
    header.createSpan({ text: "Identity" });

    // Description
    section.createEl("p", {
      text: "Configure Notient's persona and domain expertise. Profile influences prompts silently (no UI badges).",
      cls: "setting-item-description",
    });

    // Get profile manager if available
    const profileManager = this.kernel.getService<ProfileManager>("profileManager");

    // Show current profile status
    this.renderCurrentProfileStatus(section, profileManager);

    // Generate from Vault button
    new Setting(section)
      .setName("Generate Profile")
      .setDesc("Analyze your vault to detect your domain expertise")
      .addButton((button) =>
        button.setButtonText("Generate from Vault").onClick(async () => {
          if (!profileManager) {
            new Notice("Profile manager not available. Complete setup first.");
            return;
          }

          // Check if index exists
          const indexManager = this.kernel.getService<{
            getIndexedCount(): number;
          }>("indexManager");

          if (!indexManager || indexManager.getIndexedCount() === 0) {
            new Notice("Please build the vault index first (Settings > Index > Rebuild)");
            return;
          }

          // Show loading state
          button.setDisabled(true);
          button.setButtonText("Analyzing vault...");

          try {
            // Run inference with progress callback
            const profile = await profileManager.infer((status, message) => {
              button.setButtonText(message);
            });

            // Show preview modal
            const modal = new ProfilePreviewModal(this.app, profile);
            const editedProfile = await modal.run();

            if (editedProfile) {
              await profileManager.save(editedProfile);
              this.propagateProfileToAgent(editedProfile); // Update agent prompts
              new Notice("Profile saved successfully");
              this.display(); // Refresh settings
            }
          } catch (error) {
            new Notice(`Profile generation failed: ${(error as Error).message}`);
          } finally {
            button.setDisabled(false);
            button.setButtonText("Generate from Vault");
          }
        }),
      );

    // Manual edit section (show if profile exists)
    this.renderManualProfileEdit(section, profileManager);

    // Reset button
    new Setting(section)
      .setName("Reset Profile")
      .setDesc("Clear all profile data and use generic Notient identity")
      .addButton((button) =>
        button
          .setButtonText("Reset")
          .setWarning()
          .onClick(async () => {
            if (!profileManager) {
              new Notice("Profile manager not available");
              return;
            }

            const hasProfile = await profileManager.exists();
            if (!hasProfile) {
              new Notice("No profile to reset");
              return;
            }

            // Confirm reset
            if (confirm("Are you sure? This will delete your profile.")) {
              await profileManager.reset();
              this.propagateProfileToAgent(undefined); // Clear agent profile
              new Notice("Profile reset");
              this.display(); // Refresh settings
            }
          }),
      );
  }

  private renderCurrentProfileStatus(
    containerEl: HTMLElement,
    profileManager: ProfileManager | null,
  ): void {
    const statusDiv = containerEl.createDiv({ cls: "notient-profile-status" });

    if (!profileManager) {
      statusDiv.createEl("p", {
        text: "⚠️ Profile manager not initialized. Complete setup first.",
        cls: "notient-settings-warning",
      });
      return;
    }

    const profile = profileManager.get();

    if (profile?.domain?.primary) {
      const statusBox = statusDiv.createDiv({ cls: "notient-profile-current" });
      statusBox.createEl("strong", { text: "Current Profile: " });
      statusBox.createSpan({ text: profile.domain.primary });

      if (profile.domain.secondary?.length) {
        statusBox.createEl("br");
        statusBox.createEl("small", {
          text: `Related: ${profile.domain.secondary.join(", ")}`,
          cls: "notient-settings-info-dim",
        });
      }
    } else {
      statusDiv.createEl("p", {
        text: "No profile configured. Generate from vault or enter manually.",
        cls: "notient-settings-info-dim",
      });
    }
  }

  private renderManualProfileEdit(
    containerEl: HTMLElement,
    profileManager: ProfileManager | null,
  ): void {
    if (!profileManager) return;

    const profile = profileManager.get();
    const editDiv = containerEl.createDiv({ cls: "notient-profile-manual-edit" });

    editDiv.createEl("h4", { text: "Manual Configuration" });

    // Primary domain
    new Setting(editDiv)
      .setName("Primary Domain")
      .setDesc("Your main field of expertise")
      .addText((text) =>
        text
          .setPlaceholder("e.g., High-Performance Computing")
          .setValue(profile?.domain?.primary || "")
          .onChange(
            debounce(
              async (value) => {
                await this.updateProfileField(profileManager, "domain.primary", value);
              },
              1000,
              true,
            ),
          ),
      );

    // Secondary domains
    new Setting(editDiv)
      .setName("Secondary Domains")
      .setDesc("Related fields (comma-separated)")
      .addText((text) =>
        text
          .setPlaceholder("e.g., AI/ML, Distributed Systems")
          .setValue(profile?.domain?.secondary?.join(", ") || "")
          .onChange(
            debounce(
              async (value) => {
                const values = value
                  .split(",")
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0);
                await this.updateProfileField(profileManager, "domain.secondary", values);
              },
              1000,
              true,
            ),
          ),
      );

    // Keywords
    new Setting(editDiv)
      .setName("Domain Keywords")
      .setDesc("Key concepts in your field (comma-separated)")
      .addText((text) =>
        text
          .setPlaceholder("e.g., NSF grants, supercomputing, MPI")
          .setValue(profile?.domain?.keywords?.join(", ") || "")
          .onChange(
            debounce(
              async (value) => {
                const values = value
                  .split(",")
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0);
                await this.updateProfileField(profileManager, "domain.keywords", values);
              },
              1000,
              true,
            ),
          ),
      );
  }

  private async updateProfileField(
    profileManager: ProfileManager,
    path: string,
    value: string | string[],
  ): Promise<void> {
    try {
      let profile = profileManager.get();

      // Create empty profile if none exists
      if (!profile) {
        profile = {
          version: "1.0",
          domain: { primary: "" },
          para: { projects: [], areas: [], resources: [], archives: [] },
        };
      }

      // Update the specific field
      const parts = path.split(".");
      // biome-ignore lint/suspicious/noExplicitAny: Dynamic field access
      let target: any = profile;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!target[parts[i]]) {
          target[parts[i]] = {};
        }
        target = target[parts[i]];
      }
      target[parts[parts.length - 1]] = value;

      await profileManager.save(profile);

      // Propagate profile change to agent for prompt personalization
      this.propagateProfileToAgent(profile);
    } catch (error) {
      console.error("[Settings] Failed to update profile field:", error);
    }
  }

  /**
   * Propagate profile changes to the NotientAgent
   * Ensures the agent uses the latest profile for prompt generation
   */
  private propagateProfileToAgent(profile: UserProfile | undefined): void {
    const agent = this.kernel.getService<NotientAgent>("agent");
    if (agent) {
      agent.setProfile(profile);
    }
  }

  private renderParaSection(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({ cls: "notient-settings-section" });
    const header = section.createEl("h2", { cls: "notient-settings-header" });
    const iconEl = header.createSpan({ cls: "notient-settings-header-icon" });
    setIcon(iconEl, "folder-tree");
    header.createSpan({ text: "IPARA Folder Mapping" });

    // Description
    const desc = section.createDiv({ cls: "notient-settings-para-desc" });
    desc.innerHTML = `
      <p>Map your vault folders to IPARA pillars. Each pillar can span <b>multiple folders</b> (comma-separated).</p>
      <p class="notient-settings-info-dim">Examples: <code>1-projects</code> or <code>1-projects/active, 4-archive/completed-projects</code></p>
      <p class="notient-settings-info-dim">Subfolders are automatically included when matching.</p>
    `;

    const paraTypes: Array<{
      key: keyof NotientSettings["para"];
      label: string;
      icon: string;
      hint: string;
    }> = [
      { key: "inbox", label: "Inbox", icon: "inbox", hint: "Unsorted notes, daily captures" },
      { key: "projects", label: "Projects", icon: "target", hint: "Active work with deadlines" },
      { key: "areas", label: "Areas", icon: "home", hint: "Ongoing responsibilities" },
      {
        key: "resources",
        label: "Resources",
        icon: "book-open",
        hint: "Reference material, knowledge",
      },
      { key: "archive", label: "Archive", icon: "archive", hint: "Completed/inactive items" },
    ];

    for (const { key, label, icon, hint } of paraTypes) {
      const setting = new Setting(section).setDesc(hint);
      // Add icon to name
      const nameEl = setting.nameEl;
      const iconSpan = nameEl.createSpan({ cls: "notient-settings-para-icon" });
      setIcon(iconSpan, icon);
      nameEl.createSpan({ text: label });
      setting.addText((text) =>
        text
          .setPlaceholder("folder1, folder2/subfolder")
          .setValue(this.settings.para[key].join(", "))
          .onChange(async (value) => {
            this.settings.para[key] = value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.onSettingsChange(this.settings);
          }),
      );
    }
  }

  private renderAdvancedSection(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({ cls: "notient-settings-section" });
    const header = section.createEl("h2", { cls: "notient-settings-header" });
    const iconEl = header.createSpan({ cls: "notient-settings-header-icon" });
    setIcon(iconEl, "settings-2");
    header.createSpan({ text: "Advanced" });

    new Setting(section).setName("Debug logging").addToggle((toggle) =>
      toggle.setValue(this.settings.advanced.debugLogging).onChange(async (value) => {
        this.settings.advanced.debugLogging = value;
        await this.onSettingsChange(this.settings);
      }),
    );

    new Setting(section).setName("Run setup wizard").addButton((btn) =>
      btn.setButtonText("Open").onClick(() => {
        (
          this.app as App & { commands: { executeCommandById: (id: string) => void } }
        ).commands.executeCommandById("notient:run-setup");
      }),
    );

    new Setting(section)
      .setName("Full reindex")
      .setDesc("Rebuild current index")
      .addButton((btn) =>
        btn
          .setButtonText("Reindex")
          .setWarning()
          .onClick(() => {
            (
              this.app as App & { commands: { executeCommandById: (id: string) => void } }
            ).commands.executeCommandById("notient:full-reindex");
          }),
      );

    new Setting(section)
      .setName("Clear all indexes")
      .setDesc("Delete ALL data")
      .addButton((btn) =>
        btn
          .setButtonText("Clear All")
          .setWarning()
          .onClick(async () => {
            const indexMgr = this.kernel.getService<{ clearAll(): Promise<void> }>("indexManager");
            if (indexMgr) {
              await indexMgr.clearAll();
              this.kernel.obsidian.notice("All indexes cleared");
            }
          }),
      );
  }
}
