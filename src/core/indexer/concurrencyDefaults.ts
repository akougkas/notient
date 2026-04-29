/**
 * Hardcoded concurrency and chunking defaults shared by the Tier 2/3
 * orchestrators and the AST-aware chunker.
 *
 * Phase 4 replaces these with values loaded from
 * `vault/.notient/config.toml`. Until then, the constants here are the
 * single source of truth so the indexer behaves consistently across
 * unit tests, the daemon, and the smoke harness.
 */

export const CONCURRENCY = {
  embed: 4,
  extract: 2,
} as const;

export const CHUNK = {
  targetTokens: 400,
  maxTokens: 800,
} as const;
