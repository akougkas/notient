import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  locateFrontmatter,
  patchFrontmatter,
  readFrontmatter,
} from "../../../../src/core/markdown/frontmatter";

const fixtureDir = join(import.meta.dir, "../../../fixtures/markdown");

function load(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}

/** Body bytes after the closing fence must never move. */
function expectBodyByteIdentical(before: string, after: string): void {
  const a = readFrontmatter(before);
  const b = readFrontmatter(after);
  expect(after.slice(b.end)).toBe(before.slice(a.end));
}

describe("readFrontmatter", () => {
  test("returns offsets and parsed data for a block-form document", () => {
    const source = "---\ntitle: x\naliases:\n  - a\n  - b\n---\nbody\n";
    const found = readFrontmatter(source);
    expect(found.start).toBe(0);
    expect(source.slice(found.end)).toBe("body\n");
    expect(found.raw).toBe("title: x\naliases:\n  - a\n  - b\n");
    expect(found.data).toEqual({ title: "x", aliases: ["a", "b"] });
  });

  test("reports no frontmatter when the note starts with body text", () => {
    const found = readFrontmatter("just a body\n");
    expect(found.data).toBeNull();
    expect(found.start).toBe(0);
    expect(found.end).toBe(0);
  });

  test("a `---` inside the body is a thematic break, not frontmatter", () => {
    const found = readFrontmatter("para\n\n---\n\nmore\n");
    expect(found.data).toBeNull();
  });

  test("an unterminated opening fence is not frontmatter", () => {
    const found = readFrontmatter("---\ntitle: x\nbody with no closing fence\n");
    expect(found.data).toBeNull();
  });

  test("skips a BOM and reports offsets past it", () => {
    const source = "﻿---\ntitle: x\n---\nbody\n";
    const found = readFrontmatter(source);
    expect(found.start).toBe(1);
    expect(found.data).toEqual({ title: "x" });
    expect(source.slice(found.end)).toBe("body\n");
  });

  test("handles CRLF documents", () => {
    const source = "---\r\ntitle: x\r\n---\r\nbody\r\n";
    const found = readFrontmatter(source);
    expect(found.data).toEqual({ title: "x" });
    expect(source.slice(found.end)).toBe("body\r\n");
  });

  test("throws FRONTMATTER_UNPARSEABLE rather than guessing", () => {
    expect(() => readFrontmatter("---\na: [1,\n---\nbody\n")).toThrow(/^FRONTMATTER_UNPARSEABLE: /);
  });

  test("location remains available when the YAML is malformed", () => {
    const source = "---\na: [1,\n---\nbody\n";
    const location = locateFrontmatter(source);
    expect(location).not.toBeNull();
    expect(source.slice(location?.end)).toBe("body\n");
  });
});

