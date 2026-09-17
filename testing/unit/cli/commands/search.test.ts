import { describe, expect, test } from "bun:test";
import { parseSearchMode } from "../../../../src/cli/commands/search";

describe("parseSearchMode", () => {
  test("returns undefined when the flag is absent so the daemon default applies", () => {
    expect(parseSearchMode(undefined)).toBeUndefined();
  });

  test("accepts the three known modes", () => {
    expect(parseSearchMode("quick")).toBe("quick");
    expect(parseSearchMode("balanced")).toBe("balanced");
    expect(parseSearchMode("deep")).toBe("deep");
  });

  test("rejects an unknown mode with a usage error", () => {
    expect(() => parseSearchMode("banana")).toThrow(/INVALID_PARAMS/);
    expect(() => parseSearchMode("banana")).toThrow(/quick\|balanced\|deep/);
  });

  test("rejects a bare --mode flag with no value", () => {
    expect(() => parseSearchMode(true)).toThrow(/INVALID_PARAMS/);
  });
});
