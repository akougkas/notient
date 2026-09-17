import { describe, expect, test } from "bun:test";
import { NOTIENT_IDENTITY } from "../../../src/agent/identity";

describe("NOTIENT_IDENTITY", () => {
  test("makes the notes sentient while every host remains a visitor", () => {
    expect(NOTIENT_IDENTITY).toContain("notes themselves becoming sentient");
    expect(NOTIENT_IDENTITY).toContain("hosting a conversation is a visitor");
    expect(NOTIENT_IDENTITY).toContain("External agents, integrations, and tools are visitors");
    expect(NOTIENT_IDENTITY).not.toContain("steward of a sentient vault");
  });

  test("contains the local-first provider framing", () => {
    expect(NOTIENT_IDENTITY).toContain("Notient is local-first");
    expect(NOTIENT_IDENTITY).toContain("operator-configured inference endpoints");
  });

  test("is non-empty multi-paragraph prose", () => {
    const paragraphs = NOTIENT_IDENTITY.split("\n\n").filter(
      (paragraph) => paragraph.trim().length > 0,
    );
    expect(paragraphs.length).toBeGreaterThanOrEqual(3);
  });
});
