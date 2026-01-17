/**
 * Notient Setup Wizard - First-run guided setup modal
 * Source of truth: .planning/PHASE-GALAXY.md (Phase G6)
 *
 * Per spec decisions:
 * - Step 1: Configure reasoning LLM
 * - Step 2: Configure embedding provider
 * - Step 3: Test connections
 * - Step 4: Index options (start background index)
 */

import { type App, Modal, Notice, Setting } from "obsidian";
import type NotientPlugin from "../../main";
import type { ConnectionTestResult, ProviderType, WizardStep } from "../settings/types";

const PROVIDER_TYPES: { value: ProviderType; label: string }[] = [
  { value: "lmstudio", label: "LM Studio" },
  { value: "ollama", label: "Ollama" },
  { value: "openai-compatible", label: "OpenAI Compatible" },
];

export class SetupWizard extends Modal {
  private plugin: NotientPlugin;
  private currentStep: WizardStep = "reasoning-provider";
  private reasoningTestResult: ConnectionTestResult | null = null;
  private embeddingTestResult: ConnectionTestResult | null = null;
  private onComplete: () => void;

  constructor(app: App, plugin: NotientPlugin, onComplete: () => void) {
    super(app);
    this.plugin = plugin;
    this.onComplete = onComplete;
  }

  onOpen(): void {
    this.renderStep();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderStep(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("notient-setup-wizard");

    contentEl.createEl("h1", { text: "Notient Setup" });
    contentEl.createEl("p", {
      text: this.getStepDescription(),
      cls: "notient-wizard-description",
    });

    switch (this.currentStep) {
      case "reasoning-provider":
        this.renderReasoningProviderStep(contentEl);
        break;
      case "embedding-provider":
        this.renderEmbeddingProviderStep(contentEl);
        break;
      case "test-connections":
        this.renderTestConnectionsStep(contentEl);
        break;
      case "index-options":
        this.renderIndexOptionsStep(contentEl);
        break;
    }
  }

  private getStepDescription(): string {
    const descriptions: Record<WizardStep, string> = {
      "reasoning-provider": "Step 1 of 4: Configure your reasoning LLM provider (e.g., LM Studio)",
      "embedding-provider": "Step 2 of 4: Configure your embedding provider (e.g., Ollama)",
      "test-connections": "Step 3 of 4: Test connections to your providers",
      "index-options": "Step 4 of 4: Configure indexing and start",
    };
    return descriptions[this.currentStep];
  }

  private renderReasoningProviderStep(containerEl: HTMLElement): void {
    const { reasoningProvider } = this.plugin.settings;

    new Setting(containerEl).setName("Provider type").addDropdown((dropdown) => {
      for (const { value, label } of PROVIDER_TYPES) {
        dropdown.addOption(value, label);
      }
      dropdown.setValue(reasoningProvider.type);
      dropdown.onChange(async (value) => {
        this.plugin.settings.reasoningProvider.type = value as ProviderType;
      });
    });

    new Setting(containerEl).setName("Base URL").addText((text) => {
      text
        .setPlaceholder("http://localhost:1234/v1")
        .setValue(reasoningProvider.baseUrl)
        .onChange((value) => {
          this.plugin.settings.reasoningProvider.baseUrl = value;
        });
    });

    new Setting(containerEl).setName("Model").addText((text) => {
      text
        .setPlaceholder("default")
        .setValue(reasoningProvider.model)
        .onChange((value) => {
          this.plugin.settings.reasoningProvider.model = value;
        });
    });

    this.renderNavigation(containerEl, null, "embedding-provider");
  }

  private renderEmbeddingProviderStep(containerEl: HTMLElement): void {
    const { embeddingProvider } = this.plugin.settings;

    new Setting(containerEl).setName("Provider type").addDropdown((dropdown) => {
      for (const { value, label } of PROVIDER_TYPES) {
        dropdown.addOption(value, label);
      }
      dropdown.setValue(embeddingProvider.type);
      dropdown.onChange(async (value) => {
        this.plugin.settings.embeddingProvider.type = value as ProviderType;
      });
    });

    new Setting(containerEl).setName("Base URL").addText((text) => {
      text
        .setPlaceholder("http://localhost:11434")
        .setValue(embeddingProvider.baseUrl)
        .onChange((value) => {
          this.plugin.settings.embeddingProvider.baseUrl = value;
        });
    });

    new Setting(containerEl).setName("Model").addText((text) => {
      text
        .setPlaceholder("nomic-embed-text")
        .setValue(embeddingProvider.model)
        .onChange((value) => {
          this.plugin.settings.embeddingProvider.model = value;
        });
    });

    this.renderNavigation(containerEl, "reasoning-provider", "test-connections");
  }

  private renderTestConnectionsStep(containerEl: HTMLElement): void {
    const reasoningStatus = this.reasoningTestResult
      ? this.reasoningTestResult.success
        ? `✓ Connected (${this.reasoningTestResult.latencyMs}ms)`
        : `✗ ${this.reasoningTestResult.error}`
      : "Not tested";

    const embeddingStatus = this.embeddingTestResult
      ? this.embeddingTestResult.success
        ? `✓ Connected (${this.embeddingTestResult.latencyMs}ms)`
        : `✗ ${this.embeddingTestResult.error}`
      : "Not tested";

    new Setting(containerEl)
      .setName("Reasoning provider")
      .setDesc(reasoningStatus)
      .addButton((button) => {
        button.setButtonText("Test").onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("Testing...");
          this.reasoningTestResult = await this.testConnection("reasoning");
          this.renderStep();
        });
      });

