/**
 * Setup Wizard Modal - Comprehensive Configuration
 *
 * Features:
 * - SEPARATE network toggles per service with default IPs
 * - IP always visible, auto-populated by Local/Network buttons
 * - Model dimension auto-detected (read-only)
 * - Chunk size slider (32-8192) with performance/accuracy tooltip
 */

import { Modal, App, debounce } from "obsidian";
import type { NotientSettings } from "../types/settings";
import type { HealthMonitor } from "../services/healthMonitor";
import type { AvailableModel } from "../types/services";
import { MODEL_DEFAULTS } from "../core/constants";

export interface SetupWizardResult {
  completed: boolean;
  settings: Partial<NotientSettings>;
}

type ConnectionStatus = "idle" | "checking" | "connected" | "error";

// Default IPs per service
const DEFAULT_IPS = {
  ollama: { local: "localhost", network: "192.168.86.249" },
  lmstudio: { local: "127.0.0.1", network: "192.168.86.249" },
};

const DEFAULT_PORTS = {
  ollama: "11434",
  lmstudio: "1234",
};

interface ServiceConfig {
  ip: string;
  port: string;
  status: ConnectionStatus;
  error: string;
  models: AvailableModel[];
  selectedModel: string;
}

interface VaultStats {
  noteCount: number;
  folderCount: number;
  totalSizeKB: number;
  estimatedIndexTimeMin: number;
}

interface ExistingIndex {
  modelKey: string;
  noteCount: number;
  lastIndexed: number | null;
}

export class SetupWizardModal extends Modal {
  private result: SetupWizardResult = { completed: false, settings: {} };
  private resolvePromise: ((result: SetupWizardResult) => void) | null = null;

  // Service configurations
  private ollama: ServiceConfig = {
    ip: DEFAULT_IPS.ollama.local,
    port: DEFAULT_PORTS.ollama,
    status: "idle",
    error: "",
    models: [],
    selectedModel: "",
  };

  private lmstudio: ServiceConfig = {
    ip: DEFAULT_IPS.lmstudio.local,
    port: DEFAULT_PORTS.lmstudio,
    status: "idle",
    error: "",
    models: [],
    selectedModel: "",
  };

  // Chunk size (slider)
  private chunkSize: number = 1500;

  // Vault configuration
  private excludedFolders: string = ".obsidian, .trash, templates";

  // Existing indexes (multi-index support)
  private existingIndexes: ExistingIndex[] = [];
  private currentIndexModel: string | null = null;

  // Vault stats
  private vaultStats: VaultStats | null = null;

  // Debounced check functions
  private debouncedCheckOllama = debounce(() => this.checkOllama(), 500, true);
  private debouncedCheckLMStudio = debounce(() => this.checkLMStudio(), 500, true);

  constructor(
    app: App,
    private healthMonitor: HealthMonitor,
    private currentSettings: NotientSettings
  ) {
    super(app);
    this.initializeFromSettings();
    this.computeVaultStats();
    this.detectExistingIndexes();
  }

  private initializeFromSettings(): void {
    // Parse Ollama host
    const ollamaHost = this.currentSettings.ollama.host;
    const ollamaMatch = ollamaHost.match(/https?:\/\/([^:]+):?(\d+)?/);
    if (ollamaMatch) {
      this.ollama.ip = ollamaMatch[1];
      if (ollamaMatch[2]) this.ollama.port = ollamaMatch[2];
    }

    // Parse LM Studio host
    const lmHost = this.currentSettings.lmstudio.host;
    const lmMatch = lmHost.match(/https?:\/\/([^:]+):?(\d+)?/);
    if (lmMatch) {
      this.lmstudio.ip = lmMatch[1];
      if (lmMatch[2]) this.lmstudio.port = lmMatch[2];
    }

    this.ollama.selectedModel = this.currentSettings.ollama.embeddingModel;
    this.lmstudio.selectedModel = this.currentSettings.lmstudio.reasoningModel;

    this.excludedFolders = this.currentSettings.indexing.excludedFolders.join(", ");
    this.chunkSize = this.currentSettings.indexing.chunkSize;
  }

