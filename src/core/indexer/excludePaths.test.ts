import { describe, expect, test } from "bun:test";
import { isExcluded, normalizeExcludePatterns } from "./excludePaths";

describe("excludePaths", () => {
  test("matches paths beneath an excluded folder", () => {
    const patterns = normalizeExcludePatterns(["Notient/conversations"]);
    expect(isExcluded("Notient/conversations/2026-04-25 chat.md", patterns)).toBe(true);
    expect(isExcluded("Notient/conversations/sub/chat.md", patterns)).toBe(true);
  });

  test("does not match paths outside excluded folders", () => {
    const patterns = normalizeExcludePatterns(["Notient/conversations"]);
    expect(isExcluded("notes/topic.md", patterns)).toBe(false);
    expect(isExcluded("Notient/conversations.md", patterns)).toBe(false);
  });

  test("matches the exact folder boundary, not a substring", () => {
    const patterns = normalizeExcludePatterns(["Note"]);
    expect(isExcluded("Note/x.md", patterns)).toBe(true);
    expect(isExcluded("Notebook/x.md", patterns)).toBe(false);
  });

  test("normalises trailing slashes and leading dots", () => {
    const patterns = normalizeExcludePatterns(["Notient/conversations/", "./Notient/proposals"]);
    expect(isExcluded("Notient/conversations/x.md", patterns)).toBe(true);
    expect(isExcluded("Notient/proposals/y.md", patterns)).toBe(true);
  });
});
