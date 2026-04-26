import { describe, expect, test } from "bun:test";
import {
  type NotientFrontmatter,
  extractNotientBlock,
  formatNotientBlock,
  upsertNotientBlock,
} from "./frontmatterWriter";

describe("frontmatterWriter (merge-only)", () => {
  test("formatNotientBlock emits canonical YAML", () => {
    const block: NotientFrontmatter = {
      vitals: { health: 78, maturity: "adolescent", freshness: 0.92 },
      edges: [{ type: "supports", target: "[[Other]]", confidence: 0.84, evidence: "p3" }],
      summary: "A short take.",
      updated: "2026-04-25T18:00:00Z",
    };
    const yaml = formatNotientBlock(block);
    expect(yaml).toBe(
      "notient:\n" +
        "  vitals:\n" +
        "    health: 78\n" +
        "    maturity: adolescent\n" +
        "    freshness: 0.92\n" +
        "  edges:\n" +
        '    - { type: supports, target: "[[Other]]", confidence: 0.84, evidence: p3 }\n' +
        "  summary: A short take.\n" +
        "  updated: 2026-04-25T18:00:00Z\n",
    );
  });

  test("extractNotientBlock returns null when no fenced frontmatter", () => {
    expect(extractNotientBlock("# Just a heading\n")).toBeNull();
  });

  test("extractNotientBlock returns null when notient key missing", () => {
    const md = "---\ntitle: Hi\n---\nbody";
    expect(extractNotientBlock(md)).toBeNull();
  });

  test("extractNotientBlock returns the literal block text", () => {
    const md =
      "---\n" +
      "title: Hi\n" +
      "notient:\n" +
      "  vitals:\n" +
      "    health: 80\n" +
      "tags: [a, b]\n" +
      "---\n" +
      "body";
    const block = extractNotientBlock(md);
    expect(block).toBe("notient:\n  vitals:\n    health: 80\n");
  });

  test("upsertNotientBlock inserts when no frontmatter exists", () => {
    const out = upsertNotientBlock("body only\n", {
      summary: "s",
      updated: "2026-04-25T00:00:00Z",
    });
    expect(out).toBe(
      "---\n" +
        "notient:\n" +
        "  summary: s\n" +
        "  updated: 2026-04-25T00:00:00Z\n" +
        "---\n" +
        "body only\n",
    );
  });

  test("upsertNotientBlock inserts into existing frontmatter without touching other keys", () => {
    const original =
      "---\n" + "title: User Note\n" + "tags: [- a, - b]\n" + "---\n" + "# Body\nstuff";
    const out = upsertNotientBlock(original, {
      summary: "fresh",
      updated: "2026-04-25T00:00:00Z",
    });
    expect(out).toContain("title: User Note");
    expect(out).toContain("tags: [- a, - b]");
    expect(out).toContain("notient:\n  summary: fresh\n  updated: 2026-04-25T00:00:00Z\n");
    expect(out.endsWith("# Body\nstuff")).toBe(true);
  });

  test("upsertNotientBlock replaces existing notient block in place", () => {
    const original =
      "---\n" +
      "title: T\n" +
      "notient:\n" +
      "  summary: old\n" +
      "  updated: 2026-04-01T00:00:00Z\n" +
      "tags: [keep, me]\n" +
      "---\n" +
      "body";
    const out = upsertNotientBlock(original, {
      summary: "new",
      updated: "2026-04-25T00:00:00Z",
    });
    expect(out).toContain("title: T");
    expect(out).toContain("tags: [keep, me]");
    expect(out).toContain("summary: new");
    expect(out).not.toContain("summary: old");
  });

  test("upsertNotientBlock preserves user array data verbatim across replace", () => {
    const original =
      "---\n" +
      "tags:\n" +
      "  - a\n" +
      "  - b\n" +
      "  - c\n" +
      "notient:\n" +
      "  summary: old\n" +
      "---\n" +
      "body";
    const out = upsertNotientBlock(original, { summary: "new" });
    expect(out).toContain("tags:\n  - a\n  - b\n  - c\n");
    expect(out).toContain("summary: new");
  });
});
