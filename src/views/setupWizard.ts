/**
 * Setup Wizard Modal - Redesigned
 *
 * A step-by-step wizard for configuring Notient.
 * Prioritizes smart defaults, clear status feedback, and a premium aesthetic.
 */

import { type App, Modal, debounce, setIcon } from "obsidian";
import { MODEL_DEFAULTS } from "../core/constants";
import type { HealthMonitor } from "../services/healthMonitor";
import type { AvailableModel } from "../types/services";
import type { NotientSettings } from "../types/settings";

export interface SetupWizardResult {
  completed: boolean;
  settings: Partial<NotientSettings>;
  indexAction: "none" | "use_existing" | "sync" | "rebuild";
  selectedIndexKey?: string;
}

type ConnectionStatus = "idle" | "checking" | "connected" | "error";

const DEFAULT_IPS = {
  ollama: { local: "localhost", network: "192.168.86.249" },
  lmstudio: { local: "127.0.0.1", network: "192.168.86.249" },
};

const DEFAULT_PORTS = {
  ollama: "11434",
  lmstudio: "1234",
};

interface ServiceConfig {
  label: string;
  ip: string;
  port: string;
  status: ConnectionStatus;
  error: string;
  models: AvailableModel[];
  selectedModel: string;
}

/**
 * Step definitions
 */
enum WizardStep {
  INTRO = 0,
  SERVICES = 1,
  INDEXING = 2,
  CONFIRM = 3,
}

export class SetupWizardModal extends Modal {
  private result: SetupWizardResult = {
    completed: false,
    settings: {},
    indexAction: "none",
  };
  private resolvePromise: ((result: SetupWizardResult) => void) | null = null;
  private currentStep: WizardStep = WizardStep.INTRO;

  // Configuration State
  private ollama: ServiceConfig = {
    label: "Ollama (Embeddings)",
    ip: DEFAULT_IPS.ollama.local,
    port: DEFAULT_PORTS.ollama,
    status: "idle",
    error: "",
    models: [],
    selectedModel: "",
  };

  private lmstudio: ServiceConfig = {
    label: "LM Studio (Chat)",
    ip: DEFAULT_IPS.lmstudio.local,
    port: DEFAULT_PORTS.lmstudio,
    status: "idle",
    error: "",
    models: [],
    selectedModel: "",
  };

  private chunkSize = 1500;
  private excludedFolders = ".obsidian, .trash, templates";

  // Indexing State
  private indexStatus = {
    compatibleFound: false,
    existingModel: "",
    existingDim: 0,
    noteCount: 0,
    source: "plugin" as "plugin" | "vault",
    decision: "rebuild" as "rebuild" | "resume",
  };

  // Index discovery cache (prevents redundant filesystem scans)
  private cachedIndices: Awaited<ReturnType<typeof this.indexManager.discoverIndices>> | null =
    null;
  private cacheTimestamp = 0;
  private static readonly INDEX_CACHE_TTL_MS = 30000; // 30 seconds

  // ... (lines 95-364 omitted for brevity, keeping surrounding code intact)

  private debouncedCheckOllama = debounce(() => this.checkOllama(), 500, true);
  private debouncedCheckLMStudio = debounce(() => this.checkLMStudio(), 500, true);
  private debouncedRender = debounce(() => this.render(), 150, false);

  constructor(
    app: App,
    private healthMonitor: HealthMonitor,
    private currentSettings: NotientSettings,
    private indexManager: {
      discoverIndices: () => Promise<
        Array<{
          path: string;
          modelKey: string;
          dimension: number;
          docCount: number;
          source: "plugin" | "vault";
          createdAt: Date | null;
          updatedAt: Date | null;
          vaultHash: string | null;
          isLegacy: boolean;
          displayName: string;
        }>
      >;
    },
  ) {
    super(app);
  }

