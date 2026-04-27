import { type App, PluginSettingTab, Setting } from "obsidian";
import type NotientPlugin from "../../main";
import type { SettingsService } from "./settingsService";

export class NotientSettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: NotientPlugin,
    private readonly settings: SettingsService,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Notient — Local AI" });

    const current = this.settings.get();

    new Setting(containerEl)
      .setName("Primary endpoint URL")
      .setDesc("OpenAI-compatible. Reasoning + embeddings + fast extraction.")
      .addText((text) =>
        text
          .setPlaceholder("http://host:port/v1")
          .setValue(current.primary.baseUrl)
          .onChange(async (value) => {
            await this.settings.update({
              primary: { ...current.primary, baseUrl: value.trim() },
            });
          }),
      );

    new Setting(containerEl).setName("Reasoning model (primary)").addText((text) =>
      text.setValue(current.primary.reasoningModel).onChange(async (value) => {
        await this.settings.update({
          primary: { ...this.settings.get().primary, reasoningModel: value.trim() },
        });
      }),
    );

    new Setting(containerEl).setName("Embedding model (primary)").addText((text) =>
      text.setValue(current.primary.embeddingModel).onChange(async (value) => {
        await this.settings.update({
          primary: { ...this.settings.get().primary, embeddingModel: value.trim() },
        });
      }),
    );

    new Setting(containerEl).setName("Fast extractor model (primary)").addText((text) =>
      text.setValue(current.primary.fastModel).onChange(async (value) => {
        await this.settings.update({
          primary: { ...this.settings.get().primary, fastModel: value.trim() },
        });
      }),
    );

    containerEl.createEl("h3", { text: "Deep / heavy model (optional)" });

    new Setting(containerEl).setName("Deep endpoint URL").addText((text) =>
      text.setValue(current.deep.baseUrl).onChange(async (value) => {
        await this.settings.update({
          deep: { ...this.settings.get().deep, baseUrl: value.trim() },
        });
      }),
    );
  }
}
