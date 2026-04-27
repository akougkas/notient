import { describe, expect, test } from "bun:test";
import { EventBus } from "../events/eventBus";
import { SettingsService } from "./settingsService";
import { DEFAULT_SETTINGS } from "./types";

interface FakeStore {
  data: unknown;
  load: () => Promise<unknown>;
  save: (value: unknown) => Promise<void>;
}

function makeStore(initial: unknown): FakeStore {
  const store: FakeStore = {
    data: initial,
    load: async () => store.data,
    save: async (value) => {
      store.data = value;
    },
  };
  return store;
}

describe("SettingsService merge", () => {
  test("falls back to defaults when persisted data is partial", async () => {
    const store = makeStore({ approvals: { confidenceThreshold: 0.9 } });
    const service = new SettingsService(store, new EventBus());
    const loaded = await service.load();

    expect(loaded.approvals.confidenceThreshold).toBe(0.9);
    expect(loaded.stream).toEqual(DEFAULT_SETTINGS.stream);
    expect(loaded.vitals.healthWeights).toEqual(DEFAULT_SETTINGS.vitals.healthWeights);
    expect(loaded.search.balanced).toEqual(DEFAULT_SETTINGS.search.balanced);
    expect(loaded.chat.context).toEqual(DEFAULT_SETTINGS.chat.context);
    expect(loaded.indexer.excludePaths).toEqual(DEFAULT_SETTINGS.indexer.excludePaths);
  });

  test("preserves persisted nested fields while filling gaps from defaults", async () => {
    const store = makeStore({
      vitals: { freshnessHalfLifeDays: 30 },
      search: { balanced: { topK: 50 } },
    });
    const service = new SettingsService(store, new EventBus());
    const loaded = await service.load();

    expect(loaded.vitals.freshnessHalfLifeDays).toBe(30);
    expect(loaded.vitals.healthWeights).toEqual(DEFAULT_SETTINGS.vitals.healthWeights);
    expect(loaded.search.balanced.topK).toBe(50);
    expect(loaded.search.balanced.rerankTopN).toBe(DEFAULT_SETTINGS.search.balanced.rerankTopN);
    expect(loaded.search.deep).toEqual(DEFAULT_SETTINGS.search.deep);
  });

  test("update writes through to the store and emits settings:changed", async () => {
    const store = makeStore(null);
    const bus = new EventBus();
    const events: string[] = [];
    bus.on("settings:changed", (event) => {
      events.push(event.key);
    });
    const service = new SettingsService(store, bus);
    await service.load();
    await service.update({ approvals: { confidenceThreshold: 0.42 } });

    expect(service.get().approvals.confidenceThreshold).toBe(0.42);
    expect(store.data).not.toBeNull();
    expect(events).toEqual(["approvals"]);
  });
});
