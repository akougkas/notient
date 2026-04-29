import { describe, expect, test } from "bun:test";
import { headingSlug } from "./slug";

describe("headingSlug", () => {
  test("lowercases and replaces whitespace with dashes", () => {
    expect(headingSlug("Heading One")).toBe("heading-one");
  });

  test("strips punctuation", () => {
    expect(headingSlug("What's New?")).toBe("whats-new");
  });

  test("collapses runs of whitespace", () => {
    expect(headingSlug("  spaced   out  ")).toBe("spaced-out");
  });

  test("preserves non-ASCII letters lowercased", () => {
    expect(headingSlug("Café")).toBe("café");
    expect(headingSlug("Über alles")).toBe("über-alles");
  });

  test("returns empty string on empty input", () => {
    expect(headingSlug("")).toBe("");
  });

  test("preserves digits", () => {
    expect(headingSlug("Section 42")).toBe("section-42");
  });

  test("collapses multiple dashes", () => {
    expect(headingSlug("a -- b")).toBe("a-b");
  });
});
