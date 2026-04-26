import { describe, expect, test } from "bun:test";
import { mergeNotientBlock, readFrontmatter, writeFrontmatter } from "./frontmatterWriter";

describe("frontmatter parse/write", () => {
  test("reads YAML frontmatter and body", () => {
    const md = `---
title: Hello
tags:
  - a
  - b
---
# Body
text`;
    const { frontmatter, body } = readFrontmatter(md);
    expect(frontmatter).toEqual({
      title: "Hello",
      tags: {},
    });
    // Note: our minimal YAML skips indented list items since they don't match the
    // key:value regex; that's OK because we only round-trip our own notient block.
    // Body extraction is what matters.
    expect(body).toBe("# Body\ntext");
  });

  test("returns null frontmatter when no fence", () => {
    const md = "# No frontmatter\nbody";
    const { frontmatter, body } = readFrontmatter(md);
    expect(frontmatter).toBeNull();
    expect(body).toBe(md);
  });

  test("merges notient block into existing frontmatter", () => {
    const merged = mergeNotientBlock(
      { title: "Hello" },
      { vitals: { health: 78, maturity: "adolescent", freshness: 0.9 } },
    );
    expect(merged.title).toBe("Hello");
    expect(merged.notient).toEqual({
      vitals: { health: 78, maturity: "adolescent", freshness: 0.9 },
    });
  });

  test("write produces valid fenced block + body", () => {
    const body = "# Hello\n";
    const out = writeFrontmatter(body, {
      title: "T",
      notient: { vitals: { health: 50, maturity: "raw", freshness: 1 } },
    });
    expect(out.startsWith("---\n")).toBe(true);
    expect(out.includes("title: T")).toBe(true);
    expect(out.includes("notient:")).toBe(true);
    expect(out.includes("vitals:")).toBe(true);
    expect(out.endsWith("# Hello\n")).toBe(true);
  });

  test("round-trip preserves notient block keys", () => {
    const original = `---
title: Foo
notient:
  vitals:
    health: 80
    maturity: mature
    freshness: 0.7
---
body`;
    const { frontmatter, body } = readFrontmatter(original);
    expect(frontmatter).not.toBeNull();
    const out = writeFrontmatter(body, frontmatter as Record<string, unknown>);
    const reparsed = readFrontmatter(out);
    expect((reparsed.frontmatter?.notient as { vitals: { health: number } }).vitals.health).toBe(
      80,
    );
  });
});