describe("patchFrontmatter", () => {
  test("preserves block-form lists that the old flat parser deleted", () => {
    const source = load("obsidian-syntax.md");
    const out = patchFrontmatter(source, { status: "live" });
    const data = readFrontmatter(out).data as Record<string, unknown>;
    expect(data.aliases).toEqual(["obsidian", "syntax"]);
    expect(data.tags).toEqual(["fixture", "markdown"]);
    expect(data.cssclasses).toEqual(["wide"]);
    expect(out).toContain("aliases:\n  - obsidian\n  - syntax\n");
    expect(out).toContain("cssclasses:\n  - wide\n");
    expect(out).toContain("status: live\n");
    expectBodyByteIdentical(source, out);
  });

  test("body bytes are byte-identical after a patch", () => {
    for (const name of ["writeback-input.md", "golden.md", "edge-cases.md", "obsidian-syntax.md"]) {
      const source = load(name);
      expectBodyByteIdentical(source, patchFrontmatter(source, { touched: true }));
    }
  });

  test("adds a top-level key and keeps the rest byte-identical", () => {
    const source = "---\ntitle: old\n---\nbody\n";
    expect(patchFrontmatter(source, { title: "new", tag: "alpha" })).toBe(
      "---\ntitle: new\ntag: alpha\n---\nbody\n",
    );
  });

  test("null deletes a key", () => {
    expect(patchFrontmatter("---\na: 1\nb: 2\n---\nbody\n", { b: null })).toBe(
      "---\na: 1\n---\nbody\n",
    );
  });

  test("merges one level into an existing mapping", () => {
    const source = "---\nnotient:\n  health: 0.1\n  maturity: raw\n---\nbody\n";
    const out = patchFrontmatter(source, { notient: { health: 0.9, freshness: 0.5 } });
    expect(readFrontmatter(out).data).toEqual({
      notient: { health: 0.9, maturity: "raw", freshness: 0.5 },
    });
    expectBodyByteIdentical(source, out);
  });

  test("keeps comments, quoting styles and date scalars on untouched keys", () => {
    const source = [
      "---",
      "# leading comment",
      "title: Keep Me # trailing",
      "date: 2026-01-02",
      "quoted: 'single'",
      "aliases:",
      "  - a",
      "  - b",
      "---",
      "body\n",
    ].join("\n");
    const out = patchFrontmatter(source, { status: "done" });
    expect(out).toContain("# leading comment");
    expect(out).toContain("title: Keep Me # trailing");
    expect(out).toContain("date: 2026-01-02");
    expect(out).toContain("quoted: 'single'");
    expect(out).toContain("aliases:\n  - a\n  - b");
    expectBodyByteIdentical(source, out);
  });

  test("adds a scalar without changing any existing column-zero fixture bytes", () => {
    const source = load("frontmatter-column-zero.md");
    const out = patchFrontmatter(source, { reviewed: true });
    const expected = source.replace(
      "\n---\n# Fixture body",
      "\nreviewed: true\n---\n# Fixture body",
    );
    expect(out).toBe(expected);
  });

  test("inserts before trailing comments without rewriting them", () => {
    const source = "---\ntitle: x\n\n# Keep this trailing comment.\n---\nbody\n";
    const out = patchFrontmatter(source, { status: "reviewed" });
    expect(out).toBe(
      "---\ntitle: x\nstatus: reviewed\n\n# Keep this trailing comment.\n---\nbody\n",
    );
  });

  test("replaces one quoted scalar and preserves comments and complex scalar bytes", () => {
    const source = load("frontmatter-column-zero.md");
    const out = patchFrontmatter(source, { status: "reviewed" });
    const expected = source.replace(
      "status: 'draft' # This is the scalar the tests replace.\n",
      "status: reviewed\n",
    );
    expect(out).toBe(expected);
  });

  test("splices a column-zero block list without reindenting it", () => {
    const source = load("frontmatter-column-zero.md");
    const out = patchFrontmatter(source, { aliases: ["new", "two words"] });
    const expected = source.replace(
      "aliases:\n- alpha\n- 'beta value'\n",
      "aliases:\n- new\n- two words\n",
    );
    expect(out).toBe(expected);
  });

  test("splices an indented block list at its existing indentation", () => {
    const source = load("frontmatter-indented.md");
    const out = patchFrontmatter(source, { tags: ["new", "two words"] });
    const expected = source.replace(
      'tags:\n    - alpha\n    - "beta value"\n',
      "tags:\n    - new\n    - two words\n",
    );
    expect(out).toBe(expected);
  });

  test("splices a flow list without changing adjacent lines", () => {
    const source = load("frontmatter-indented.md");
    const out = patchFrontmatter(source, { related: ["new", "two words"] });
    const expected = source.replace(
      'related: [alpha, beta,"gamma value"]\n',
      "related: [ new, two words ]\n",
    );
    expect(out).toBe(expected);
  });

  test("preserves CRLF bytes around a scalar splice", () => {
    const source = load("frontmatter-column-zero.md").replace(/\n/g, "\r\n");
    const out = patchFrontmatter(source, { status: "reviewed" });
    const expected = source.replace(
      "status: 'draft' # This is the scalar the tests replace.\r\n",
      "status: reviewed\r\n",
    );
    expect(out).toBe(expected);
  });

  test("preserves CRLF line endings for the block it authors", () => {
    const source = "---\r\ntitle: x\r\naliases:\r\n  - a\r\n---\r\nbody\r\nmore\r\n";
    const out = patchFrontmatter(source, { tag: "t" });
    expect(out).toBe("---\r\ntitle: x\r\naliases:\r\n  - a\r\ntag: t\r\n---\r\nbody\r\nmore\r\n");
  });

  test("preserves a BOM", () => {
    const out = patchFrontmatter("﻿---\ntitle: x\n---\nbody\n", { tag: "t" });
    expect(out).toBe("﻿---\ntitle: x\ntag: t\n---\nbody\n");
  });

  test("prepends a block when the note has no frontmatter", () => {
    expect(patchFrontmatter("body only", { foo: "bar" })).toBe("---\nfoo: bar\n---\nbody only");
  });

  test("does not fold long scalars onto continuation lines", () => {
    const value = "a".repeat(120);
    const out = patchFrontmatter("---\ntitle: x\n---\nbody\n", { desc: value });
    expect(out).toContain(`desc: ${value}\n`);
  });

  test("throws FRONTMATTER_UNPARSEABLE with a reason on malformed YAML", () => {
    expect(() => patchFrontmatter("---\na: [1,\n---\nbody\n", { x: 1 })).toThrow(
      /^FRONTMATTER_UNPARSEABLE: /,
    );
  });
});
