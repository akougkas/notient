import { describe, expect, test } from "bun:test";
import {
  NotientConfigError,
  loadNotientConfig,
  parseNotientConfig,
} from "../../../../src/core/settings/configSchema";
import { resolveSettings } from "../../../../src/core/settings/envOverrides";
import { SettingsService } from "../../../../src/core/settings/settingsService";
import { DEFAULT_NOTIENT_CONFIG } from "../../../../src/core/settings/types";

const SOURCE = "/vault/.notient/config.json";

test("runtime policy updates persist before visibility and preserve deployment precedence", async () => {
  const config = structuredClone(DEFAULT_NOTIENT_CONFIG);
  let persisted = JSON.stringify(config);
  let rejectWrite = false;
  const settings = new SettingsService(
    resolveSettings(config, {
      NOTIENT_LLM_BASE_URL: "http://example:1234/v1",
      NOTIENT_LLM_MODEL: "chosen",
    }),
    {
      config,
      load: async () => persisted,
      compareAndSwap: async (before, after) => {
        if (rejectWrite || before !== persisted) return false;
        persisted = after;
        return true;
      },
    },
  );
  const before = settings.background();
  const next = structuredClone(before.settings);
  next.pipelines.enrich.enabled = true;
  next.pipelines.enrich.triggers = ["save"];
  let changed = 0;
  const off = settings.onBackgroundChange(() => {
    expect(JSON.parse(persisted).background.pipelines.enrich.enabled).toBe(true);
    changed++;
  });
  await settings.updateBackground(next, before.revision);
  expect(settings.get().primary.reasoningModel).toBe("chosen");
  expect(settings.background().settings.pipelines.enrich.enabled).toBe(true);
  expect(changed).toBe(1);
  await expect(settings.updateBackground(before.settings, before.revision)).rejects.toThrow(
    "changed",
  );
  rejectWrite = true;
  await expect(
    settings.updateBackground(before.settings, settings.background().revision),
  ).rejects.toThrow("during save");
  expect(settings.background().settings.pipelines.enrich.enabled).toBe(true);
  off();
});

interface MutableTestConfig extends Record<string, unknown> {
  chat: Record<string, unknown> & { approvalMode: unknown; contextBudgetFraction: unknown };
  indexer: {
    debounceMs: unknown;
    concurrency: { embed: unknown };
    chunk: { targetTokens: number; maxTokens: unknown };
  };
  surrealdb: { logLevel: unknown };
}

function configJson(mutator?: (config: MutableTestConfig) => void): string {
  const config = structuredClone(DEFAULT_NOTIENT_CONFIG) as unknown as MutableTestConfig;
  mutator?.(config);
  return JSON.stringify(config);
}

