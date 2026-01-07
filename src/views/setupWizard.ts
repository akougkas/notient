/**
 * Setup Wizard Modal - Comprehensive Configuration
 *
 * Features:
 * - Disk-based index detection using Obsidian's file adapter
 * - Shows ALL existing indexes with dimensions and compatibility
 * - Model dimension compatibility checking
 * - Interactive index options integrated into wizard
 * - LM Studio chat validation
 * - SEPARATE network toggles per service with default IPs
 * - Chunk size slider (32-8192) with performance/accuracy tooltip
 */

import { type App, Modal, debounce } from "obsidian";
import { MODEL_DEFAULTS } from "../core/constants";
import type { HealthMonitor } from "../services/healthMonitor";
import type { AvailableModel } from "../types/services";
import type { NotientSettings } from "../types/settings";

export interface SetupWizardResult {
  completed: boolean;
  settings: Partial<NotientSettings>;
  indexAction: "none" | "use_existing" | "sync" | "rebuild";
  selectedIndexKey?: string; // Which index to use (if use_existing)
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

/**
 * Represents an index found on disk
 */
interface DiskIndex {
  // From index file
  modelKey: string;
  dimension: number;
  chunkCount: number;

  // From state file
  noteCount: number;
  lastIndexedAt: number | null;
  indexingInProgress: boolean;

  // Computed
  completionPercent: number;
  state: "complete" | "incomplete" | "crashed" | "stale" | "unknown";

  // Compatibility with selected model
  isCompatible: boolean;
  compatibilityReason: string;
}

export class SetupWizardModal extends Modal {
  private result: SetupWizardResult = {
    completed: false,
    settings: {},
    indexAction: "none",
  };
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
  private chunkSize = 1500;

  // Vault configuration
  private excludedFolders = ".obsidian, .trash, templates";

  // Disk indexes (found by scanning)
  private diskIndexes: DiskIndex[] = [];
  private selectedIndexKey: string | null = null;
  private selectedIndexAction: "use_existing" | "sync" | "rebuild" = "rebuild";

  // Selected model dimension (detected when model is selected)
  private selectedModelDimension: number | null = null;

  // Vault stats
  private vaultStats: VaultStats | null = null;

  // Plugin storage path (relative to vault)
  private pluginPath = ".obsidian/plugins/notient";

  // Debounced check functions
  private debouncedCheckOllama = debounce(() => this.checkOllama(), 500, true);
  private debouncedCheckLMStudio = debounce(() => this.checkLMStudio(), 500, true);

