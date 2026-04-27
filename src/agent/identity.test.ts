import { describe, expect, test } from "bun:test";
import { TIER_1_IDENTITY } from "./identity";

describe("TIER_1_IDENTITY", () => {
  test("contains the steward framing", () => {
    expect(TIER_1_IDENTITY).toContain("steward of a sentient vault");
  });

  test("contains the local-only framing", () => {
    expect(TIER_1_IDENTITY).toContain("Nothing leaves the box");
  });

  test("is non-empty multi-paragraph prose", () => {
    const paragraphs = TIER_1_IDENTITY.split("\n\n").filter(
      (paragraph) => paragraph.trim().length > 0,
    );
    expect(paragraphs.length).toBeGreaterThanOrEqual(3);
  });
});