  private computeVaultStats(): void {
    const files = this.app.vault.getMarkdownFiles();
    const folders = new Set<string>();
    let totalSize = 0;

    for (const file of files) {
      totalSize += file.stat.size;
      const folder = file.parent?.path;
      if (folder) folders.add(folder);
    }

    this.vaultStats = {
      noteCount: files.length,
      folderCount: folders.size,
      totalSizeKB: Math.round(totalSize / 1024),
      estimatedIndexTimeMin: Math.max(1, Math.round(files.length / 200)),
    };
  }

  private detectExistingIndexes(): void {
    if (this.currentSettings.setupComplete && this.currentSettings.ollama.embeddingModel) {
      this.currentIndexModel = this.currentSettings.ollama.embeddingModel;
      this.existingIndexes = [{
        modelKey: this.currentSettings.ollama.embeddingModel,
        noteCount: 0,
        lastIndexed: null,
      }];
    }
  }

  async run(): Promise<SetupWizardResult> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }

  onOpen(): void {
    this.containerEl.addClass("notient-setup");
    this.modalEl.addClass("notient-setup-modal");
    this.render();

    setTimeout(() => {
      this.checkOllama();
      this.checkLMStudio();
    }, 300);
  }

  onClose(): void {
    if (this.resolvePromise) {
      this.resolvePromise(this.result);
      this.resolvePromise = null;
    }
  }

  // ==================== Host URL Construction ====================

  private getHost(config: ServiceConfig): string {
    return `http://${config.ip}:${config.port}`;
  }

  private getModelDimension(modelName: string): number | null {
    return MODEL_DEFAULTS.EMBEDDING_DIMENSIONS[modelName] ?? null;
  }

  // ==================== Connection Checks ====================

  private async checkOllama(): Promise<void> {
    this.ollama.status = "checking";
    this.ollama.error = "";
    this.updateServiceCard("ollama");

    try {
      const models = await this.healthMonitor.fetchOllamaModels(this.getHost(this.ollama));

      if (models.length > 0) {
        this.ollama.status = "connected";
        this.ollama.models = models;

        // Auto-select first embedding model, or first model if no embedding models
        if (!this.ollama.selectedModel || !models.some(m => m.name === this.ollama.selectedModel)) {
          const embeddingModels = models.filter((m) => m.capabilities.includes("embedding"));
          this.ollama.selectedModel = embeddingModels[0]?.name || models[0]?.name || "";
        }
      } else {
        this.ollama.status = "error";
        this.ollama.error = "No models. Run: ollama pull nomic-embed-text";
      }
    } catch (err) {
      this.ollama.status = "error";
      this.ollama.error = err instanceof Error ? err.message : "Connection failed";
      this.ollama.models = [];
    }

    this.updateServiceCard("ollama");
    this.updateActions();
  }

  private async checkLMStudio(): Promise<void> {
    this.lmstudio.status = "checking";
    this.lmstudio.error = "";
    this.updateServiceCard("lmstudio");

    try {
      const models = await this.healthMonitor.fetchLMStudioModels(this.getHost(this.lmstudio));

      if (models.length > 0) {
        this.lmstudio.status = "connected";
        this.lmstudio.models = models;

        // Auto-select first model if current selection not in list
        if (!this.lmstudio.selectedModel || !models.some(m => m.name === this.lmstudio.selectedModel)) {
          this.lmstudio.selectedModel = models[0]?.name || "";
        }
      } else {
        this.lmstudio.status = "error";
        this.lmstudio.error = "No models loaded. Load a model in LM Studio.";
      }
    } catch (err) {
      this.lmstudio.status = "error";
      this.lmstudio.error = err instanceof Error ? err.message : "Connection failed";
      this.lmstudio.models = [];
    }

    this.updateServiceCard("lmstudio");
    this.updateActions();
  }

  // ==================== Rendering ====================

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    // Header
    const header = contentEl.createDiv({ cls: "notient-setup-header" });
    header.createEl("h1", { text: "✨ Notient Setup" });

    // Services grid (side by side)
    const servicesGrid = contentEl.createDiv({ cls: "notient-services-grid" });
    this.renderServiceCard(servicesGrid, "ollama");
    this.renderServiceCard(servicesGrid, "lmstudio");

    // Vault section with chunk size slider
    this.renderVaultSection(contentEl);

    // Index section (if indexes exist)
    if (this.existingIndexes.length > 0) {
      this.renderIndexSection(contentEl);
    }

    // Actions
    this.renderActions(contentEl);
  }

  private renderServiceCard(container: HTMLElement, service: "ollama" | "lmstudio"): void {
    const config = service === "ollama" ? this.ollama : this.lmstudio;
    const defaults = DEFAULT_IPS[service];
    const isOllama = service === "ollama";
    const cardId = `${service}-card`;

    const card = container.createDiv({ cls: "notient-service-card", attr: { id: cardId } });

    // Header row: icon, title, status badge
    const header = card.createDiv({ cls: "notient-card-header" });
    const titleArea = header.createDiv({ cls: "notient-card-title-area" });
    titleArea.createEl("h3", { text: isOllama ? "🦙 Embeddings" : "🤖 Chat" });
    titleArea.createEl("span", {
      text: isOllama ? "Ollama" : "LM Studio",
      cls: "notient-card-service-name",
    });

    this.renderStatusBadge(header, config.status);

    // Local/Network buttons (auto-populate IP)
    const modeRow = card.createDiv({ cls: "notient-card-mode-row" });
    
    const localBtn = modeRow.createEl("button", {
      text: "🏠 Local",
      cls: `notient-mode-btn-compact ${this.isLocalIP(config.ip, service) ? "active" : ""}`,
    });
    localBtn.addEventListener("click", () => {
      config.ip = defaults.local;
      this.updateServiceCard(service);
      if (isOllama) this.checkOllama();
      else this.checkLMStudio();
    });

    const networkBtn = modeRow.createEl("button", {
      text: "📡 Network",
      cls: `notient-mode-btn-compact ${config.ip === defaults.network ? "active" : ""}`,
    });
    networkBtn.addEventListener("click", () => {
      config.ip = defaults.network;
      this.updateServiceCard(service);
      if (isOllama) this.checkOllama();
      else this.checkLMStudio();
    });

    // IP input (always visible)
    const ipRow = card.createDiv({ cls: "notient-ip-row-always" });
    ipRow.createEl("label", { text: "Host:" });
    const ipInput = ipRow.createEl("input", {
      type: "text",
      cls: "notient-ip-input-full",
      value: config.ip,
      placeholder: defaults.network,
    });
    ipInput.addEventListener("input", (e) => {
      config.ip = (e.target as HTMLInputElement).value;
      if (isOllama) this.debouncedCheckOllama();
      else this.debouncedCheckLMStudio();
    });

    // Port input (inline with IP)
    ipRow.createEl("label", { text: ":" });
    const portInput = ipRow.createEl("input", {
      type: "text",
      cls: "notient-port-input",
      value: config.port,
    });
    portInput.addEventListener("input", (e) => {
      config.port = (e.target as HTMLInputElement).value;
      if (isOllama) this.debouncedCheckOllama();
      else this.debouncedCheckLMStudio();
    });

    // Error display
    if (config.status === "error" && config.error) {
      const errorDiv = card.createDiv({ cls: "notient-card-error" });
      errorDiv.textContent = config.error;
    }

    // Model selection dropdown
    const modelRow = card.createDiv({ cls: "notient-model-row" });
    modelRow.createEl("label", { text: "Model:" });

    if (config.models.length > 0) {
      const selectWrapper = modelRow.createDiv({ cls: "notient-select-wrapper" });
      const select = selectWrapper.createEl("select", { cls: "notient-model-select" });

      if (isOllama) {
        const embeddingModels = config.models.filter((m) => m.capabilities.includes("embedding"));
        const otherModels = config.models.filter((m) => !m.capabilities.includes("embedding"));

        if (embeddingModels.length > 0) {
          const optgroup = select.createEl("optgroup", { attr: { label: "⭐ Embedding Models" } });
          for (const m of embeddingModels) {
            const opt = optgroup.createEl("option", { value: m.name, text: m.name });
            if (m.name === config.selectedModel) opt.selected = true;
          }
        }

        if (otherModels.length > 0) {
          const optgroup = select.createEl("optgroup", { attr: { label: "Other" } });
          for (const m of otherModels) {
            const opt = optgroup.createEl("option", { value: m.name, text: m.name });
            if (m.name === config.selectedModel) opt.selected = true;
          }
        }
      } else {
        for (const m of config.models) {
          const opt = select.createEl("option", { value: m.name, text: m.name });
          if (m.name === config.selectedModel) opt.selected = true;
        }
      }

      select.addEventListener("change", (e) => {
        config.selectedModel = (e.target as HTMLSelectElement).value;
        this.updateActions();
        if (isOllama) this.updateServiceCard("ollama"); // Re-render to update dimension display
      });

      // Show dimension for embedding model (READ-ONLY, auto-detected)
      if (isOllama && config.selectedModel) {
        const dim = this.getModelDimension(config.selectedModel);
        if (dim) {
          selectWrapper.createEl("span", {
            text: `${dim}d vectors`,
            cls: "notient-model-dim",
            attr: { title: "Vector dimensions (auto-detected from model)" },
          });
        } else {
          selectWrapper.createEl("span", {
            text: "dimensions unknown",
            cls: "notient-model-dim-unknown",
            attr: { title: "Dimension will be detected when indexing starts" },
          });
        }
      }
    } else {
      modelRow.createEl("span", {
        cls: "notient-model-placeholder",
        text: config.status === "checking" ? "Detecting..." : "Connect to detect",
      });
    }

    // Model change notice for embeddings (NEW INDEX, not replace)
    if (isOllama && this.currentIndexModel && config.selectedModel &&
        config.selectedModel !== this.currentIndexModel) {
      const notice = card.createDiv({ cls: "notient-model-notice" });
      notice.innerHTML = `ℹ️ New index for <b>${config.selectedModel}</b>. <b>${this.currentIndexModel}</b> preserved.`;
    }
  }

  private isLocalIP(ip: string, service: "ollama" | "lmstudio"): boolean {
    const local = DEFAULT_IPS[service].local;
    return ip === local || ip === "127.0.0.1" || ip === "localhost";
  }

  private renderStatusBadge(container: HTMLElement, status: ConnectionStatus): void {
    const badge = container.createDiv({ cls: `notient-status-badge status-${status}` });

    switch (status) {
      case "checking":
        badge.innerHTML = '<span class="notient-spinner"></span>';
        break;
      case "connected":
        badge.textContent = "●";
        badge.title = "Connected";
        break;
      case "error":
        badge.textContent = "●";
        badge.title = "Error";
        break;
      default:
        badge.textContent = "○";
        badge.title = "Not checked";
    }
  }

  private renderVaultSection(container: HTMLElement): void {
    const section = container.createDiv({ cls: "notient-vault-section" });

    // Vault stats bar
    if (this.vaultStats) {
      const stats = section.createDiv({ cls: "notient-vault-stats" });
      stats.createEl("span", { text: `📝 ${this.vaultStats.noteCount} notes` });
      stats.createEl("span", { text: `📁 ${this.vaultStats.folderCount} folders` });
      if (this.vaultStats.noteCount > 100) {
        stats.createEl("span", {
          text: `⏱ ~${this.vaultStats.estimatedIndexTimeMin} min`,
          cls: "notient-estimate",
        });
      }
    }

    // Chunk Size Slider
    const chunkSection = section.createDiv({ cls: "notient-chunk-section" });
    
    const chunkHeader = chunkSection.createDiv({ cls: "notient-chunk-header" });
    chunkHeader.createEl("label", { text: "Chunk Size:" });
    const chunkValue = chunkHeader.createEl("span", { 
      text: `${this.chunkSize} chars`,
      cls: "notient-chunk-value",
    });

    const slider = chunkSection.createEl("input", {
      type: "range",
      cls: "notient-chunk-slider",
      attr: {
        min: "32",
        max: "8192",
        step: "32",
        value: String(this.chunkSize),
      },
    });

    slider.addEventListener("input", (e) => {
      this.chunkSize = parseInt((e.target as HTMLInputElement).value, 10);
      chunkValue.textContent = `${this.chunkSize} chars`;
    });

    // Tooltip explaining performance/accuracy tradeoff
    const tooltip = chunkSection.createDiv({ cls: "notient-chunk-tooltip" });
    tooltip.innerHTML = `
      <span class="notient-tooltip-label">⚡ Smaller chunks</span> → faster search, more precise matches, more API calls<br>
      <span class="notient-tooltip-label">📚 Larger chunks</span> → more context per result, fewer chunks, less granular
    `;

    // Two-column layout for other options
    const optionsGrid = section.createDiv({ cls: "notient-options-grid" });

    // Excluded folders
    const excludeCol = optionsGrid.createDiv({ cls: "notient-option-col" });
    excludeCol.createEl("label", { text: "Exclude folders:" });
    const excludeInput = excludeCol.createEl("input", {
      type: "text",
      cls: "notient-exclude-input",
      value: this.excludedFolders,
      placeholder: ".obsidian, templates",
    });
    excludeInput.addEventListener("input", (e) => {
      this.excludedFolders = (e.target as HTMLInputElement).value;
    });
  }

  private renderIndexSection(container: HTMLElement): void {
    const section = container.createDiv({ cls: "notient-index-section" });
    section.createEl("h4", { text: "📊 Existing Indexes" });

    const list = section.createDiv({ cls: "notient-index-list" });

    for (const idx of this.existingIndexes) {
      const item = list.createDiv({ cls: "notient-index-item" });
      const dim = this.getModelDimension(idx.modelKey);
      item.createEl("span", {
        text: `${idx.modelKey}${dim ? ` (${dim}d)` : ""}`,
        cls: "notient-index-model",
      });
      if (idx.modelKey === this.currentIndexModel) {
        item.createEl("span", { text: "active", cls: "notient-index-active" });
      }
    }

    section.createEl("p", {
      text: "Manage indexes in Settings → Advanced",
      cls: "notient-index-hint",
    });
  }

  private renderActions(container: HTMLElement): void {
    const actions = container.createDiv({ cls: "notient-setup-actions" });

    const cancelBtn = actions.createEl("button", { text: "Cancel", cls: "notient-cancel-btn" });
    cancelBtn.addEventListener("click", () => this.close());

    const startBtn = actions.createEl("button", {
      cls: "notient-start-btn",
      attr: { id: "notient-start-btn" },
    });

    const canStart = this.canStart();
    const isNewModel = this.isNewEmbeddingModel();
    const hasExisting = this.existingIndexes.length > 0;

    if (isNewModel && hasExisting) {
      startBtn.textContent = "➕ Create New Index";
    } else if (hasExisting) {
      startBtn.textContent = "✓ Save & Continue";
    } else {
      startBtn.textContent = "🚀 Start Indexing";
    }

    startBtn.disabled = !canStart;
    startBtn.addEventListener("click", () => this.finish());
  }

  // ==================== UI Updates ====================

  private updateServiceCard(service: "ollama" | "lmstudio"): void {
    const cardId = `${service}-card`;
    const card = document.getElementById(cardId);
    if (!card) return;

    const container = card.parentElement;
    if (!container) return;

    card.remove();
    this.renderServiceCard(container, service);
  }

  private updateActions(): void {
    const actionsDiv = this.contentEl.querySelector(".notient-setup-actions");
    if (actionsDiv) {
      actionsDiv.remove();
      this.renderActions(this.contentEl);
    }
  }

  private canStart(): boolean {
    return (
      this.ollama.status === "connected" &&
      this.lmstudio.status === "connected" &&
      Boolean(this.ollama.selectedModel) &&
      Boolean(this.lmstudio.selectedModel)
    );
  }

  private isNewEmbeddingModel(): boolean {
    if (!this.currentIndexModel) return false;
    return this.ollama.selectedModel !== this.currentIndexModel;
  }

  // ==================== Finalization ====================

  private finish(): void {
    this.result.settings.ollama = {
      ...this.currentSettings.ollama,
      host: this.getHost(this.ollama),
      embeddingModel: this.ollama.selectedModel,
      enabled: true,
    };

    this.result.settings.lmstudio = {
      ...this.currentSettings.lmstudio,
      host: this.getHost(this.lmstudio),
      reasoningModel: this.lmstudio.selectedModel,
      enabled: true,
    };

    this.result.settings.indexing = {
      ...this.currentSettings.indexing,
      chunkSize: this.chunkSize,
      excludedFolders: this.excludedFolders
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };

    this.result.completed = true;
    this.result.settings.setupComplete = true;

    console.log("[SetupWizard] Configuration finalized:", {
      ollamaHost: this.getHost(this.ollama),
      embeddingModel: this.ollama.selectedModel,
      modelDimension: this.getModelDimension(this.ollama.selectedModel),
      lmstudioHost: this.getHost(this.lmstudio),
      reasoningModel: this.lmstudio.selectedModel,
      chunkSize: this.chunkSize,
      isNewModel: this.isNewEmbeddingModel(),
    });

    this.close();
  }
}
