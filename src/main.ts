import { Plugin } from "obsidian";
import { EventBus } from "./core/events/eventBus";
import { NotientSettingsTab } from "./core/settings/SettingsTab";
import { SettingsService } from "./core/settings/settingsService";

export default class NotientPlugin extends Plugin {
  bus!: EventBus;
  settings!: SettingsService;

  async onload(): Promise<void> {
    console.log("[Notient] loading v1.0.0-foundation");
    this.bus = new EventBus();
    this.settings = new SettingsService(this, this.bus);
    await this.settings.load();
    this.addSettingTab(new NotientSettingsTab(this.app, this, this.settings));
  }

  async onunload(): Promise<void> {
    console.log("[Notient] unloading");
  }
}