  async run(): Promise<SetupWizardResult> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }

  async onOpen(): Promise<void> {
    this.modalEl.addClass("nv2-wizard-modal");
    // Remove default close button for cleaner look (optional, but standard obsidian modal has one)
    // this.modalEl.querySelector(".modal-close-button")?.remove();

    this.initializeFromSettings();
    this.render();

    // Auto-check connections on open
    setTimeout(() => {
      this.checkOllama();
      this.checkLMStudio();
    }, 100);
  }

  onClose(): void {
    // Cancel any pending debounced functions to prevent memory leaks
    // and callbacks firing after modal is closed
    this.debouncedCheckOllama.cancel?.();
    this.debouncedCheckLMStudio.cancel?.();
    this.debouncedRender.cancel?.();

    // Clear cached data
    this.cachedIndices = null;

    if (this.resolvePromise) {
      this.resolvePromise(this.result);
      this.resolvePromise = null;
    }
  }

  private initializeFromSettings(): void {
    // Parse existing settings
    this.parseHost(this.currentSettings.ollama.host, this.ollama);
    this.parseHost(this.currentSettings.lmstudio.host, this.lmstudio);

    if (this.currentSettings.setupComplete) {
      this.ollama.selectedModel = this.currentSettings.ollama.embeddingModel;
      this.lmstudio.selectedModel = this.currentSettings.lmstudio.reasoningModel;
    }

    this.chunkSize = this.currentSettings.indexing.chunkSize;
    this.excludedFolders = this.currentSettings.indexing.excludedFolders.join(", ");
  }

  private parseHost(host: string, config: ServiceConfig): void {
    const match = host.match(/https?:\/\/([^:]+):?(\d+)?/);
    if (match) {
      config.ip = match[1];
      if (match[2]) config.port = match[2];
    }
  }

  // ==================== Rendering ====================

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    // 1. Header with Steps
    this.renderHeader(contentEl);

    // 2. Content Body
    const body = contentEl.createDiv({ cls: "nv2-wizard-content" });

    switch (this.currentStep) {
      case WizardStep.INTRO:
        this.renderIntro(body);
        break;
      case WizardStep.SERVICES:
        this.renderServices(body);
        break;
      case WizardStep.INDEXING:
        this.renderIndexing(body);
        break;
    }

    // 3. Footer Navigation
    this.renderFooter(contentEl);
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "nv2-wizard-header" });
    header.createDiv({ cls: "nv2-wizard-title", text: "Notient Setup" });
    header.createDiv({
      cls: "nv2-wizard-subtitle",
      text: "Turn your Obsidian vault into a sentient partner.",
    });

    const steps = header.createDiv({ cls: "nv2-wizard-steps" });
    for (let i = 0; i < 3; i++) {
      const dot = steps.createDiv({
        cls: `nv2-wizard-step-dot ${this.currentStep === i ? "active" : ""} ${this.currentStep > i ? "completed" : ""}`,
      });
    }
  }

  // --- Step 1: Intro ---
  private renderIntro(container: HTMLElement): void {
    const content = container.createDiv({
      cls: "nv2-wizard-intro",
      attr: { style: "text-align: center; margin-top: 40px;" },
    }); // Inline style for simplicity, convert to CSS class if repeated
    const icon = content.createDiv({
      attr: { style: "font-size: 48px; margin-bottom: 20px;" },
    });
    icon.setText("✨");

    content.createEl("h2", {
      text: "Power up your notes",
      attr: { style: "margin-bottom: 10px;" },
    });
    content.createDiv({
      text: "Notient connects your vault to local AI models to enable semantic search, chat with your notes, and autonomous organization.",
      attr: {
        style: "color: var(--nv2-text-muted); max-width: 400px; margin: 0 auto; line-height: 1.6;",
      },
    });
  }

  // --- Step 2: Services ---
  private renderServices(container: HTMLElement): void {
    this.renderServiceCard(container, this.ollama, "ollama");
    this.renderServiceCard(container, this.lmstudio, "lmstudio");
  }

  private renderServiceCard(
    container: HTMLElement,
    config: ServiceConfig,
    type: "ollama" | "lmstudio",
  ) {
    const card = container.createDiv({ cls: "nv2-wizard-service-card" });

    // Header
    const header = card.createDiv({ cls: "nv2-wizard-service-header" });
    const title = header.createDiv({ cls: "nv2-wizard-service-title" });
    setIcon(title.createSpan(), type === "ollama" ? "database" : "message-square");
    title.createSpan({ text: config.label });

    const statusBadge = header.createDiv({
      cls: `nv2-wizard-service-status ${config.status}`,
      text:
        config.status === "connected"
          ? "Connected"
          : config.status === "checking"
            ? "Checking..."
            : "Offline",
    });

    // Inputs
    const inputGroup = card.createDiv({ cls: "nv2-wizard-input-group" });
    inputGroup.createDiv({ cls: "nv2-wizard-label", text: "Connection URL" });

    const hostRow = inputGroup.createDiv({ attr: { style: "display: flex; gap: 8px;" } });

    // Helper toggle for Local/Network
    const toggle = hostRow.createEl("select", {
      cls: "nv2-wizard-input",
      attr: { style: "width: 100px;" },
    });
    toggle.createEl("option", { value: "local", text: "Local" });
    toggle.createEl("option", { value: "network", text: "Network" });
    toggle.value = this.isLocal(config.ip) ? "local" : "network";

    toggle.addEventListener("change", () => {
      const mode = toggle.value as "local" | "network";
      const defaults = DEFAULT_IPS[type];
      config.ip = defaults[mode];
      this.render(); // Re-render to update inputs
      if (type === "ollama") this.debouncedCheckOllama();
      else this.debouncedCheckLMStudio();
    });

    // IP Input
    const ipInput = hostRow.createEl("input", {
      type: "text",
      cls: "nv2-wizard-input",
      attr: { placeholder: "127.0.0.1" },
    });
    ipInput.value = config.ip;
    ipInput.addEventListener("input", (e) => {
      config.ip = (e.target as HTMLInputElement).value;
      if (type === "ollama") this.debouncedCheckOllama();
      else this.debouncedCheckLMStudio();
    });

    // Port Input
    const portInput = hostRow.createEl("input", {
      type: "text",
      cls: "nv2-wizard-input",
      attr: { placeholder: "Port", style: "width: 80px;" },
    });
    portInput.value = config.port;
    portInput.addEventListener("input", (e) => {
      config.port = (e.target as HTMLInputElement).value;
      if (type === "ollama") this.debouncedCheckOllama();
      else this.debouncedCheckLMStudio();
    });

    // Model Select
    if (config.status === "connected") {
      const modelGroup = card.createDiv({
        cls: "nv2-wizard-input-group",
        attr: { style: "margin-top: 10px;" },
      });
      modelGroup.createDiv({ cls: "nv2-wizard-label", text: "Model" });
      const select = modelGroup.createEl("select", { cls: "nv2-wizard-input" });

      // Filter embedding models for Ollama if possible
      const models =
        type === "ollama"
          ? config.models.filter(
              (m) => m.capabilities.includes("embedding") || m.name.includes("embed"),
            )
          : config.models;

      // Fallback if filtering removes everything
      const displayModels = models.length > 0 ? models : config.models;

      for (const m of displayModels) {
        const opt = select.createEl("option", { value: m.name, text: m.name });
        if (m.name === config.selectedModel) opt.selected = true;
      }

      select.addEventListener("change", (e) => {
        config.selectedModel = (e.target as HTMLSelectElement).value;
        // Re-scan when model changes
        if (type === "ollama") {
          this.scanForIndexes();
          this.render(); // force re-render if scan finishes fast or state updates
        }
      });
    } else if (config.status === "error") {
      card.createDiv({
        text: config.error || "Could not connect. Check if the service is running.",
        attr: { style: "color: var(--nv2-status-error); font-size: 11px; margin-top: 8px;" },
      });
    }
  }

  // --- Step 3: Indexing ---
  private renderIndexing(container: HTMLElement): void {
    // 1. Vault Config Card
    const configCard = container.createDiv({ cls: "nv2-wizard-service-card" });
    configCard.createDiv({ cls: "nv2-wizard-service-title", text: "Vault Configuration" });

    // Chunk Size
    const chunkGroup = configCard.createDiv({ cls: "nv2-wizard-input-group" });
    const chunkLabel = chunkGroup.createDiv({
      cls: "nv2-wizard-label",
      text: `Chunk Size: ${this.chunkSize} chars`,
    });

    const slider = chunkGroup.createEl("input", {
      type: "range",
      cls: "nv2-wizard-input",
      attr: { min: 200, max: 2000, step: 100 },
    });
    slider.value = String(this.chunkSize);
    slider.addEventListener("input", (e) => {
      this.chunkSize = Number.parseInt((e.target as HTMLInputElement).value, 10);
      // Update label inline instead of full re-render
      chunkLabel.setText(`Chunk Size: ${this.chunkSize} chars`);
    });

    const visual = chunkGroup.createDiv({ cls: "nv2-wizard-chunk-visual" });
    visual.createSpan({ text: "Precise" });
    visual.createSpan({ text: "More Context" });

    // Excluded Folders
    const excludeGroup = configCard.createDiv({ cls: "nv2-wizard-input-group" });
    excludeGroup.createDiv({ cls: "nv2-wizard-label", text: "Excluded Folders (comma separated)" });
    const excludeInput = excludeGroup.createEl("input", {
      type: "text",
      cls: "nv2-wizard-input",
    });
    excludeInput.value = this.excludedFolders;
    excludeInput.addEventListener("change", (e) => {
      this.excludedFolders = (e.target as HTMLInputElement).value;
    });

    // 2. Existing Index Detection - Show ALL indices
    const indexCard = container.createDiv({
      cls: "nv2-wizard-service-card",
      attr: { style: "margin-top: 20px;" },
    });
    indexCard.createDiv({ cls: "nv2-wizard-service-title", text: "Available Indices" });

    // Async load all indices
    const indexList = indexCard.createDiv({ cls: "nv2-wizard-index-list" });
    indexList.createDiv({
      text: "Scanning for indices...",
      attr: { style: "color: var(--nv2-text-muted); font-size: 12px;" },
    });

    this.renderIndexList(indexList);
  }

  /** Render the list of all available indices with selection */
  private async renderIndexList(container: HTMLElement): Promise<void> {
    try {
      // Use cached indices if available and not expired
      const now = Date.now();
      let indices: Awaited<ReturnType<typeof this.indexManager.discoverIndices>>;

      if (this.cachedIndices && now - this.cacheTimestamp < SetupWizardModal.INDEX_CACHE_TTL_MS) {
        indices = this.cachedIndices;
      } else {
        indices = await this.indexManager.discoverIndices();
        this.cachedIndices = indices;
        this.cacheTimestamp = now;
      }
      container.empty();

      if (indices.length === 0) {
        container.createDiv({
          text: "No existing indices found. A new index will be created.",
          attr: { style: "color: var(--nv2-text-muted); font-size: 13px; padding: 8px 0;" },
        });
        this.indexStatus.compatibleFound = false;
        this.indexStatus.decision = "rebuild";
        this.result.indexAction = "rebuild";
        return;
      }

      // Get selected model's expected dimension (if we can determine it)
      const selectedModel = this.ollama.selectedModel;
      const expectedDim = this.getExpectedDimension(selectedModel);

      container.createDiv({
        text: expectedDim
          ? `Select an index to use (${selectedModel} expects ${expectedDim}d):`
          : "Select an index to use:",
        attr: { style: "color: var(--nv2-text-muted); font-size: 12px; margin-bottom: 8px;" },
      });

      // "Create New" option
      const createNewRow = container.createDiv({
        attr: {
          style: `display: flex; align-items: center; gap: 8px; padding: 10px; border: 1px solid var(--nv2-border-color); border-radius: 6px; margin-bottom: 6px; cursor: pointer; ${this.indexStatus.decision === "rebuild" ? "background: color-mix(in srgb, var(--interactive-accent), transparent 90%); border-color: var(--interactive-accent);" : ""}`,
        },
      });

      const createNewRadio = createNewRow.createEl("input", {
        type: "radio",
        attr: { name: "index-select" },
      });
      createNewRadio.checked = this.indexStatus.decision === "rebuild";
      createNewRow.createDiv({ text: "➕ Create New Index", attr: { style: "font-weight: 500;" } });
      createNewRow.createDiv({
        text: `Fresh index for ${selectedModel}`,
        attr: { style: "color: var(--nv2-text-muted); font-size: 11px; margin-left: auto;" },
      });

      createNewRow.addEventListener("click", () => {
        this.indexStatus.compatibleFound = false;
        this.indexStatus.decision = "rebuild";
        this.result.indexAction = "rebuild";
        this.result.selectedIndexKey = undefined;
        this.render();
      });

      // Sort indices: compatible first (indices already sorted by date from discoverIndices)
      const sortedIndices = [...indices].sort((a, b) => {
        const aCompat = !expectedDim || a.dimension === expectedDim;
        const bCompat = !expectedDim || b.dimension === expectedDim;
        if (aCompat && !bCompat) return -1;
        if (!aCompat && bCompat) return 1;
        return 0; // Preserve date-based order for same compatibility
      });

      // Render each index
      for (const idx of sortedIndices) {
        const isCompatible = !expectedDim || idx.dimension === expectedDim;
        const isSelected =
          this.result.selectedIndexKey === idx.path && this.indexStatus.decision === "resume";
        const isExternal = idx.source === "vault";

        // Format creation date
        const createdStr = idx.createdAt
          ? idx.createdAt.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })
          : null;

        const row = container.createDiv({
          attr: {
            style: `display: flex; align-items: center; gap: 8px; padding: 10px; border: 1px solid var(--nv2-border-color); border-radius: 6px; margin-bottom: 6px; ${!isCompatible ? "opacity: 0.5;" : "cursor: pointer;"} ${isSelected ? "background: color-mix(in srgb, var(--interactive-accent), transparent 90%); border-color: var(--interactive-accent);" : ""}`,
          },
        });

        const radio = row.createEl("input", { type: "radio", attr: { name: "index-select" } });
        radio.checked = isSelected;
        radio.disabled = !isCompatible;

        const infoCol = row.createDiv({ attr: { style: "flex: 1;" } });

        const titleRow = infoCol.createDiv({
          attr: { style: "display: flex; align-items: center; gap: 6px;" },
        });
        titleRow.createSpan({ text: idx.displayName, attr: { style: "font-weight: 500;" } });
        titleRow.createSpan({
          text: `${idx.dimension}d`,
          attr: { style: "color: var(--nv2-text-muted); font-size: 11px;" },
        });

        // Source badge
        const badgeStyle = isExternal
          ? "font-size: 9px; padding: 1px 4px; border-radius: 3px; background: var(--color-purple); color: white;"
          : "font-size: 9px; padding: 1px 4px; border-radius: 3px; background: var(--interactive-accent); color: var(--text-on-accent);";
        titleRow.createSpan({
          text: isExternal ? "EXTERNAL" : "PLUGIN",
          attr: { style: badgeStyle },
        });

        // Legacy badge
        if (idx.isLegacy) {
          titleRow.createSpan({
            text: "LEGACY",
            attr: {
              style:
                "font-size: 9px; padding: 1px 4px; border-radius: 3px; background: var(--color-orange); color: white;",
            },
          });
        }

        // Secondary info line with date and count
        const infoLine = infoCol.createDiv({
          attr: {
            style: "display: flex; gap: 8px; color: var(--nv2-text-muted); font-size: 11px;",
          },
        });
        infoLine.createSpan({ text: `${idx.docCount} chunks` });
        if (createdStr) {
          infoLine.createSpan({ text: `• Created ${createdStr}` });
        }
        if (idx.vaultHash) {
          infoLine.createSpan({ text: `• Vault ${idx.vaultHash}` });
        }

        // Compatibility indicator
        if (!isCompatible && expectedDim) {
          row.createDiv({
            text: `⚠️ ${idx.dimension}d ≠ ${expectedDim}d`,
            attr: {
              style: "color: var(--nv2-status-error); font-size: 11px; white-space: nowrap;",
              title: `Index has ${idx.dimension} dimensions but ${this.ollama.selectedModel} requires ${expectedDim} dimensions`,
            },
          });
        }

        // External index notice
        if (isExternal && isCompatible) {
          row.createDiv({
            text: "🔒",
            attr: { style: "font-size: 14px;", title: "External index (read-only)" },
          });
        }

        if (isCompatible) {
          row.addEventListener("click", () => {
            this.indexStatus.compatibleFound = true;
            this.indexStatus.existingModel = idx.modelKey;
            this.indexStatus.existingDim = idx.dimension;
            this.indexStatus.noteCount = idx.docCount;
            this.indexStatus.source = idx.source;
            this.indexStatus.decision = "resume";
            this.result.selectedIndexKey = idx.path;
            this.result.indexAction = "use_existing";
            this.render();
          });
        }
      }

      // Action summary
      const actionMsg = container.createDiv({
        attr: {
          style:
            "font-weight: 500; font-size: 13px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--nv2-border-color);",
        },
      });

      if (this.indexStatus.decision === "rebuild") {
        actionMsg.setText("✨ Action: Create new index and scan vault.");
      } else if (this.indexStatus.source === "vault") {
        actionMsg.setText("🔒 Action: Connect to external index (read-only).");
      } else {
        actionMsg.setText("✅ Action: Connect to existing plugin index.");
      }
    } catch (e) {
      container.empty();
      container.createDiv({
        text: `Error loading indices: ${e}`,
        attr: { style: "color: var(--nv2-status-error); font-size: 12px;" },
      });
    }
  }

  /** Get expected dimension for a model (if known) */
  private getExpectedDimension(modelName: string): number | null {
    // Common embedding model dimensions
    const knownDimensions: Record<string, number> = {
      "nomic-embed-text": 768,
      "mxbai-embed-large": 1024,
      "all-minilm": 384,
      "bge-small-en-v1.5": 384,
      "bge-base-en-v1.5": 768,
      "bge-large-en-v1.5": 1024,
      "e5-small-v2": 384,
      "e5-base-v2": 768,
      "e5-large-v2": 1024,
    };

    const normalized = modelName.toLowerCase();
    for (const [key, dim] of Object.entries(knownDimensions)) {
      if (normalized.includes(key.toLowerCase())) {
        return dim;
      }
    }
    return null;
  }

  private renderFooter(container: HTMLElement): void {
    const footer = container.createDiv({ cls: "nv2-wizard-footer" });

    // Back Button
    if (this.currentStep > WizardStep.INTRO) {
      const backBtn = footer.createEl("button", { cls: "nv2-wizard-btn", text: "Back" });
      backBtn.addEventListener("click", () => {
        this.currentStep--;
        this.render();
      });
    } else {
      footer.createDiv(); // Spacer
    }

    // Next/Finish Button
    const nextText = this.currentStep === WizardStep.INDEXING ? "Finish & Build" : "Next";
    const nextBtn = footer.createEl("button", {
      cls: "nv2-wizard-btn primary",
      text: nextText,
    });

    // Validation
    if (
      this.currentStep === WizardStep.SERVICES &&
      (this.ollama.status !== "connected" || this.lmstudio.status !== "connected")
    ) {
      nextBtn.disabled = true;
      nextBtn.title = "Connect services to proceed";
    }

    nextBtn.addEventListener("click", () => {
      if (this.currentStep < WizardStep.INDEXING) {
        this.currentStep++;
        this.render();
      } else {
        this.finish();
      }
    });
  }

  // ==================== Logic ====================

  private isLocal(ip: string): boolean {
    return ip === "localhost" || ip === "127.0.0.1";
  }

  /**
   * Scan for existing indexes using centralized IndexManager.
   * NOTE: This no longer auto-selects an index. The user must choose explicitly.
   */
  private async scanForIndexes(): Promise<void> {
    // Reset to default state - user must explicitly choose
    this.indexStatus.compatibleFound = false;
    this.indexStatus.decision = "rebuild";
    this.result.selectedIndexKey = undefined;
    this.result.indexAction = "rebuild";

    // Invalidate cache when model changes to force fresh scan
    this.cachedIndices = null;
    this.cacheTimestamp = 0;

    const currentEmbModel = this.ollama.selectedModel;
    if (!currentEmbModel) return;

    try {
      const indices = await this.indexManager.discoverIndices();
      // Update cache with fresh data
      this.cachedIndices = indices;
      this.cacheTimestamp = Date.now();
      const expectedDim = this.getExpectedDimension(currentEmbModel);

      // Just log what we found - no auto-selection
      console.log(
        `[SetupWizard] Found ${indices.length} indices for model '${currentEmbModel}' (expected dim: ${expectedDim ?? "unknown"})`,
      );

      // Check if any compatible indices exist (for UI hints)
      const hasCompatible = indices.some((idx) => !expectedDim || idx.dimension === expectedDim);
      if (hasCompatible) {
        console.log("[SetupWizard] Compatible indices available - user must select explicitly");
      }
    } catch (e) {
      console.error("Error discovering indexes", e);
    }
  }

  private async checkOllama() {
    this.ollama.status = "checking";
    this.render(); // Update UI
    try {
      const url = `http://${this.ollama.ip}:${this.ollama.port}`;
      const models = await this.healthMonitor.fetchOllamaModels(url);
      if (models.length > 0) {
        this.ollama.status = "connected";
        this.ollama.models = models;
        if (!this.ollama.selectedModel) {
          const embed = models.find((m) => m.capabilities.includes("embedding"));
          this.ollama.selectedModel = embed?.name || models[0].name;
        }
        // Trigger scan once connected
        await this.scanForIndexes();
      } else {
        this.ollama.status = "error";
        this.ollama.error = "No models found";
      }
    } catch (e) {
      this.ollama.status = "error";
      this.ollama.error = "Connection failed";
    }
    this.render();
  }

  private async checkLMStudio() {
    this.lmstudio.status = "checking";
    this.render();
    try {
      const url = `http://${this.lmstudio.ip}:${this.lmstudio.port}`;
      const models = await this.healthMonitor.fetchLMStudioModels(url);
      if (models.length > 0) {
        this.lmstudio.status = "connected";
        this.lmstudio.models = models;
        if (!this.lmstudio.selectedModel) {
          this.lmstudio.selectedModel = models[0].name;
        }
      } else {
        this.lmstudio.status = "error";
        this.lmstudio.error = "No models found";
      }
    } catch (e) {
      this.lmstudio.status = "error";
      this.lmstudio.error = "Connection failed";
    }
    this.render();
  }

  private finish() {
    this.result.completed = true;
    this.result.settings = {
      ollama: {
        host: `http://${this.ollama.ip}:${this.ollama.port}`,
        embeddingModel: this.ollama.selectedModel,
        enabled: true,
      },
      lmstudio: {
        host: `http://${this.lmstudio.ip}:${this.lmstudio.port}`,
        reasoningModel: this.lmstudio.selectedModel,
        enabled: true,
      },
      indexing: {
        chunkSize: this.chunkSize,
        excludedFolders: this.excludedFolders
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s),
        batchSize: 4, // default
        debounceMs: 2000, // default
        activeIndexPath: this.result.selectedIndexKey || null,
        activeIndexMeta: null, // Will be populated on plugin init
      },
      setupComplete: true,
    };
    // Force rebuild if user didn't select existing
    if (!this.indexStatus.compatibleFound || this.indexStatus.decision === "rebuild") {
      this.result.indexAction = "rebuild";
    }
    this.close();
  }
}
