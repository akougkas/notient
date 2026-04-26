import type { Plugin } from "obsidian";
import type { EventBus } from "../events/eventBus";
import { DEFAULT_SETTINGS, type NotientSettings } from "./types";

export class SettingsService {
  private current: NotientSettings = DEFAULT_SETTINGS;

  constructor(
    private readonly plugin: Plugin,
    private readonly bus: EventBus,
  ) {}

  async load(): Promise<NotientSettings> {
    const raw = (await this.plugin.loadData()) as Partial<NotientSettings> | null;
    this.current = mergeSettings(DEFAULT_SETTINGS, raw ?? {});
    return this.current;
  }

  get(): NotientSettings {
    return this.current;
  }

  async update(patch: Partial<NotientSettings>): Promise<void> {
    this.current = mergeSettings(this.current, patch);
    await this.plugin.saveData(this.current);
    this.bus.emit({ type: "settings:changed", key: Object.keys(patch).join(",") });
  }
}

function mergeSettings(base: NotientSettings, patch: Partial<NotientSettings>): NotientSettings {
  return {
    primary: { ...base.primary, ...(patch.primary ?? {}) },
    deep: { ...base.deep, ...(patch.deep ?? {}) },
    embedding: { ...base.embedding, ...(patch.embedding ?? {}) },
    agents: { ...base.agents, ...(patch.agents ?? {}) },
    coAuthor: { ...base.coAuthor, ...(patch.coAuthor ?? {}) },
    approvals: { ...base.approvals, ...(patch.approvals ?? {}) },
    awakenedAt: patch.awakenedAt !== undefined ? patch.awakenedAt : base.awakenedAt,
  };
}
