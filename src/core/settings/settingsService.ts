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
    stream: { ...base.stream, ...(patch.stream ?? {}) },
    vitals: mergeVitals(base.vitals, patch.vitals),
    decorations: { ...base.decorations, ...(patch.decorations ?? {}) },
    nativeGraph: { ...base.nativeGraph, ...(patch.nativeGraph ?? {}) },
    search: mergeSearch(base.search, patch.search),
    chat: mergeChat(base.chat, patch.chat),
    history: { ...base.history, ...(patch.history ?? {}) },
    indexer: { ...base.indexer, ...(patch.indexer ?? {}) },
  };
}

function mergeVitals(
  base: NotientSettings["vitals"],
  patch: Partial<NotientSettings["vitals"]> | undefined,
): NotientSettings["vitals"] {
  return {
    ...base,
    ...(patch ?? {}),
    healthWeights: { ...base.healthWeights, ...(patch?.healthWeights ?? {}) },
    connectivityThresholds: {
      ...base.connectivityThresholds,
      ...(patch?.connectivityThresholds ?? {}),
    },
  };
}

function mergeSearch(
  base: NotientSettings["search"],
  patch: Partial<NotientSettings["search"]> | undefined,
): NotientSettings["search"] {
  return {
    ...base,
    ...(patch ?? {}),
    balanced: { ...base.balanced, ...(patch?.balanced ?? {}) },
    deep: { ...base.deep, ...(patch?.deep ?? {}) },
    history: { ...base.history, ...(patch?.history ?? {}) },
  };
}

function mergeChat(
  base: NotientSettings["chat"],
  patch: Partial<NotientSettings["chat"]> | undefined,
): NotientSettings["chat"] {
  return {
    ...base,
    ...(patch ?? {}),
    toolModeByModel: { ...base.toolModeByModel, ...(patch?.toolModeByModel ?? {}) },
    context: { ...base.context, ...(patch?.context ?? {}) },
  };
}
