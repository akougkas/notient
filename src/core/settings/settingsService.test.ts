import { describe, expect, test } from "bun:test";
import type { Plugin } from "obsidian";
import { EventBus } from "../events/eventBus";
import { SettingsService } from "./settingsService";
import { DEFAULT_SETTINGS } from "./types";

interface FakePlugin {
  data: unknown;
  loadData: () => Promise<unknown>;
  saveData: (value: unknown) => Promise<void>;
}

function makePlugin(initial: unknown): FakePlugin {
  const plugin: FakePlugin = {
    data: initial,
    loadData: async () => plugin.data,
    saveData: async (value) => {
      plugin.data = value;
    },
  };
  return plugin;
}

describe("SettingsService merge", () => {
  test("falls back to Phase 4 defaults when persisted data is partial", async () => {
    const plugin = makePlugin({
      approvals: { confidenceThreshold: 0.9 },
    });
    const service = new SettingsService(plugin as unknown as Plugin, new EventBus());
    const loaded = await service.load();

    expect(loaded.approvals.confidenceThreshold).toBe(0.9);
    expect(loaded.stream).toEqual(DEFAULT_SETTINGS.stream);
    expect(loaded.vitals.healthWeights).toEqual(DEFAULT_SETTINGS.vitals.healthWeights);
    expect(loaded.search.balanced).toEqual(DEFAULT_SETTINGS.search.balanced);
    expect(loaded.chat.context).toEqual(DEFAULT_SETTINGS.chat.context);
    expect(loaded.indexer.excludePaths).toEqual(DEFAULT_SETTINGS.indexer.excludePaths);
  });

  test("preserves persisted nested fields while filling gaps from defaults", async () => {
    const plugin = makePlugin({
      vitals: { freshnessHalfLifeDays: 30 },
      search: { balanced: { topK: 50 } },
    });
    const service = new SettingsService(plugin as unknown as Plugin, new EventBus());
    const loaded = await service.load();

    expect(loaded.vitals.freshnessHalfLifeDays).toBe(30);
    expect(loaded.vitals.healthWeights).toEqual(DEFAULT_SETTINGS.vitals.healthWeights);
    expect(loaded.search.balanced.topK).toBe(50);
    expect(loaded.search.balanced.rerankTopN).toBe(DEFAULT_SETTINGS.search.balanced.rerankTopN);
    expect(loaded.search.deep).toEqual(DEFAULT_SETTINGS.search.deep);
  });
});
