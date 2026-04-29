import { describe, expect, test } from "bun:test";
import { resolveTargets, type ResolveInput } from "./resolver";

function makeInput(rawTarget: string): ResolveInput {
  return { rawTarget, targetHeading: null, targetBlockId: null };
}

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
      [
        "projects/alpha/active.md",
        "projects/alpha/readme.md",
        "archive/old/readme.md",
      ],
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