describe("strict config.json validation", () => {
  test("accepts the complete canonical schema and returns a deep-frozen value", () => {
    const config = parseNotientConfig(configJson(), SOURCE);

    expect(config).toEqual(DEFAULT_NOTIENT_CONFIG);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.chat.context)).toBe(true);
    expect(Object.isFrozen(config.indexer.excludePaths)).toBe(true);
  });

  test("malformed JSON fails with the source path", () => {
    expect(() => parseNotientConfig('{"chat":', SOURCE)).toThrow(NotientConfigError);
    expect(() => parseNotientConfig('{"chat":', SOURCE)).toThrow(`${SOURCE}: malformed JSON`);
  });

  test("unknown top-level, nested, and retired deployment keys fail", () => {
    expect(() =>
      parseNotientConfig(
        configJson((config) => {
          config.stale = true;
          config.chat.toolModeByModel = {};
          config.primary = { baseUrl: "http://retired", reasoningModel: "retired" };
        }),
        SOURCE,
      ),
    ).toThrow(`${SOURCE}.stale: unknown key`);
    expect(() =>
      parseNotientConfig(
        configJson((config) => {
          config.chat.toolModeByModel = {};
        }),
        SOURCE,
      ),
    ).toThrow(`${SOURCE}.chat.toolModeByModel: unknown key`);
    expect(() =>
      parseNotientConfig(
        configJson((config) => {
          config.primary = { baseUrl: "http://retired", reasoningModel: "retired" };
        }),
        SOURCE,
      ),
    ).toThrow(`${SOURCE}.primary: unknown key`);
  });

  test("wrong types and enums fail at the exact field path", () => {
    expect(() =>
      parseNotientConfig(
        configJson((config) => {
          config.indexer.debounceMs = "500";
        }),
        SOURCE,
      ),
    ).toThrow(`${SOURCE}.indexer.debounceMs`);
    expect(() =>
      parseNotientConfig(
        configJson((config) => {
          config.chat.approvalMode = "sometimes";
        }),
        SOURCE,
      ),
    ).toThrow(`${SOURCE}.chat.approvalMode`);
    expect(() =>
      parseNotientConfig(
        configJson((config) => {
          config.surrealdb.logLevel = "verbose";
        }),
        SOURCE,
      ),
    ).toThrow(`${SOURCE}.surrealdb.logLevel`);
  });

  test("partial existing config fails instead of merging defaults", () => {
    expect(() =>
      parseNotientConfig(JSON.stringify({ vitals: { writeToFrontmatter: true } }), SOURCE),
    ).toThrow(`${SOURCE}.vitals.freshnessHalfLifeDays`);
  });

  test("fractional integers and invalid numeric ranges fail at their paths", () => {
    expect(() =>
      parseNotientConfig(
        configJson((config) => {
          config.indexer.concurrency.embed = 4.5;
        }),
        SOURCE,
      ),
    ).toThrow(`${SOURCE}.indexer.concurrency.embed`);
    expect(() =>
      parseNotientConfig(
        configJson((config) => {
          config.chat.contextBudgetFraction = 1.1;
        }),
        SOURCE,
      ),
    ).toThrow(`${SOURCE}.chat.contextBudgetFraction`);
    expect(() =>
      parseNotientConfig(
        configJson((config) => {
          config.indexer.chunk.maxTokens = config.indexer.chunk.targetTokens - 1;
        }),
        SOURCE,
      ),
    ).toThrow(`${SOURCE}.indexer.chunk.maxTokens`);
  });

  test("missing file uses a fresh canonical default and read failures propagate", async () => {
    const first = await loadNotientConfig({ path: SOURCE, load: async () => null });
    const second = await loadNotientConfig({ path: SOURCE, load: async () => null });
    expect(first).toEqual(DEFAULT_NOTIENT_CONFIG);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);

    await expect(
      loadNotientConfig({
        path: SOURCE,
        load: async () => {
          throw new Error("permission denied");
        },
      }),
    ).rejects.toThrow("permission denied");
  });
});

describe("SettingsService immutable boot snapshot", () => {
  test("returns the exact same deep-frozen resolved object for every consumer", () => {
    const config = parseNotientConfig(configJson(), SOURCE);
    const resolved = resolveSettings(config, {
      NOTIENT_LLM_BASE_URL: "http://localhost:1234/v1",
      NOTIENT_LLM_MODEL: "reasoning-model",
      NOTIENT_EMBED_MODEL: "embedding-model",
    });
    const service = new SettingsService(resolved);

    expect(service.get()).toBe(service.get());
    expect(Object.isFrozen(service.get())).toBe(true);
    expect(Object.isFrozen(service.get().chat)).toBe(true);
    expect(service.get().primary.reasoningModel).toBe("reasoning-model");
  });
});

test("live tool authority reads operator policy without replacing deployment or unrelated runtime settings", async () => {
  const config = structuredClone(DEFAULT_NOTIENT_CONFIG);
  const disk = structuredClone(config);
  const settings = new SettingsService(resolveSettings(config, { NOTIENT_LLM_MODEL: "chosen" }), {
    config,
    load: async () => JSON.stringify(disk),
    compareAndSwap: async () => {
      throw new Error("read-only check attempted a write");
    },
  });
  disk.chat.approvalMode = "yolo";
  disk.chat.perTool["notes.create"] = "auto";
  expect((await settings.refreshToolPolicy()).perTool["notes.create"]).toBe("auto");
  disk.chat.approvalMode = "safe";
  disk.chat.perTool["notes.create"] = "ask";
  expect((await settings.refreshToolPolicy()).approvalMode).toBe("safe");
  expect(settings.get().chat.perTool["notes.create"]).toBe("ask");
  expect(settings.get().primary.reasoningModel).toBe("chosen");
  expect(settings.background().settings).toEqual(config.background);
});
