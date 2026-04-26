import { describe, expect, test } from "bun:test";
import { freshness } from "./freshness";

describe("freshness", () => {
  test("returns 1.0 immediately after update", () => {
    expect(freshness({ updatedAt: 1000, now: 1000, halfLifeDays: 14 })).toBeCloseTo(1, 6);
  });

  test("halves at the half-life", () => {
    const updatedAt = 0;
    const now = 14 * 24 * 60 * 60 * 1000;
    expect(freshness({ updatedAt, now, halfLifeDays: 14 })).toBeCloseTo(Math.exp(-1), 6);
  });

  test("clamps to zero in the limit", () => {
    expect(freshness({ updatedAt: 0, now: 1_000_000_000_000, halfLifeDays: 14 })).toBeLessThan(
      1e-6,
    );
  });

  test("clamps to 1 if updatedAt is in the future", () => {
    expect(freshness({ updatedAt: 100, now: 50, halfLifeDays: 14 })).toBe(1);
  });
});
