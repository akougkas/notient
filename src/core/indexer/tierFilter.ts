export const FULL_INDEX_TIER_FILTER = [1, 2, 3] as const;

export type IndexTier = (typeof FULL_INDEX_TIER_FILTER)[number];

export class InvalidTierFilterError extends Error {
  constructor(message: string) {
    super(`invalid tier filter: ${message}`);
    this.name = "InvalidTierFilterError";
  }
}

/**
 * Read the canonical RPC/storage representation. Omission means the full
 * enrichment ladder; a supplied value must be a non-empty array containing
 * only the integer tier ids 1, 2, and 3. Nothing invalid is dropped or widened.
 */
export function readTierFilter(raw: unknown): IndexTier[] {
  if (raw === undefined) return [...FULL_INDEX_TIER_FILTER];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new InvalidTierFilterError("expected a non-empty array of 1, 2, or 3");
  }
  const tiers = new Set<IndexTier>();
  for (const value of raw) {
    if (!isIndexTier(value)) {
      throw new InvalidTierFilterError(`expected 1, 2, or 3; received ${String(value)}`);
    }
    tiers.add(value);
  }
  return [...tiers].sort((left, right) => left - right);
}

/** Parse the CLI's comma-separated representation without forgiving tokens. */
export function readTierCsv(raw: string | boolean | undefined): IndexTier[] {
  if (raw === undefined) return [...FULL_INDEX_TIER_FILTER];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new InvalidTierFilterError("--tier requires a comma-separated subset of 1,2,3");
  }
  const values = raw.split(",").map((token) => {
    const trimmed = token.trim();
    if (!/^[123]$/.test(trimmed)) {
      throw new InvalidTierFilterError(`expected 1, 2, or 3; received ${trimmed || "empty token"}`);
    }
    return Number(trimmed);
  });
  return readTierFilter(values);
}

export function isFullTierFilter(raw: ReadonlyArray<number>): boolean {
  const tiers = readTierFilter(raw);
  return (
    tiers.length === FULL_INDEX_TIER_FILTER.length &&
    tiers.every((tier, index) => tier === FULL_INDEX_TIER_FILTER[index])
  );
}

export function maxRequestedTier(raw: ReadonlyArray<number> | undefined): IndexTier {
  const tiers = readTierFilter(raw);
  const maximum = tiers[tiers.length - 1];
  if (maximum === undefined) {
    throw new InvalidTierFilterError("expected at least one tier");
  }
  return maximum;
}

function isIndexTier(value: unknown): value is IndexTier {
  return value === 1 || value === 2 || value === 3;
}
