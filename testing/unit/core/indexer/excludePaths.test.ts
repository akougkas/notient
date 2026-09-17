import { describe, expect, test } from "bun:test";
import {
  globToRegExp,
  isExcluded,
  makeExclusionPredicate,
  normalizeExcludePatterns,
} from "../../../../src/core/indexer/excludePaths";

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

describe("makeExclusionPredicate", () => {
  const predicate = makeExclusionPredicate({
    excludePaths: ["Notient/conversations", "Notient/proposals"],
    excludeGlobs: ["**/*.excalidraw.md"],
  });

  test("excludes notes beneath a configured folder", () => {
    expect(predicate("Notient/conversations/x.md")).toBe(true);
    expect(predicate("Notient/conversations/2026/x.md")).toBe(true);
    expect(predicate("Notient/proposals/p.md")).toBe(true);
  });

  test("always excludes Notient-owned stores case-insensitively", () => {
    const unconfigured = makeExclusionPredicate({ excludePaths: [], excludeGlobs: [] });
    expect(unconfigured("notient/CONVERSATIONS/private.md")).toBe(true);
    expect(unconfigured("NOTIENT/proposals/pending.md")).toBe(true);
    expect(unconfigured("Notient/conversations.md")).toBe(false);
    expect(unconfigured("Notient/proposals-public/note.md")).toBe(false);
  });

  test("does not treat a folder pattern as a prefix match", () => {
    expect(predicate("Notient/conversationsX/x.md")).toBe(false);
    expect(predicate("Notient/conversations.md")).toBe(false);
    expect(predicate("notes/topic.md")).toBe(false);
  });

  test("matches a leading double-star glob at any depth, including zero", () => {
    expect(predicate("b.excalidraw.md")).toBe(true);
    expect(predicate("a/b.excalidraw.md")).toBe(true);
    expect(predicate("a/b/c.excalidraw.md")).toBe(true);
    expect(predicate("a/b.md")).toBe(false);
  });

  test("empty settings retain only the mandatory exclusions", () => {
    const none = makeExclusionPredicate({ excludePaths: [], excludeGlobs: [] });
    expect(none("Notient/conversations/x.md")).toBe(true);
    expect(none("Notient/proposals/x.md")).toBe(true);
    expect(none("b.excalidraw.md")).toBe(false);
    expect(none("notes/topic.md")).toBe(false);
  });
});

describe("globToRegExp", () => {
  test("`*` stays inside one segment", () => {
    expect(globToRegExp("notes/*.md").test("notes/a.md")).toBe(true);
    expect(globToRegExp("notes/*.md").test("notes/sub/a.md")).toBe(false);
  });

  test("bare `**` spans segments", () => {
    expect(globToRegExp("notes/**").test("notes/sub/a.md")).toBe(true);
  });

  test("`?` matches exactly one non-slash character", () => {
    expect(globToRegExp("a?.md").test("ab.md")).toBe(true);
    expect(globToRegExp("a?.md").test("abc.md")).toBe(false);
    expect(globToRegExp("a?.md").test("a/.md")).toBe(false);
  });

  test("a leading slash is the Obsidian root anchor, not a literal", () => {
    const predicate = makeExclusionPredicate({
      excludePaths: ["/Archive"],
      excludeGlobs: ["/Private/**"],
    });
    expect(predicate("Private/x.md")).toBe(true);
    expect(predicate("Archive/old.md")).toBe(true);
    expect(predicate("Notes/x.md")).toBe(false);
  });

  test("regex metacharacters in the pattern are literal", () => {
    expect(globToRegExp("a+b.md").test("a+b.md")).toBe(true);
    expect(globToRegExp("a+b.md").test("aab.md")).toBe(false);
    expect(globToRegExp("v1.md").test("v1xmd")).toBe(false);
  });
});
