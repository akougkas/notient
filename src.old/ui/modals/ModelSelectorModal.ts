/**
 * Model Selector Modal
 *
 * Obsidian-native modal for selecting AI models from LM Studio.
 */

import { type App, Modal, Notice, Setting } from "obsidian";
import type { Kernel } from "../../core/kernel";
import type { LLMProvider } from "../../core/llm/provider";

interface Model {
  id: string;
  name: string;
  path: string;
}

export class ModelSelectorModal extends Modal {
  private kernel: Kernel;
  private currentModel: string | null;
  private models: Model[] = [];
  private isLoading = false;
  private error: string | null = null;

  constructor(app: App, kernel: Kernel, currentModel: string | null) {
    super(app);
    this.kernel = kernel;
    this.currentModel = currentModel;
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.addClass("notient-model-selector-modal");
    contentEl.createEl("h2", { text: "Select AI Model" });

    // Create loading state
    this.renderContent();

    // Fetch models
    await this.fetchModels();
    this.renderContent();
  }

  private async fetchModels(): Promise<void> {
    this.isLoading = true;
    this.error = null;
    this.models = [];

    try {
      const llmProvider = this.kernel.getService<LLMProvider>("llmProvider");

      if (!llmProvider) {
        const health = this.kernel.serviceHealth;
        if (health.lmstudio.status !== "healthy") {
          throw new Error(
            "LM Studio is not connected. Please start LM Studio and ensure the server is running.",
          );
        }
        throw new Error("AI Service initializing...");
      }

      const modelIds = await llmProvider.listModels();

      if (!modelIds || modelIds.length === 0) {
        this.error = "No models found. Please load a model in LM Studio.";
        return;
      }

      this.models = modelIds.map((id) => ({
        id: id,
        name: id.split("/").pop() || id,
        path: id,
      }));
    } catch (err) {
      console.error("[ModelSelector] Failed to fetch models", err);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("fetch failed") || msg.includes("ECONNREFUSED")) {
        this.error = "Could not connect to LM Studio. Is the server running?";
      } else {
        this.error = `Error: ${msg}`;
      }
    } finally {
      this.isLoading = false;
    }
  }

  private renderContent(): void {
    const { contentEl } = this;

    // Clear existing content except title
    const title = contentEl.querySelector("h2");
    contentEl.empty();
    if (title) contentEl.appendChild(title);

    // Provider badge and refresh button
    const actionsDiv = contentEl.createDiv({ cls: "notient-modal-actions" });

    const refreshBtn = actionsDiv.createEl("button", {
      text: this.isLoading ? "Scanning..." : "Refresh Models",
      cls: "mod-muted",
    });
    refreshBtn.disabled = this.isLoading;
    refreshBtn.addEventListener("click", async () => {
      await this.fetchModels();
      this.renderContent();
    });

    const badge = actionsDiv.createDiv({ cls: "notient-provider-badge" });
    badge.createSpan({
      cls: `notient-status-dot ${!this.error ? "notient-status-dot--healthy" : "notient-status-dot--error"}`,
    });
    badge.createSpan({ text: "LM Studio" });

    // Error state
    if (this.error) {
      const errorDiv = contentEl.createDiv({ cls: "notient-error-banner" });
      errorDiv.createSpan({ text: "!", cls: "notient-error-icon" });
      errorDiv.createSpan({ text: this.error });
    }

    // Loading state
    if (this.isLoading) {
      contentEl.createDiv({
        text: "Loading models...",
        cls: "notient-loading-state",
      });
      return;
    }

    // Empty state
    if (this.models.length === 0 && !this.error) {
      contentEl.createDiv({
        text: "No models found. Check LM Studio.",
        cls: "notient-empty-state",
      });
      return;
    }

    // Model list
    const listDiv = contentEl.createDiv({ cls: "notient-model-list" });

    for (const model of this.models) {
      const isActive = this.currentModel === model.id;

      const itemBtn = listDiv.createEl("button", {
        cls: `notient-model-item ${isActive ? "notient-model-item--active" : ""}`,
      });

      const mainDiv = itemBtn.createDiv({ cls: "notient-model-main" });
      mainDiv.createSpan({ text: model.name, cls: "notient-model-name" });
      mainDiv.createSpan({ text: model.path, cls: "notient-model-path" });

      if (isActive) {
        itemBtn.createSpan({ text: "✓", cls: "notient-check-icon" });
      }

      itemBtn.addEventListener("click", () => this.handleSelect(model.id));
    }
  }

  private async handleSelect(modelId: string): Promise<void> {
    try {
      console.log(`[ModelSelector] Switching to model: ${modelId}`);

      this.kernel.settings.lmstudio.reasoningModel = modelId;
      this.kernel.updateSettings(this.kernel.settings);
      await this.kernel.saveSettings();

      this.kernel.eventBus.emit("settings:changed", {
        changedFields: ["lmstudio.reasoningModel"],
      });

      new Notice(`Switched to ${modelId}`);
      this.close();
    } catch (err) {
      console.error("[ModelSelector] Failed to update settings", err);
      new Notice(`Failed to switch model: ${err}`);
    }
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
