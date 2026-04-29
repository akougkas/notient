/**
 * Per-vault TOML configuration loader.
 *
 * Spec: docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md §10
 * and the Phase 4 plan task 10. Reads `<vault>/.notient/config.toml`, parses
 * with `smol-toml`, and deep-merges over the defaults sourced from the
 * indexer's `concurrencyDefaults` constants.
 *
 * Invariants enforced here:
 *   - Missing file falls back to defaults silently. No log line is emitted
 *     because absence is the steady state for vaults that have never run
 *     `notient init`.
 *   - Malformed TOML logs a single warning and falls back to defaults. The
 *     daemon must not crash on a typo in a user-edited config file.
 *   - Type-mismatched values fall back to the defaulted field rather than
 *     erroring. We never let the indexer boot with `concurrency.embed = "4"`
 *     or `chunk.target_tokens = true`.
 *   - No live reload. The daemon reads this file once at boot; restarts pick
 *     up changes. This is a deliberate simplicity choice.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { CHUNK, CONCURRENCY } from "../indexer/concurrencyDefaults";

export type SurrealLogLevel = "trace" | "debug" | "info" | "warn" | "error";

export interface VaultConfig {
  indexer: {
    debounceMs: number;
    concurrency: { embed: number; extract: number };
    chunk: { targetTokens: number; maxTokens: number };
  };
  awaken: {
    defaultTierFilter: number[];
    defaultPriorityGlobs: string[];
  };
  surrealdb: {
    hnswCacheMib: number;
    logLevel: SurrealLogLevel;
  };
}

const SURREAL_LOG_LEVELS: ReadonlySet<SurrealLogLevel> = new Set([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
]);

export const DEFAULT_CONFIG: VaultConfig = {
  indexer: {
    debounceMs: 500,
    concurrency: { embed: CONCURRENCY.embed, extract: CONCURRENCY.extract },
    chunk: { targetTokens: CHUNK.targetTokens, maxTokens: CHUNK.maxTokens },
  },
  awaken: {
    defaultTierFilter: [1, 2, 3],
    defaultPriorityGlobs: [],
  },
  surrealdb: {
    hnswCacheMib: 512,
    logLevel: "warn",
  },
};

/**
 * Read `<vault>/.notient/config.toml`, parse it, and deep-merge over
 * `DEFAULT_CONFIG`. Returns `DEFAULT_CONFIG` when the file is missing or
 * malformed (warning logged for malformed content). Never throws on a
 * runtime read or parse failure; the daemon must boot.
 */
export async function loadVaultConfig(vaultPath: string): Promise<VaultConfig> {
  const file = configPath(vaultPath);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return DEFAULT_CONFIG;
  }
  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`notient: malformed config.toml at ${file}; falling back to defaults: ${message}`);
    return DEFAULT_CONFIG;
  }
  return mergeConfig(DEFAULT_CONFIG, parsed);
}

/**
 * Returns the canonical default `config.toml` body written by `notient init`.
 * Keys mirror the spec §10 schema (snake_case TOML keys).
 */
export function defaultConfigToml(): string {
  return `# Notient vault configuration
# Read once at daemon start; restart the daemon to pick up changes.

[indexer]
debounce_ms = 500

[indexer.concurrency]
embed = 4
extract = 2

[indexer.chunk]
target_tokens = 400
max_tokens = 800

[awaken]
default_tier_filter = [1, 2, 3]
default_priority_globs = []

[surrealdb]
hnsw_cache_mib = 512
log_level = "warn"
`;
}

/**
 * Write a default `config.toml` to `<vault>/.notient/config.toml` if and only
 * if no file is already there. Existing files are NEVER overwritten so a
 * follow-up `notient init` cannot clobber the operator's edits.
 */
export async function writeDefaultConfigIfAbsent(
  vaultPath: string,
): Promise<{ written: boolean; path: string }> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const dir = join(vaultPath, ".notient");
  const file = configPath(vaultPath);
  await mkdir(dir, { recursive: true });
  try {
    await readFile(file, "utf8");
    return { written: false, path: file };
  } catch {
    // Falls through to write.
  }
  await writeFile(file, defaultConfigToml(), "utf8");
  return { written: true, path: file };
}

function configPath(vaultPath: string): string {
  return join(vaultPath, ".notient", "config.toml");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function pickStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") out.push(entry);
  }
  return out;
}

function pickNumberArray(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value)) return fallback;
  const out: number[] = [];
  for (const entry of value) {
    if (typeof entry === "number" && Number.isFinite(entry)) out.push(entry);
  }
  return out;
}

function pickLogLevel(value: unknown, fallback: SurrealLogLevel): SurrealLogLevel {
  if (typeof value !== "string") return fallback;
  return SURREAL_LOG_LEVELS.has(value as SurrealLogLevel) ? (value as SurrealLogLevel) : fallback;
}

function mergeConfig(defaults: VaultConfig, override: unknown): VaultConfig {
  if (!isPlainObject(override)) return defaults;

  const indexerSection = isPlainObject(override.indexer) ? override.indexer : {};
  const concurrencySection = isPlainObject(indexerSection.concurrency)
    ? indexerSection.concurrency
    : {};
  const chunkSection = isPlainObject(indexerSection.chunk) ? indexerSection.chunk : {};
  const awakenSection = isPlainObject(override.awaken) ? override.awaken : {};
  const surrealSection = isPlainObject(override.surrealdb) ? override.surrealdb : {};

  return {
    indexer: {
      debounceMs: pickNumber(indexerSection.debounce_ms, defaults.indexer.debounceMs),
      concurrency: {
        embed: pickNumber(concurrencySection.embed, defaults.indexer.concurrency.embed),
        extract: pickNumber(concurrencySection.extract, defaults.indexer.concurrency.extract),
      },
      chunk: {
        targetTokens: pickNumber(chunkSection.target_tokens, defaults.indexer.chunk.targetTokens),
        maxTokens: pickNumber(chunkSection.max_tokens, defaults.indexer.chunk.maxTokens),
      },
    },
    awaken: {
      defaultTierFilter: pickNumberArray(
        awakenSection.default_tier_filter,
        defaults.awaken.defaultTierFilter,
      ),
      defaultPriorityGlobs: pickStringArray(
        awakenSection.default_priority_globs,
        defaults.awaken.defaultPriorityGlobs,
      ),
    },
    surrealdb: {
      hnswCacheMib: pickNumber(surrealSection.hnsw_cache_mib, defaults.surrealdb.hnswCacheMib),
      logLevel: pickLogLevel(surrealSection.log_level, defaults.surrealdb.logLevel),
    },
  };
}
