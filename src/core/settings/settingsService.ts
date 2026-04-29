import type { EventBus } from "../events/eventBus";
import { type EnvSource, applyEnvOverrides } from "./envOverrides";
import { DEFAULT_SETTINGS, type NotientSettings } from "./types";

/**
 * SettingsService persists Notient configuration through an injected
 * ConfigStore. The daemon wires the store to <vault>/.notient/config.json
 * via FsVault. Tests use an in-memory fake.
 */
export interface ConfigStore {
  load(): Promise<unknown>;
  save(value: unknown): Promise<void>;
}

export class SettingsService {
  /** Persisted settings — what config.json holds, never includes env. */
  private persisted: NotientSettings = DEFAULT_SETTINGS;
  /** Env source applied on top of persisted; never written back to disk. */
  private envSource: EnvSource = {};

  constructor(
    private readonly store: ConfigStore,
    private readonly bus: EventBus,
  ) {}

  async load(envSource: EnvSource = {}): Promise<NotientSettings> {
    const raw = (await this.store.load()) as Partial<NotientSettings> | null;
    this.persisted = mergeSettings(DEFAULT_SETTINGS, raw ?? {});
    this.envSource = envSource;
    return this.get();
  }

  /** Returns the live view: persisted config with env overrides layered on. */
  get(): NotientSettings {
    return applyEnvOverrides(this.persisted, this.envSource);
  }

  /**
   * Returns the persisted view, ignoring env overrides. Use this when
   * writing back to disk via update() or surfacing what config.json holds
   * (e.g. /model show).
   */
  getPersisted(): NotientSettings {
    return this.persisted;
  }

  async update(patch: Partial<NotientSettings>): Promise<void> {
    this.persisted = mergeSettings(this.persisted, patch);
    await this.store.save(this.persisted);
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
    toolModeByModel: mergeToolModeByModel(base.toolModeByModel, patch?.toolModeByModel),
    context: { ...base.context, ...(patch?.context ?? {}) },
  };
}

/**
 * Merge tool-mode pins. A `null` value in the patch deletes that key from
 * the merged map; any other value overwrites. The deletion sentinel lets
 * the daemon RPC `chat.invalidate_probe_cache` (or a hand-rolled
 * `daemon.config_set` patch) unpin a model so the next chat turn re-runs
 * the probe.
 */
function mergeToolModeByModel(
  base: NotientSettings["chat"]["toolModeByModel"],
  patch: NotientSettings["chat"]["toolModeByModel"] | undefined,
): NotientSettings["chat"]["toolModeByModel"] {
  const merged: NotientSettings["chat"]["toolModeByModel"] = { ...base };
  if (patch === undefined) return merged;
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) {
      delete merged[key];
      continue;
    }
    if (value === "native" || value === "json-fallback" || value === "disabled") {
      merged[key] = value;
    }
  }
  return merged;
}