  constructor(
    app: App,
    private healthMonitor: HealthMonitor,
    private currentSettings: NotientSettings,
  ) {
    super(app);
    this.initializeFromSettings();
    this.computeVaultStats();
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

    // Only use settings model if setup was previously completed
    if (this.currentSettings.setupComplete) {
      this.ollama.selectedModel = this.currentSettings.ollama.embeddingModel;
      this.lmstudio.selectedModel = this.currentSettings.lmstudio.reasoningModel;
    }

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

  /**
   * Scan disk for existing indexes using Obsidian's adapter
   */
  private async scanDiskIndexes(): Promise<void> {
    this.diskIndexes = [];

    try {
      const adapter = this.app.vault.adapter;

      // Check if plugin folder exists
      if (!(await adapter.exists(this.pluginPath))) {
        console.log("[SetupWizard] Plugin folder doesn't exist yet");
        return;
      }

      // List files in plugin folder
      const listing = await adapter.list(this.pluginPath);
      const indexFiles = listing.files.filter((f) => f.includes("/index-") && f.endsWith(".json"));

      console.log("[SetupWizard] Found index files:", indexFiles);

      for (const indexPath of indexFiles) {
        try {
          // Read index file
          const indexContent = await adapter.read(indexPath);
          const indexData = JSON.parse(indexContent);

          // Extract info from index file - metadata is in `meta` object
          // Structure: { meta: { modelKey, dimension, docCount, ... }, docs: [...] }
          const meta = indexData.meta || {};
          const modelKey = meta.modelKey || indexData.modelKey || "unknown";
          const dimension = meta.dimension || indexData.dimension || 0;
          const chunkCount = indexData.docs?.length || meta.docCount || 0;

          // Try to read corresponding state file
          const stateFileName = `state-${modelKey}.json`;
          const statePath = `${this.pluginPath}/${stateFileName}`;

          let noteCount = 0;
          let lastIndexedAt: number | null = null;
          let indexingInProgress = false;

          if (await adapter.exists(statePath)) {
            const stateContent = await adapter.read(statePath);
            const stateData = JSON.parse(stateContent);
            noteCount = Object.keys(stateData.notes || {}).length;
            lastIndexedAt = stateData.lastFullIndexAt || null;
            indexingInProgress = stateData.indexingInProgress || false;
          }

          // Calculate state
          const vaultNoteCount = this.vaultStats?.noteCount || 0;
          const completionPercent =
            vaultNoteCount > 0 ? Math.round((noteCount / vaultNoteCount) * 100) : 0;

          let state: DiskIndex["state"] = "complete";
          if (indexingInProgress) {
            state = "crashed";
          } else if (chunkCount === 0) {
            state = "unknown";
          } else if (noteCount < vaultNoteCount * 0.9) {
            state = "incomplete";
          } else if (chunkCount > 0 && noteCount === 0) {
            state = "stale";
          }

          // Initially set compatibility to unknown - will be updated when model is selected
          this.diskIndexes.push({
            modelKey,
            dimension,
            chunkCount,
            noteCount,
            lastIndexedAt,
            indexingInProgress,
            completionPercent,
            state,
            isCompatible: false, // Will be updated when model selected
            compatibilityReason: "Select model to check compatibility",
          });

          console.log(
            `[SetupWizard] Found index: ${modelKey}, dim=${dimension}d, chunks=${chunkCount}, notes=${noteCount}, state=${state}`,
          );
        } catch (err) {
          console.warn(`[SetupWizard] Failed to read index ${indexPath}:`, err);
        }
      }

      // Sort by note count for now (compatibility not yet known)
      this.diskIndexes.sort((a, b) => b.noteCount - a.noteCount);

      // Default action is rebuild until model is selected and compatibility checked
      this.selectedIndexKey = null;
      this.selectedIndexAction = "rebuild";
    } catch (err) {
      console.error("[SetupWizard] Error scanning indexes:", err);
    }
  }

  /**
   * Check if an index is compatible with the selected model
   */
  private checkCompatibility(indexDimension: number): { isCompatible: boolean; reason: string } {
    if (!this.selectedModelDimension) {
      return { isCompatible: false, reason: "Select a model first" };
    }

    if (indexDimension === 0) {
      return { isCompatible: false, reason: "Unknown index dimension" };
    }

    if (indexDimension === this.selectedModelDimension) {
      return { isCompatible: true, reason: "Dimensions match" };
    }

    return {
      isCompatible: false,
      reason: "Incompatible: different embedding sizes",
    };
  }

  /**
   * Update model dimension when model is selected
   */
  private async updateModelDimension(modelName: string): Promise<void> {
    // First check known dimensions
    const knownDim = MODEL_DEFAULTS.EMBEDDING_DIMENSIONS[modelName];
    if (knownDim) {
      this.selectedModelDimension = knownDim;
    } else {
      // Try to detect from Ollama
      try {
        const host = this.getHost(this.ollama);
        const response = await fetch(`${host}/api/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: modelName, prompt: "test" }),
        });
        if (response.ok) {
          const data = await response.json();
          this.selectedModelDimension = data.embedding?.length || null;
        }
      } catch {
        this.selectedModelDimension = null;
      }
    }

    console.log(`[SetupWizard] Model ${modelName} dimension: ${this.selectedModelDimension}`);

    // Re-check compatibility for all indexes
    for (const idx of this.diskIndexes) {
      const { isCompatible, reason } = this.checkCompatibility(idx.dimension);
      idx.isCompatible = isCompatible;
      idx.compatibilityReason = reason;
    }

    // Re-sort: compatible first, then by note count
    this.diskIndexes.sort((a, b) => {
      if (a.isCompatible && !b.isCompatible) return -1;
      if (!a.isCompatible && b.isCompatible) return 1;
      return b.noteCount - a.noteCount;
    });

    // Auto-select best compatible index
    this.autoSelectBestIndex();
  }

  /**
   * Auto-select the best compatible index
   */
  private autoSelectBestIndex(): void {
    const bestCompatible = this.diskIndexes.find(
      (idx) => idx.isCompatible && idx.state === "complete",
    );
    if (bestCompatible) {
      this.selectedIndexKey = bestCompatible.modelKey;
      this.selectedIndexAction = "use_existing";
      console.log(`[SetupWizard] Auto-selected compatible index: ${bestCompatible.modelKey}`);
    } else {
      const anyCompatible = this.diskIndexes.find((idx) => idx.isCompatible);
      if (anyCompatible) {
        this.selectedIndexKey = anyCompatible.modelKey;
        this.selectedIndexAction = anyCompatible.state === "incomplete" ? "sync" : "rebuild";
        console.log(
          `[SetupWizard] Auto-selected partial index: ${anyCompatible.modelKey} (${anyCompatible.state})`,
        );
      } else {
        // No compatible index - need to build new one
        this.selectedIndexKey = null;
        this.selectedIndexAction = "rebuild";
        console.log("[SetupWizard] No compatible index found. Will create new.");
      }
    }
  }

  async run(): Promise<SetupWizardResult> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass("notient-setup");
    this.modalEl.addClass("notient-setup-modal");

    // Scan for indexes first
    await this.scanDiskIndexes();

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

        // Auto-select first embedding model if none selected
        if (
          !this.ollama.selectedModel ||
          !models.some((m) => m.name === this.ollama.selectedModel)
        ) {
          const embeddingModels = models.filter((m) => m.capabilities.includes("embedding"));
          this.ollama.selectedModel = embeddingModels[0]?.name || models[0]?.name || "";
        }

        // Update dimension for selected model
        if (this.ollama.selectedModel) {
          await this.updateModelDimension(this.ollama.selectedModel);
        }
      } else {
        this.ollama.status = "error";
        this.ollama.error = "No models found. Install one with: ollama pull nomic-embed-text";
      }
    } catch (err) {
      this.ollama.status = "error";
      this.ollama.error = err instanceof Error ? err.message : "Couldn't connect";
      this.ollama.models = [];
    }

    this.updateServiceCard("ollama");
    this.renderIndexSection();
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

        if (
          !this.lmstudio.selectedModel ||
          !models.some((m) => m.name === this.lmstudio.selectedModel)
        ) {
          this.lmstudio.selectedModel = models[0]?.name || "";
        }
      } else {
        this.lmstudio.status = "error";
        this.lmstudio.error = "No models found. Load a model in LM Studio first.";
      }
    } catch (err) {
      this.lmstudio.status = "error";
      this.lmstudio.error = err instanceof Error ? err.message : "Couldn't connect";
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

    // Index section (always show)
    const indexSection = contentEl.createDiv({
      cls: "notient-index-section",
      attr: { id: "index-section" },
    });
    this.renderIndexSectionContent(indexSection);

    // Actions
    this.renderActions(contentEl);
  }

  private renderServiceCard(container: HTMLElement, service: "ollama" | "lmstudio"): void {
    const config = service === "ollama" ? this.ollama : this.lmstudio;
    const defaults = DEFAULT_IPS[service];
    const isOllama = service === "ollama";
    const cardId = `${service}-card`;

    const card = container.createDiv({ cls: "notient-service-card", attr: { id: cardId } });

    // Header
    const header = card.createDiv({ cls: "notient-card-header" });
    const titleArea = header.createDiv({ cls: "notient-card-title-area" });
    titleArea.createEl("h3", { text: isOllama ? "🦙 Embeddings" : "🤖 Chat & Rerank" });
    titleArea.createEl("span", {
      text: isOllama ? "Ollama" : "LM Studio",
      cls: "notient-card-service-name",
    });

    this.renderStatusBadge(header, config.status);

    // Local/Network buttons
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

    // IP input
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

    // Error
    if (config.status === "error" && config.error) {
      card.createDiv({ cls: "notient-card-error", text: config.error });
    }

    // Model selection
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

      select.addEventListener("change", async (e) => {
        config.selectedModel = (e.target as HTMLSelectElement).value;
        if (isOllama) {
          await this.updateModelDimension(config.selectedModel);
          this.renderIndexSection();
        }
        this.updateActions();
      });

      // Show dimension for embedding model
      if (isOllama && this.selectedModelDimension) {
        selectWrapper.createEl("span", {
          text: `${this.selectedModelDimension}d`,
          cls: "notient-model-dim",
          attr: { title: "Embedding size" },
        });
      }
    } else {
      modelRow.createEl("span", {
        cls: "notient-model-placeholder",
        text: config.status === "checking" ? "Finding models..." : "Connect to see models",
      });
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

    // Vault stats
    if (this.vaultStats) {
      const stats = section.createDiv({ cls: "notient-vault-stats" });
      stats.createEl("span", { text: `📝 ${this.vaultStats.noteCount} notes` });
      stats.createEl("span", { text: `📁 ${this.vaultStats.folderCount} folders` });
      if (this.vaultStats.noteCount > 100) {
        stats.createEl("span", {
          text: `⏱ ~${this.vaultStats.estimatedIndexTimeMin} min to index`,
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
      attr: { min: "32", max: "8192", step: "32", value: String(this.chunkSize) },
    });

    slider.addEventListener("input", (e) => {
      this.chunkSize = Number.parseInt((e.target as HTMLInputElement).value, 10);
      chunkValue.textContent = `${this.chunkSize} chars`;
    });

    const tooltip = chunkSection.createDiv({ cls: "notient-chunk-tooltip" });
    tooltip.innerHTML = `<span class="notient-tooltip-label">⚡ Smaller</span> → precise | <span class="notient-tooltip-label">📚 Larger</span> → more context`;

    // Excluded folders
    const optionsGrid = section.createDiv({ cls: "notient-options-grid" });
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

  private renderIndexSection(): void {
    const section = document.getElementById("index-section");
    if (section) {
      section.empty();
      this.renderIndexSectionContent(section as HTMLElement);
    }
  }

  private renderIndexSectionContent(section: HTMLElement): void {
    section.createEl("h4", { text: "📊 Index Management" });

    // Show selected model info
    if (this.ollama.selectedModel && this.selectedModelDimension) {
      const modelInfo = section.createDiv({ cls: "notient-model-info" });
      modelInfo.createEl("span", {
        text: `Selected: ${this.ollama.selectedModel} (${this.selectedModelDimension}d vectors)`,
        cls: "notient-model-info-text",
      });
    }

    // Show all found indexes
    if (this.diskIndexes.length === 0) {
      const noIndex = section.createDiv({ cls: "notient-no-index" });
      noIndex.createEl("span", {
        text: "🆕 No existing indexes found. A new index will be created.",
      });
      this.selectedIndexAction = "rebuild";
      return;
    }

    // List all indexes
    const indexList = section.createDiv({ cls: "notient-index-list" });

    for (const idx of this.diskIndexes) {
      const item = indexList.createDiv({
        cls: `notient-index-item ${idx.isCompatible ? "compatible" : "incompatible"} ${this.selectedIndexKey === idx.modelKey ? "selected" : ""}`,
      });

      // Index info
      const info = item.createDiv({ cls: "notient-index-info" });

      const header = info.createDiv({ cls: "notient-index-header" });
      const compatIcon = header.createSpan({ cls: "notient-compat-icon" });
      compatIcon.textContent = idx.isCompatible ? "✓" : "✗";

      header.createEl("span", { text: idx.modelKey, cls: "notient-index-model" });
      header.createEl("span", { text: `${idx.dimension}d`, cls: "notient-index-dim" });

      const stats = info.createDiv({ cls: "notient-index-stats" });
      stats.createEl("span", { text: `${idx.noteCount} notes` });
      stats.createEl("span", { text: `${idx.chunkCount} passages` });

      const stateIcons: Record<DiskIndex["state"], string> = {
        complete: "✅",
        incomplete: "⏳",
        crashed: "⚠️",
        stale: "🔄",
        unknown: "❓",
      };
      stats.createEl("span", {
        text: `${stateIcons[idx.state]} ${idx.state}`,
        cls: `state-${idx.state}`,
      });

      // Compatibility reason
      if (!idx.isCompatible) {
        info.createEl("div", { text: idx.compatibilityReason, cls: "notient-compat-reason" });
      }

      // Selection (only for compatible indexes)
      if (idx.isCompatible) {
        item.addEventListener("click", () => {
          this.selectedIndexKey = idx.modelKey;
          this.selectedIndexAction = idx.state === "complete" ? "use_existing" : "sync";
          this.renderIndexSection();
          this.updateActions();
        });
      }
    }

    // Action selection for selected index
    const compatibleIndexes = this.diskIndexes.filter((idx) => idx.isCompatible);
    if (compatibleIndexes.length > 0 && this.selectedIndexKey) {
      const selectedIdx = this.diskIndexes.find((idx) => idx.modelKey === this.selectedIndexKey);
      if (selectedIdx) {
        const actionDiv = section.createDiv({ cls: "notient-index-actions" });
        actionDiv.createEl("label", { text: "Action for selected index:" });

        const options = this.getIndexOptions(selectedIdx);
        for (const opt of options) {
          const optionEl = actionDiv.createEl("div", { cls: "notient-index-action-option" });
          const radio = optionEl.createEl("input", {
            type: "radio",
            attr: { name: "index-action", value: opt.value, id: `action-${opt.value}` },
          });
          if (opt.value === this.selectedIndexAction) radio.checked = true;
          radio.addEventListener("change", () => {
            this.selectedIndexAction = opt.value as typeof this.selectedIndexAction;
            this.updateActions();
          });

          const label = optionEl.createEl("label", { attr: { for: `action-${opt.value}` } });
          label.createEl("span", { text: opt.label, cls: "notient-action-label" });
          label.createEl("span", { text: opt.description, cls: "notient-action-desc" });
        }
      }
    }

    // Option to create new index
    if (compatibleIndexes.length === 0 || !this.selectedIndexKey) {
      const newIndex = section.createDiv({ cls: "notient-new-index" });
      newIndex.createEl("span", { text: "🆕 No compatible index. A new index will be created." });
      this.selectedIndexAction = "rebuild";
    }
  }

  private getIndexOptions(
    index: DiskIndex,
  ): Array<{ value: string; label: string; description: string }> {
    const options: Array<{ value: string; label: string; description: string }> = [];

    if (index.state === "complete") {
      options.push({
        value: "use_existing",
        label: "✅ Use existing",
        description: "Ready to search",
      });
      options.push({ value: "sync", label: "🔄 Sync", description: "Index new/changed notes" });
      options.push({ value: "rebuild", label: "🔨 Rebuild", description: "Re-index everything" });
    } else if (index.state === "incomplete" || index.state === "crashed") {
      options.push({
        value: "sync",
        label: "▶️ Resume",
        description: `Continue from ${index.completionPercent}%`,
      });
      options.push({
        value: "rebuild",
        label: "🔨 Start fresh",
        description: "Clear and re-index",
      });
      options.push({
        value: "use_existing",
        label: "⏸️ Use as-is",
        description: "Keep partial index",
      });
    } else {
      options.push({ value: "rebuild", label: "🔨 Rebuild", description: "Create new index" });
    }

    return options;
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

    switch (this.selectedIndexAction) {
      case "use_existing":
        startBtn.textContent = "✓ Save & Use Index";
        break;
      case "sync":
        startBtn.textContent = "🔄 Save & Sync";
        break;
      case "rebuild":
        startBtn.textContent = "🚀 Save & Build Index";
        break;
    }

    startBtn.disabled = !canStart;
    startBtn.addEventListener("click", () => this.finish());
  }

  private updateServiceCard(service: "ollama" | "lmstudio"): void {
    const cardId = `${service}-card`;
    const card = document.getElementById(cardId);
    if (!card?.parentElement) return;

    const container = card.parentElement;
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
    this.result.indexAction = this.selectedIndexAction;
    this.result.selectedIndexKey = this.selectedIndexKey || undefined;

    console.log("[SetupWizard] Configuration finalized:", {
      embeddingModel: this.ollama.selectedModel,
      modelDimension: this.selectedModelDimension,
      reasoningModel: this.lmstudio.selectedModel,
      chunkSize: this.chunkSize,
      indexAction: this.selectedIndexAction,
      selectedIndexKey: this.selectedIndexKey,
      diskIndexes: this.diskIndexes.map((i) => ({
        modelKey: i.modelKey,
        dim: i.dimension,
        compatible: i.isCompatible,
      })),
    });

    this.close();
  }
}
