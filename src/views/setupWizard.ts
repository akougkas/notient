/**
 * Setup Wizard Modal
 *
 * Guides the user through initial configuration.
 * BOTH Ollama AND LM Studio are REQUIRED for plugin functionality.
 */

import { Modal, App, Setting } from "obsidian";
import type { NotientSettings } from "../types/settings";
import type { HealthMonitor } from "../services/healthMonitor";
import type { AvailableModel } from "../types/services";

export interface SetupWizardResult {
  completed: boolean;
  settings: Partial<NotientSettings>;
}

type WizardStep =
  | "welcome"
  | "ollama"
  | "embedding-model"
  | "lmstudio"
  | "reasoning-model"
  | "indexing"
  | "complete";

export class SetupWizardModal extends Modal {
  private result: SetupWizardResult = { completed: false, settings: {} };
  private currentStep: WizardStep = "welcome";

  // Ollama state (REQUIRED)
  private ollamaHost: string;
  private ollamaStatus: "idle" | "checking" | "healthy" | "unhealthy" = "idle";
  private ollamaError: string = "";
  private ollamaModels: AvailableModel[] = [];
  private selectedEmbeddingModel: string = "";

  // LM Studio state (REQUIRED)
  private lmstudioHost: string;
  private lmstudioStatus: "idle" | "checking" | "healthy" | "unhealthy" = "idle";
  private lmstudioError: string = "";
  private lmstudioModels: AvailableModel[] = [];
  private selectedReasoningModel: string = "";

  private resolvePromise: ((result: SetupWizardResult) => void) | null = null;

  constructor(
    app: App,
    private healthMonitor: HealthMonitor,
    private currentSettings: NotientSettings
  ) {
    super(app);
    this.ollamaHost = currentSettings.ollama.host;
    this.lmstudioHost = currentSettings.lmstudio.host;
    this.selectedEmbeddingModel = currentSettings.ollama.embeddingModel;
    this.selectedReasoningModel = currentSettings.lmstudio.reasoningModel;
  }

