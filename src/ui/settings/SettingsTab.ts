/**
 * Notient Settings Tab - Obsidian PluginSettingTab
 * Source of truth: .planning/PHASE-GALAXY.md (Phase G6)
 *
 * Per spec decisions:
 * - Scope: Full config for all active components
 * - Dev mode toggle
 */

import { PluginSettingTab, Setting, type App } from "obsidian";
import type NotientPlugin from "../../main";
import type { ProviderType } from "./types";

const PROVIDER_TYPES: { value: ProviderType; label: string }[] = [
  { value: "lmstudio", label: "LM Studio" },
  { value: "ollama", label: "Ollama" },
  { value: "openai-compatible", label: "OpenAI Compatible" },
];

export class NotientSettingsTab extends PluginSettingTab {
  private plugin: NotientPlugin;

  constructor(app: App, plugin: NotientPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("notient-settings");

    containerEl.createEl("h1", { text: "Notient Settings" });

    this.displayReasoningProviderSettings(containerEl);
    this.displayEmbeddingProviderSettings(containerEl);
    this.displayExcludedFoldersSettings(containerEl);
    this.displayDevModeSettings(containerEl);
  }

  private displayReasoningProviderSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "Reasoning LLM Provider" });

    const { reasoningProvider } = this.plugin.settings;

    new Setting(containerEl)
      .setName("Provider type")
      .setDesc("Local LLM provider for reasoning")
      .addDropdown((dropdown) => {
        for (const { value, label } of PROVIDER_TYPES) {
          dropdown.addOption(value, label);
        }
        dropdown.setValue(reasoningProvider.type);
        dropdown.onChange(async (value) => {
          this.plugin.settings.reasoningProvider.type = value as ProviderType;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("API endpoint (e.g., http://localhost:1234/v1)")
      .addText((text) => {
        text
          .setPlaceholder("http://localhost:1234/v1")
          .setValue(reasoningProvider.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.reasoningProvider.baseUrl = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Model name or identifier")
      .addText((text) => {
        text
          .setPlaceholder("default")
          .setValue(reasoningProvider.model)
          .onChange(async (value) => {
            this.plugin.settings.reasoningProvider.model = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("Optional API key (if required by provider)")
      .addText((text) => {
        text
          .setPlaceholder("(optional)")
          .setValue(reasoningProvider.apiKey ?? "")
          .onChange(async (value) => {
            this.plugin.settings.reasoningProvider.apiKey = value || undefined;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });
  }

  private displayEmbeddingProviderSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "Embedding Provider" });

    const { embeddingProvider } = this.plugin.settings;

    new Setting(containerEl)
      .setName("Provider type")
      .setDesc("Local LLM provider for embeddings")
      .addDropdown((dropdown) => {
        for (const { value, label } of PROVIDER_TYPES) {
          dropdown.addOption(value, label);
        }
        dropdown.setValue(embeddingProvider.type);
        dropdown.onChange(async (value) => {
          this.plugin.settings.embeddingProvider.type = value as ProviderType;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("API endpoint (e.g., http://localhost:11434)")
      .addText((text) => {
        text
          .setPlaceholder("http://localhost:11434")
          .setValue(embeddingProvider.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.embeddingProvider.baseUrl = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Embedding model name")
      .addText((text) => {
        text
          .setPlaceholder("nomic-embed-text")
          .setValue(embeddingProvider.model)
          .onChange(async (value) => {
            this.plugin.settings.embeddingProvider.model = value;
            await this.plugin.saveSettings();
          });
      });
  }

  private displayExcludedFoldersSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "Indexing" });

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("Folders to exclude from indexing (comma-separated)")
      .addTextArea((textarea) => {
        textarea
          .setPlaceholder(".obsidian, .trash")
          .setValue(this.plugin.settings.excludedFolders.join(", "))
          .onChange(async (value) => {
            this.plugin.settings.excludedFolders = value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
        textarea.inputEl.rows = 3;
      });
  }

  private displayDevModeSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "Developer" });

    new Setting(containerEl)
      .setName("Dev mode")
      .setDesc("Enable detailed logging and debug features")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.devMode).onChange(async (value) => {
          this.plugin.settings.devMode = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Version")
      .setDesc(this.plugin.settings.version)
      .setDisabled(true);
  }
}