    new Setting(containerEl)
      .setName("Embedding provider")
      .setDesc(embeddingStatus)
      .addButton((button) => {
        button.setButtonText("Test").onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("Testing...");
          this.embeddingTestResult = await this.testConnection("embedding");
          this.renderStep();
        });
      });

    const canProceed = this.reasoningTestResult?.success && this.embeddingTestResult?.success;

    this.renderNavigation(containerEl, "embedding-provider", canProceed ? "index-options" : null);
  }

  private renderIndexOptionsStep(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("Folders to skip during indexing (comma-separated)")
      .addTextArea((textarea) => {
        textarea
          .setPlaceholder(".obsidian, .trash")
          .setValue(this.plugin.settings.excludedFolders.join(", "))
          .onChange((value) => {
            this.plugin.settings.excludedFolders = value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
          });
        textarea.inputEl.rows = 2;
      });

    this.renderNavigation(containerEl, "test-connections", null, true);
  }

  private renderNavigation(
    containerEl: HTMLElement,
    prevStep: WizardStep | null,
    nextStep: WizardStep | null,
    isFinal = false,
  ): void {
    const navEl = containerEl.createDiv({ cls: "notient-wizard-nav" });

    if (prevStep) {
      const backBtn = navEl.createEl("button", { text: "Back" });
      backBtn.addEventListener("click", () => {
        this.currentStep = prevStep;
        this.renderStep();
      });
    }

    if (isFinal) {
      const finishBtn = navEl.createEl("button", {
        text: "Start Indexing",
        cls: "mod-cta",
      });
      finishBtn.addEventListener("click", async () => {
        await this.plugin.saveSettings();
        new Notice("Notient setup complete. Indexing will start in background.");
        this.close();
        this.onComplete();
      });
    } else if (nextStep) {
      const nextBtn = navEl.createEl("button", { text: "Next", cls: "mod-cta" });
      nextBtn.addEventListener("click", () => {
        this.currentStep = nextStep;
        this.renderStep();
      });
    }
  }

  private async testConnection(type: "reasoning" | "embedding"): Promise<ConnectionTestResult> {
    const config =
      type === "reasoning"
        ? this.plugin.settings.reasoningProvider
        : this.plugin.settings.embeddingProvider;

    const start = Date.now();
    try {
      const endpoint =
        type === "reasoning"
          ? `${config.baseUrl}/models`
          : config.type === "ollama"
            ? `${config.baseUrl}/api/tags`
            : `${config.baseUrl}/models`;

      const response = await fetch(endpoint, {
        method: "GET",
        headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }

      return { success: true, latencyMs: Date.now() - start };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connection failed";
      return { success: false, error: message };
    }
  }
}
