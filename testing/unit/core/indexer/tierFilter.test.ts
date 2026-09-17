import { describe, expect, test } from "bun:test";
import {
  FULL_INDEX_TIER_FILTER,
  InvalidTierFilterError,
  isFullTierFilter,
  maxRequestedTier,
  readTierFilter,
} from "../../../../src/core/indexer/tierFilter";

describe("tierFilter", () => {
  test("omission is the only implicit full-ladder representation", () => {
    expect(readTierFilter(undefined)).toEqual([...FULL_INDEX_TIER_FILTER]);
  });

  test("canonicalizes valid duplicates and order", () => {
    expect(readTierFilter([3, 1, 2, 1])).toEqual([1, 2, 3]);
    expect(maxRequestedTier([2, 1])).toBe(2);
    expect(isFullTierFilter([3, 2, 1])).toBe(true);
  });

  test.each([
    { label: "null", value: null },
    { label: "CSV string", value: "1,2" },
    { label: "empty array", value: [] },
    { label: "zero", value: [0] },
    { label: "out of range", value: [4] },
    { label: "numeric string", value: [1, "2"] },
    { label: "NaN", value: [1, Number.NaN] },
  ])("rejects malformed supplied value: $label", ({ value }) => {
    expect(() => readTierFilter(value)).toThrow(InvalidTierFilterError);
  });

  test("invalid values never widen max-tier or full-tier decisions", () => {
    expect(() => maxRequestedTier([])).toThrow(InvalidTierFilterError);
    expect(() => maxRequestedTier([0, 5])).toThrow(InvalidTierFilterError);
    expect(() => isFullTierFilter([1, 1, 1])).not.toThrow();
    expect(isFullTierFilter([1, 1, 1])).toBe(false);
  });
});