  async run(): Promise<SetupWizardResult> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }

  onOpen(): void {
    this.containerEl.addClass("notient-wizard");
    this.modalEl.style.width = "600px";
    this.renderStep();
  }

  onClose(): void {
    if (this.resolvePromise) {
      this.resolvePromise(this.result);
      this.resolvePromise = null;
    }
  }

  // ==================== Connection Checks ====================

  private async checkOllama(): Promise<void> {
    this.ollamaStatus = "checking";
    this.ollamaError = "";
    this.renderStep();

    try {
      console.log(`[SetupWizard] Testing Ollama at ${this.ollamaHost}`);

      // Add timeout to fetch
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const models = await this.healthMonitor.fetchOllamaModels(this.ollamaHost);
      clearTimeout(timeout);

      console.log(`[SetupWizard] Ollama returned ${models.length} models`);

      if (models.length > 0) {
        this.ollamaStatus = "healthy";
        this.ollamaModels = models;

        // Auto-select first embedding model if none selected
        if (!this.selectedEmbeddingModel) {
          const embeddingModels = models.filter((m) =>
            m.capabilities.includes("embedding")
          );
          if (embeddingModels.length > 0) {
            this.selectedEmbeddingModel = embeddingModels[0].name;
          }
        }
      } else {
        this.ollamaStatus = "unhealthy";
        this.ollamaError = "Connected but no models found. Run: ollama pull nomic-embed-text";
      }
    } catch (err) {
      this.ollamaStatus = "unhealthy";
      if (err instanceof Error) {
        if (err.name === "AbortError") {
          this.ollamaError = "Connection timeout (10s). Check if Ollama is running.";
        } else {
          this.ollamaError = err.message;
        }
      } else {
        this.ollamaError = "Connection failed. Is Ollama running?";
      }
      this.ollamaModels = [];
      console.error("[SetupWizard] Ollama check failed:", err);
    }

    this.renderStep();
  }

  private async checkLMStudio(): Promise<void> {
    this.lmstudioStatus = "checking";
    this.lmstudioError = "";
    this.renderStep();

    try {
      console.log(`[SetupWizard] Testing LM Studio at ${this.lmstudioHost}`);

      const models = await this.healthMonitor.fetchLMStudioModels(this.lmstudioHost);
      console.log(`[SetupWizard] LM Studio returned ${models.length} models`);

      if (models.length > 0) {
        this.lmstudioStatus = "healthy";
        this.lmstudioModels = models;

        // Auto-select first model if none selected
        if (!this.selectedReasoningModel) {
          this.selectedReasoningModel = models[0].name;
        }
      } else {
        this.lmstudioStatus = "unhealthy";
        this.lmstudioError = "Connected but no models loaded. Load a model in LM Studio.";
      }
    } catch (err) {
      this.lmstudioStatus = "unhealthy";
      if (err instanceof Error) {
        this.lmstudioError = err.message;
      } else {
        this.lmstudioError = "Connection failed. Is LM Studio server running?";
      }
      this.lmstudioModels = [];
      console.error("[SetupWizard] LM Studio check failed:", err);
    }

    this.renderStep();
  }

  // ==================== Rendering ====================

  private renderStep(): void {
    const { contentEl } = this;
    contentEl.empty();

    switch (this.currentStep) {
      case "welcome":
        this.renderWelcome();
        break;
      case "ollama":
        this.renderOllama();
        break;
      case "embedding-model":
        this.renderEmbeddingModel();
        break;
      case "lmstudio":
        this.renderLMStudio();
        break;
      case "reasoning-model":
        this.renderReasoningModel();
        break;
      case "indexing":
        this.renderIndexing();
        break;
      case "complete":
        this.renderComplete();
        break;
    }
  }

  private renderWelcome(): void {
    const { contentEl } = this;

    contentEl.createEl("h1", { text: "Welcome to Notient" });

    contentEl.createEl("p", {
      text: "AI-powered vault management using local LLMs. Your data never leaves your machine.",
    });

    const reqBox = contentEl.createDiv({ cls: "notient-wizard-requirements" });
    reqBox.createEl("h3", { text: "Required Services" });

    const reqList = reqBox.createEl("ul");
    reqList.createEl("li").innerHTML = "<strong>Ollama</strong> - For generating embeddings (semantic search)";
    reqList.createEl("li").innerHTML = "<strong>LM Studio</strong> - For AI reasoning and suggestions";

    const note = contentEl.createDiv({ cls: "notient-wizard-note" });
    note.innerHTML = "💡 <strong>Tip:</strong> Both services can run on a remote machine with a GPU. You'll configure the host URLs in the next steps.";

    const warning = contentEl.createDiv({ cls: "notient-wizard-warning" });
    warning.innerHTML = "⚠️ <strong>Both services are required.</strong> Notient cannot function without them.";

    const actions = contentEl.createDiv({ cls: "notient-wizard-actions" });
    const nextBtn = actions.createEl("button", {
      text: "Configure Ollama →",
      cls: "mod-cta",
    });
    nextBtn.addEventListener("click", () => {
      this.currentStep = "ollama";
      this.renderStep();
    });
  }

  private renderOllama(): void {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: "Step 1: Connect to Ollama" });
    contentEl.createEl("p", {
      text: "Ollama provides embeddings for semantic search. This is required.",
      cls: "notient-wizard-required"
    });

    // Host input
    new Setting(contentEl)
      .setName("Ollama Host URL")
      .setDesc("The URL where Ollama is running")
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:11434")
          .setValue(this.ollamaHost)
          .onChange((value) => {
            this.ollamaHost = value.trim();
            this.ollamaStatus = "idle";
          })
      );

    // Test button
    const testRow = contentEl.createDiv({ cls: "notient-wizard-test-row" });
    const testBtn = testRow.createEl("button", {
      text: this.ollamaStatus === "checking" ? "Testing..." : "Test Connection",
      cls: "notient-test-btn"
    });
    testBtn.disabled = this.ollamaStatus === "checking";
    testBtn.addEventListener("click", () => this.checkOllama());

    // Status display
    const statusDiv = contentEl.createDiv({ cls: "notient-wizard-status" });
    this.renderConnectionStatus(statusDiv, this.ollamaStatus, this.ollamaError, this.ollamaModels.length);

    // Show available models if connected
    if (this.ollamaStatus === "healthy" && this.ollamaModels.length > 0) {
      const modelsDiv = contentEl.createDiv({ cls: "notient-wizard-models" });
      modelsDiv.createEl("h4", { text: `Found ${this.ollamaModels.length} models:` });
      const modelList = modelsDiv.createEl("ul");
      for (const model of this.ollamaModels.slice(0, 8)) {
        const caps = model.capabilities.length > 0 ? ` (${model.capabilities.join(", ")})` : "";
        modelList.createEl("li", { text: `${model.name}${caps}` });
      }
      if (this.ollamaModels.length > 8) {
        modelList.createEl("li", { text: `... and ${this.ollamaModels.length - 8} more` });
      }
    }

    // Troubleshooting
    if (this.ollamaStatus === "unhealthy") {
      this.renderOllamaTroubleshooting(contentEl);
    }

    // Navigation
    const actions = contentEl.createDiv({ cls: "notient-wizard-actions" });

    const backBtn = actions.createEl("button", { text: "← Back" });
    backBtn.addEventListener("click", () => {
      this.currentStep = "welcome";
      this.renderStep();
    });

    const canProceed = this.ollamaStatus === "healthy" && this.ollamaModels.length > 0;
    const nextBtn = actions.createEl("button", {
      text: "Select Embedding Model →",
      cls: canProceed ? "mod-cta" : "",
    });
    nextBtn.disabled = !canProceed;
    if (!canProceed) {
      nextBtn.title = "Connect to Ollama first";
    }
    nextBtn.addEventListener("click", () => {
      this.currentStep = "embedding-model";
      this.renderStep();
    });
  }

  private renderEmbeddingModel(): void {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: "Step 2: Select Embedding Model" });
    contentEl.createEl("p", {
      text: "Choose which Ollama model to use for generating embeddings.",
    });

    // Separate embedding models from others
    const embeddingModels = this.ollamaModels.filter((m) =>
      m.capabilities.includes("embedding")
    );
    const otherModels = this.ollamaModels.filter(
      (m) => !m.capabilities.includes("embedding")
    );

    // Dropdown for model selection
    new Setting(contentEl)
      .setName("Embedding Model")
      .setDesc(embeddingModels.length > 0
        ? "Models marked with ⭐ are optimized for embeddings"
        : "No embedding-specific models found. Select any model.")
      .addDropdown((dropdown) => {
        // Embedding models first (recommended)
        for (const m of embeddingModels) {
          dropdown.addOption(m.name, `⭐ ${m.name} (embedding)`);
        }
        // Then other models
        for (const m of otherModels) {
          dropdown.addOption(m.name, m.name);
        }

        dropdown.setValue(this.selectedEmbeddingModel || (embeddingModels[0]?.name ?? otherModels[0]?.name ?? ""));
        dropdown.onChange((value) => {
          this.selectedEmbeddingModel = value;
          this.renderStep();
        });
      });

    // Manual input option
    new Setting(contentEl)
      .setName("Or enter model name manually")
      .setDesc("If your model isn't listed above")
      .addText((text) =>
        text
          .setPlaceholder("e.g., nomic-embed-text")
          .setValue(this.ollamaModels.find(m => m.name === this.selectedEmbeddingModel) ? "" : this.selectedEmbeddingModel)
          .onChange((value) => {
            if (value.trim()) {
              this.selectedEmbeddingModel = value.trim();
            }
          })
      );

    // Show current selection
    if (this.selectedEmbeddingModel) {
      const selectedDiv = contentEl.createDiv({ cls: "notient-wizard-selected" });
      selectedDiv.innerHTML = `✓ Selected: <strong>${this.selectedEmbeddingModel}</strong>`;
    }

    // Navigation
    const actions = contentEl.createDiv({ cls: "notient-wizard-actions" });

    const backBtn = actions.createEl("button", { text: "← Back" });
    backBtn.addEventListener("click", () => {
      this.currentStep = "ollama";
      this.renderStep();
    });

    const canProceed = Boolean(this.selectedEmbeddingModel);
    const nextBtn = actions.createEl("button", {
      text: "Configure LM Studio →",
      cls: canProceed ? "mod-cta" : "",
    });
    nextBtn.disabled = !canProceed;
    nextBtn.addEventListener("click", () => {
      this.currentStep = "lmstudio";
      this.renderStep();
    });
  }

  private renderLMStudio(): void {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: "Step 3: Connect to LM Studio" });
    contentEl.createEl("p", {
      text: "LM Studio provides AI reasoning capabilities. This is required.",
      cls: "notient-wizard-required"
    });

    // Host input
    new Setting(contentEl)
      .setName("LM Studio Host URL")
      .setDesc("The URL where LM Studio's local server is running")
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:1234")
          .setValue(this.lmstudioHost)
          .onChange((value) => {
            this.lmstudioHost = value.trim();
            this.lmstudioStatus = "idle";
          })
      );

    // Test button
    const testRow = contentEl.createDiv({ cls: "notient-wizard-test-row" });
    const testBtn = testRow.createEl("button", {
      text: this.lmstudioStatus === "checking" ? "Testing..." : "Test Connection",
      cls: "notient-test-btn"
    });
    testBtn.disabled = this.lmstudioStatus === "checking";
    testBtn.addEventListener("click", () => this.checkLMStudio());

    // Status display
    const statusDiv = contentEl.createDiv({ cls: "notient-wizard-status" });
    this.renderConnectionStatus(statusDiv, this.lmstudioStatus, this.lmstudioError, this.lmstudioModels.length);

    // Show available models if connected
    if (this.lmstudioStatus === "healthy" && this.lmstudioModels.length > 0) {
      const modelsDiv = contentEl.createDiv({ cls: "notient-wizard-models" });
      modelsDiv.createEl("h4", { text: `Found ${this.lmstudioModels.length} model(s):` });
      const modelList = modelsDiv.createEl("ul");
      for (const model of this.lmstudioModels) {
        modelList.createEl("li", { text: model.name });
      }
    }

    // Troubleshooting
    if (this.lmstudioStatus === "unhealthy") {
      this.renderLMStudioTroubleshooting(contentEl);
    }

    // Navigation
    const actions = contentEl.createDiv({ cls: "notient-wizard-actions" });

    const backBtn = actions.createEl("button", { text: "← Back" });
    backBtn.addEventListener("click", () => {
      this.currentStep = "embedding-model";
      this.renderStep();
    });

    const canProceed = this.lmstudioStatus === "healthy" && this.lmstudioModels.length > 0;
    const nextBtn = actions.createEl("button", {
      text: "Select Reasoning Model →",
      cls: canProceed ? "mod-cta" : "",
    });
    nextBtn.disabled = !canProceed;
    if (!canProceed) {
      nextBtn.title = "Connect to LM Studio first";
    }
    nextBtn.addEventListener("click", () => {
      this.currentStep = "reasoning-model";
      this.renderStep();
    });
  }

  private renderReasoningModel(): void {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: "Step 4: Select Reasoning Model" });
    contentEl.createEl("p", {
      text: "Choose which LM Studio model to use for AI reasoning and suggestions.",
    });

    // Dropdown for model selection
    new Setting(contentEl)
      .setName("Reasoning Model")
      .setDesc("The model currently loaded in LM Studio")
      .addDropdown((dropdown) => {
        for (const m of this.lmstudioModels) {
          dropdown.addOption(m.name, m.name);
        }

        dropdown.setValue(this.selectedReasoningModel || this.lmstudioModels[0]?.name || "");
        dropdown.onChange((value) => {
          this.selectedReasoningModel = value;
          this.renderStep();
        });
      });

    // Manual input option
    new Setting(contentEl)
      .setName("Or enter model ID manually")
      .setDesc("If your model isn't listed above")
      .addText((text) =>
        text
          .setPlaceholder("e.g., mistralai/ministral-3-14b")
          .setValue(this.lmstudioModels.find(m => m.name === this.selectedReasoningModel) ? "" : this.selectedReasoningModel)
          .onChange((value) => {
            if (value.trim()) {
              this.selectedReasoningModel = value.trim();
            }
          })
      );

    // Show current selection
    if (this.selectedReasoningModel) {
      const selectedDiv = contentEl.createDiv({ cls: "notient-wizard-selected" });
      selectedDiv.innerHTML = `✓ Selected: <strong>${this.selectedReasoningModel}</strong>`;
    }

    // Navigation
    const actions = contentEl.createDiv({ cls: "notient-wizard-actions" });

    const backBtn = actions.createEl("button", { text: "← Back" });
    backBtn.addEventListener("click", () => {
      this.currentStep = "lmstudio";
      this.renderStep();
    });

    const canProceed = Boolean(this.selectedReasoningModel);
    const nextBtn = actions.createEl("button", {
      text: "Indexing Options →",
      cls: canProceed ? "mod-cta" : "",
    });
    nextBtn.disabled = !canProceed;
    nextBtn.addEventListener("click", () => {
      this.currentStep = "indexing";
      this.renderStep();
    });
  }

  private renderIndexing(): void {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: "Step 5: Indexing Options" });
    contentEl.createEl("p", {
      text: "Configure how Notient indexes your vault for semantic search.",
    });

    new Setting(contentEl)
      .setName("Chunk Size")
      .setDesc("Characters per chunk. Recommended: 500-1500")
      .addText((text) =>
        text
          .setPlaceholder("1000")
          .setValue(String(this.currentSettings.indexing.chunkSize))
          .onChange((value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 100 && num <= 5000) {
              this.result.settings.indexing = {
                ...this.currentSettings.indexing,
                ...this.result.settings.indexing,
                chunkSize: num,
              };
            }
          })
      );

    new Setting(contentEl)
      .setName("Excluded Folders")
      .setDesc("Folders to skip during indexing (comma-separated)")
      .addText((text) =>
        text
          .setPlaceholder(".obsidian, templates")
          .setValue(this.currentSettings.indexing.excludedFolders.join(", "))
          .onChange((value) => {
            this.result.settings.indexing = {
              ...this.currentSettings.indexing,
              ...this.result.settings.indexing,
              excludedFolders: value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            };
          })
      );

    // Navigation
    const actions = contentEl.createDiv({ cls: "notient-wizard-actions" });

    const backBtn = actions.createEl("button", { text: "← Back" });
    backBtn.addEventListener("click", () => {
      this.currentStep = "reasoning-model";
      this.renderStep();
    });

    const nextBtn = actions.createEl("button", {
      text: "Review & Finish →",
      cls: "mod-cta",
    });
    nextBtn.addEventListener("click", () => {
      this.currentStep = "complete";
      this.renderStep();
    });
  }

  private renderComplete(): void {
    const { contentEl } = this;

    contentEl.createEl("h1", { text: "Setup Complete!" });

    const summary = contentEl.createDiv({ cls: "notient-wizard-summary" });
    summary.createEl("h3", { text: "Your Configuration:" });

    const table = summary.createEl("table", { cls: "notient-config-table" });

    this.addConfigRow(table, "Ollama Host", this.ollamaHost);
    this.addConfigRow(table, "Embedding Model", this.selectedEmbeddingModel);
    this.addConfigRow(table, "LM Studio Host", this.lmstudioHost);
    this.addConfigRow(table, "Reasoning Model", this.selectedReasoningModel);

    contentEl.createEl("p", {
      text: "Click 'Start Notient' to save your configuration and begin indexing your vault.",
    });

    const note = contentEl.createDiv({ cls: "notient-wizard-note" });
    note.innerHTML = "💡 Indexing runs in the background. You can use Obsidian while it processes.";

    // Navigation
    const actions = contentEl.createDiv({ cls: "notient-wizard-actions" });

    const backBtn = actions.createEl("button", { text: "← Back" });
    backBtn.addEventListener("click", () => {
      this.currentStep = "indexing";
      this.renderStep();
    });

    const startBtn = actions.createEl("button", {
      text: "Start Notient",
      cls: "mod-cta",
    });
    startBtn.addEventListener("click", () => {
      this.finalizeSettings();
      this.close();
    });
  }

  // ==================== Helpers ====================

  private renderConnectionStatus(
    container: HTMLElement,
    status: "idle" | "checking" | "healthy" | "unhealthy",
    error: string,
    modelCount: number
  ): void {
    container.empty();

    const statusEl = container.createDiv({ cls: `notient-status notient-status-${status}` });

    switch (status) {
      case "idle":
        statusEl.innerHTML = "⏸️ Click 'Test Connection' to verify";
        break;
      case "checking":
        statusEl.innerHTML = "⏳ Testing connection...";
        break;
      case "healthy":
        statusEl.innerHTML = `✅ Connected successfully! Found ${modelCount} model(s).`;
        break;
      case "unhealthy":
        statusEl.innerHTML = `❌ Connection failed: ${error}`;
        break;
    }
  }

  private renderOllamaTroubleshooting(container: HTMLElement): void {
    const help = container.createDiv({ cls: "notient-wizard-troubleshooting" });
    help.createEl("h4", { text: "Troubleshooting Ollama:" });
    const list = help.createEl("ul");
    list.createEl("li", { text: "Ensure Ollama is installed and running" });
    list.createEl("li", { text: "Start Ollama with: ollama serve" });
    list.createEl("li", { text: "For remote access: OLLAMA_HOST=0.0.0.0 ollama serve" });
    list.createEl("li", { text: "Check firewall allows connections on port 11434" });
    list.createEl("li", { text: "Pull an embedding model: ollama pull nomic-embed-text" });
  }

  private renderLMStudioTroubleshooting(container: HTMLElement): void {
    const help = container.createDiv({ cls: "notient-wizard-troubleshooting" });
    help.createEl("h4", { text: "Troubleshooting LM Studio:" });
    const list = help.createEl("ul");
    list.createEl("li", { text: "Ensure LM Studio is running with a model loaded" });
    list.createEl("li", { text: "Enable the local server: Settings → Local Server → Start Server" });
    list.createEl("li", { text: "Default port is 1234 (check LM Studio settings)" });
    list.createEl("li", { text: "For remote access: enable 'Serve on Local Network'" });
    list.createEl("li", { text: "Check that CORS is enabled in LM Studio settings" });
  }

  private addConfigRow(table: HTMLTableElement, label: string, value: string): void {
    const row = table.createEl("tr");
    row.createEl("td", { text: label, cls: "notient-config-label" });
    row.createEl("td", { text: value, cls: "notient-config-value" });
  }

  private finalizeSettings(): void {
    // Compile final settings - both services are REQUIRED and ENABLED
    this.result.settings.ollama = {
      ...this.currentSettings.ollama,
      host: this.ollamaHost,
      embeddingModel: this.selectedEmbeddingModel,
      enabled: true, // Always enabled - required
    };

    this.result.settings.lmstudio = {
      ...this.currentSettings.lmstudio,
      host: this.lmstudioHost,
      reasoningModel: this.selectedReasoningModel,
      enabled: true, // Always enabled - required
    };

    this.result.completed = true;
    this.result.settings.setupComplete = true;

    console.log("[SetupWizard] Configuration finalized:", {
      ollamaHost: this.ollamaHost,
      embeddingModel: this.selectedEmbeddingModel,
      lmstudioHost: this.lmstudioHost,
      reasoningModel: this.selectedReasoningModel,
    });
  }
}
