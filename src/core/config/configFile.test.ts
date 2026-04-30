import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Embedder } from "../indexer/embedder";
import type { LLMProvider } from "../llm/provider";
import {
  DEFAULT_CONFIG,
  defaultConfigToml,
  loadVaultConfig,
  writeDefaultConfigIfAbsent,
} from "./configFile";

async function makeVault(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "notient-config-"));
}

async function writeToml(vault: string, body: string): Promise<void> {
  const dir = join(vault, ".notient");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.toml"), body, "utf8");
}

describe("loadVaultConfig", () => {
  let vaults: string[] = [];

  beforeEach(() => {
    vaults = [];
  });

  afterEach(async () => {
    for (const vault of vaults) {
      await rm(vault, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("returns DEFAULT_CONFIG when config.toml is missing", async () => {
    const vault = await makeVault();
    vaults.push(vault);

    const config = await loadVaultConfig(vault);

    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("returns DEFAULT_CONFIG and warns when config.toml is malformed", async () => {
    const vault = await makeVault();
    vaults.push(vault);
    await writeToml(vault, "this is = =not = valid = toml [\n");

    const warn = mock(() => {});
    const original = console.warn;
    console.warn = warn;
    try {
      const config = await loadVaultConfig(vault);
      expect(config).toEqual(DEFAULT_CONFIG);
    } finally {
      console.warn = original;
    }
    expect(warn).toHaveBeenCalled();
    const firstCall = warn.mock.calls[0] as readonly unknown[] | undefined;
    const message = String(firstCall?.[0] ?? "");
    expect(message).toContain("malformed config.toml");
  });

  it("deep-merges a partial override and leaves siblings at default", async () => {
    const vault = await makeVault();
    vaults.push(vault);
    await writeToml(
      vault,
      `[indexer.concurrency]
embed = 1
`,
    );

    const config = await loadVaultConfig(vault);

    expect(config.indexer.concurrency.embed).toBe(1);
    expect(config.indexer.concurrency.extract).toBe(DEFAULT_CONFIG.indexer.concurrency.extract);
    expect(config.indexer.chunk).toEqual(DEFAULT_CONFIG.indexer.chunk);
    expect(config.indexer.debounceMs).toBe(DEFAULT_CONFIG.indexer.debounceMs);
    expect(config.surrealdb).toEqual(DEFAULT_CONFIG.surrealdb);
    expect(config.awaken).toEqual(DEFAULT_CONFIG.awaken);
  });

  it("ignores unknown keys and applies defaults for missing sections", async () => {
    const vault = await makeVault();
    vaults.push(vault);
    await writeToml(
      vault,
      `[indexer]
mystery_field = 42

[unknown_section]
stuff = "ignored"
`,
    );

    const config = await loadVaultConfig(vault);

    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("overrides awaken.default_priority_globs with the provided array", async () => {
    const vault = await makeVault();
    vaults.push(vault);
    await writeToml(
      vault,
      `[awaken]
default_priority_globs = ["daily/**", "MOCs/**"]
`,
    );

    const config = await loadVaultConfig(vault);

    expect(config.awaken.defaultPriorityGlobs).toEqual(["daily/**", "MOCs/**"]);
    expect(config.awaken.defaultTierFilter).toEqual(DEFAULT_CONFIG.awaken.defaultTierFilter);
  });

  it("falls back to default when a typed field is the wrong type", async () => {
    const vault = await makeVault();
    vaults.push(vault);
    await writeToml(
      vault,
      `[indexer.concurrency]
embed = "four"
extract = 7

[surrealdb]
log_level = "shouting"
`,
    );

    const config = await loadVaultConfig(vault);

    expect(config.indexer.concurrency.embed).toBe(DEFAULT_CONFIG.indexer.concurrency.embed);
    expect(config.indexer.concurrency.extract).toBe(7);
    expect(config.surrealdb.logLevel).toBe(DEFAULT_CONFIG.surrealdb.logLevel);
  });

  it("accepts a full valid TOML override", async () => {
    const vault = await makeVault();
    vaults.push(vault);
    await writeToml(
      vault,
      `[indexer]
debounce_ms = 250

[indexer.concurrency]
embed = 8
extract = 3

[indexer.chunk]
target_tokens = 200
max_tokens = 600

[awaken]
default_tier_filter = [1, 2]
default_priority_globs = ["projects/**"]

[surrealdb]
hnsw_cache_mib = 1024
log_level = "info"

[agent_events]
max_rows = 12345
`,
    );

    const config = await loadVaultConfig(vault);

    expect(config).toEqual({
      indexer: {
        debounceMs: 250,
        concurrency: { embed: 8, extract: 3 },
        chunk: { targetTokens: 200, maxTokens: 600 },
      },
      awaken: {
        defaultTierFilter: [1, 2],
        defaultPriorityGlobs: ["projects/**"],
      },
      surrealdb: {
        hnswCacheMib: 1024,
        logLevel: "info",
      },
      agentEvents: {
        maxRows: 12345,
      },
    });
  });

  it("defaults agentEvents.maxRows to 50_000 and reads max_rows override", async () => {
    const defaultsVault = await makeVault();
    vaults.push(defaultsVault);
    const defaults = await loadVaultConfig(defaultsVault);
    expect(defaults.agentEvents.maxRows).toBe(50_000);

    const overrideVault = await makeVault();
    vaults.push(overrideVault);
    await writeToml(
      overrideVault,
      `[agent_events]
max_rows = 1000
`,
    );
    const override = await loadVaultConfig(overrideVault);
    expect(override.agentEvents.maxRows).toBe(1000);
    expect(override.indexer).toEqual(DEFAULT_CONFIG.indexer);
    expect(override.surrealdb).toEqual(DEFAULT_CONFIG.surrealdb);
  });
});

describe("Embedder receives config-derived concurrency", () => {
  let vaults: string[] = [];

  beforeEach(() => {
    vaults = [];
  });

  afterEach(async () => {
    for (const vault of vaults) {
      await rm(vault, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("threads loadVaultConfig output into Embedder.getConcurrency", async () => {
    const vault = await makeVault();
    vaults.push(vault);
    await writeToml(
      vault,
      `[indexer.concurrency]
embed = 1
`,
    );

    const config = await loadVaultConfig(vault);
    const provider = {
      isAvailable: async () => true,
      chat: async () => "",
      chatStream: async function* (): AsyncIterable<string> {
        yield "";
      },
      chatJson: async <T>() => ({}) as T,
      embed: async (texts: string[]) => texts.map(() => [0]),
    } satisfies LLMProvider;
    const embedder = new Embedder(provider, {
      model: "stub",
      concurrency: config.indexer.concurrency.embed,
    });

    expect(embedder.getConcurrency()).toBe(1);
  });
});

describe("writeDefaultConfigIfAbsent", () => {
  let vaults: string[] = [];

  beforeEach(() => {
    vaults = [];
  });

  afterEach(async () => {
    for (const vault of vaults) {
      await rm(vault, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("writes the default config when no file exists", async () => {
    const vault = await makeVault();
    vaults.push(vault);

    const result = await writeDefaultConfigIfAbsent(vault);

    expect(result.written).toBe(true);
    expect(result.path).toBe(join(vault, ".notient", "config.toml"));
    const written = await readFile(result.path, "utf8");
    expect(written).toBe(defaultConfigToml());
  });

  it("does NOT overwrite an existing config", async () => {
    const vault = await makeVault();
    vaults.push(vault);
    const customBody = `[indexer]
debounce_ms = 99
`;
    await writeToml(vault, customBody);

    const result = await writeDefaultConfigIfAbsent(vault);

    expect(result.written).toBe(false);
    const after = await readFile(result.path, "utf8");
    expect(after).toBe(customBody);
  });
});
