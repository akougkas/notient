import { describe, expect, test } from "bun:test";
import {
  type ResolveInput,
  parseMarkdownDestination,
  resolveMarkdownTarget,
  resolveTargets,
} from "../../../../src/core/markdown/resolver";

function makeInput(rawTarget: string): ResolveInput {
  return { rawTarget, targetHeading: null, targetBlockId: null };
}

test("Markdown destinations resolve locally without basename fallback or vault escapes", () => {
  const paths = [
    "Projects/Active.md",
    "Projects/Reference.md",
    "Design Notes.md",
    "Elsewhere/Remote.md",
  ];
  expect(resolveMarkdownTarget("Projects/Active.md", "../Design Notes.md", paths)).toBe(
    "Design Notes.md",
  );
  expect(resolveMarkdownTarget("Projects/Active.md", "Reference", paths)).toBe(
    "Projects/Reference.md",
  );
  expect(resolveMarkdownTarget("Projects/Active.md", "/Design Notes.md", paths)).toBe(
    "Design Notes.md",
  );
  expect(resolveMarkdownTarget("Projects/Active.md", "Remote", paths)).toBeNull();
  expect(resolveMarkdownTarget("Projects/Active.md", "../../Design Notes.md", paths)).toBeNull();
  expect(resolveMarkdownTarget("Projects/Active.md", "", paths)).toBe("Projects/Active.md");
  expect(parseMarkdownDestination("../C%23%20Notes.md#Trade%20offs")).toEqual({
    rawTarget: "../C# Notes.md",
    targetHeading: "Trade offs",
    targetBlockId: null,
  });
  expect(parseMarkdownDestination("//example.com/Note.md")).toBeNull();
  expect(parseMarkdownDestination("%2E%2E%5Coutside.md")).toBeNull();
});

describe("resolveTargets", () => {
  test("exact path match", () => {
    const result = resolveTargets(
      "notes/active.md",
      [makeInput("notes/other.md")],
      ["notes/active.md", "notes/other.md"],
    );
    expect(result[0].targetPath).toBe("notes/other.md");
  });

  test("exact path match without .md suffix", () => {
    const result = resolveTargets(
      "notes/active.md",
      [makeInput("notes/other")],
      ["notes/active.md", "notes/other.md"],
    );
    expect(result[0].targetPath).toBe("notes/other.md");
  });

  test("basename match with single candidate", () => {
    const result = resolveTargets(
      "notes/active.md",
      [makeInput("orphan")],
      ["notes/active.md", "deep/folder/orphan.md"],
    );
    expect(result[0].targetPath).toBe("deep/folder/orphan.md");
  });

  test("basename match with folder-distance disambiguation", () => {
    const result = resolveTargets(
      "projects/alpha/active.md",
      [makeInput("readme")],
      ["projects/alpha/active.md", "projects/alpha/readme.md", "archive/old/readme.md"],
    );
    expect(result[0].targetPath).toBe("projects/alpha/readme.md");
  });

  test("returns null for unresolved targets", () => {
    const result = resolveTargets(
      "notes/active.md",
      [makeInput("non-existent")],
      ["notes/active.md"],
    );
    expect(result[0].targetPath).toBeNull();
  });

  test("does not basename-match when raw contains /", () => {
    const result = resolveTargets(
      "notes/active.md",
      [makeInput("notes/missing")],
      ["notes/active.md", "other/missing.md"],
    );
    expect(result[0].targetPath).toBeNull();
  });

  test("preserves heading and block fields on output", () => {
    const result = resolveTargets(
      "notes/active.md",
      [{ rawTarget: "other", targetHeading: "Section", targetBlockId: "abc" }],
      ["notes/active.md", "notes/other.md"],
    );
    expect(result[0].targetHeading).toBe("Section");
    expect(result[0].targetBlockId).toBe("abc");
    expect(result[0].targetPath).toBe("notes/other.md");
  });
});
