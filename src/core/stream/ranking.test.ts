import { describe, expect, test } from "bun:test";
import { type RankInput, computeScore, rank } from "./ranking";

describe("stream ranking", () => {
  const settings = { recencyHalfLifeHours: 12, offNoteRelevanceFloor: 0.3, maxItems: 50 };

  test("score is multiplicative across the three factors", () => {
    const score = computeScore({
      confidence: 0.8,
      ageHours: 12,
      relatedToActiveNote: true,
      settings,
    });
    expect(score).toBeCloseTo(0.8 * Math.exp(-1) * 1.0, 6);
  });

  test("off-note items use the configured floor", () => {
    const score = computeScore({
      confidence: 0.5,
      ageHours: 0,
      relatedToActiveNote: false,
      settings,
    });
    expect(score).toBeCloseTo(0.5 * 1.0 * 0.3, 6);
  });

  test("recency decay halves at the configured half-life", () => {
    const fresh = computeScore({ confidence: 1, ageHours: 0, relatedToActiveNote: true, settings });
    const halflife = computeScore({
      confidence: 1,
      ageHours: settings.recencyHalfLifeHours,
      relatedToActiveNote: true,
      settings,
    });
    expect(halflife).toBeCloseTo(fresh * Math.exp(-1), 6);
  });

  test("rank sorts descending by score and respects maxItems", () => {
    const inputs: RankInput[] = [
      { id: "a", confidence: 0.4, ageHours: 0, relatedToActiveNote: false },
      { id: "b", confidence: 0.9, ageHours: 24, relatedToActiveNote: true },
      { id: "c", confidence: 0.7, ageHours: 0, relatedToActiveNote: true },
    ];
    const ranked = rank(inputs, { ...settings, maxItems: 2 });
    expect(ranked.map((r) => r.id)).toEqual(["c", "b"]);
    expect(ranked).toHaveLength(2);
  });

  test("zero confidence collapses score to zero", () => {
    expect(computeScore({ confidence: 0, ageHours: 0, relatedToActiveNote: true, settings })).toBe(
      0,
    );
  });
});
