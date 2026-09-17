import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readFrontmatter } from "../../../../src/core/markdown/frontmatter";
import { applyApprovedLink, applyApprovedRelation } from "../../../../src/core/markdown/writeback";

const fixtureDir = join(import.meta.dir, "../../../fixtures/markdown");
const fixturePath = join(fixtureDir, "writeback-input.md");

function loadFixture(): string {
  return readFileSync(fixturePath, "utf8");
}

function load(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}

/**
 * Assert that `after` is `before` with exactly one contiguous insertion:
 * every byte before the insertion point and every byte after it is
 * unchanged. This is the whole point of splicing over re-serializing.
 */
function expectSingleInsertion(before: string, after: string): string {
  let head = 0;
  while (head < before.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < before.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  expect(head + tail).toBe(before.length);
  return after.slice(head, after.length - tail);
}

describe("applyApprovedLink", () => {
  test("appends a new list item under an existing ## Related section", () => {
    const source = loadFixture();
    const result = applyApprovedLink(source, { target: "FreshTarget" });

    expect(result).not.toBe(source);
    expect(result).toContain("- [[ExistingOne]]");
    expect(result).toContain("- [[ExistingTwo#Section]]");
    expect(result).toContain("- [[FreshTarget]]");

    const relatedBlock = result.slice(result.indexOf("## Related"), result.indexOf("## Notes"));
    const items = relatedBlock.match(/^- \[\[.+?\]\]$/gm) ?? [];
    expect(items).toEqual(["- [[ExistingOne]]", "- [[ExistingTwo#Section]]", "- [[FreshTarget]]"]);

    expect(result).toContain("## Notes\n\nTrailing section");
  });

  test("creates ## Related at end of body when absent", () => {
    const source = "# Solo\n\nOnly an intro paragraph here.\n";
    const result = applyApprovedLink(source, { target: "BrandNew" });

    expect(result.startsWith(source)).toBe(true);
    expect(result).toContain("## Related");
    expect(result).toContain("- [[BrandNew]]");
    expect(result.indexOf("## Related")).toBeGreaterThan(source.indexOf("intro paragraph"));
  });

  test("is a no-op when the target wikilink already exists in the list", () => {
    const source = loadFixture();
    const result = applyApprovedLink(source, { target: "ExistingOne" });
    expect(result).toBe(source);
  });

  test("formats heading qualifier as [[target#heading]]", () => {
    const source = "## Related\n\n- [[Other]]\n";
    const result = applyApprovedLink(source, { target: "Note", heading: "Subsection" });
    expect(result).toContain("- [[Note#Subsection]]");
  });

  test("formats block qualifier as [[target#^block]]", () => {
    const source = "## Related\n\n- [[Other]]\n";
    const result = applyApprovedLink(source, { target: "Note", block: "para-7" });
    expect(result).toContain("- [[Note#^para-7]]");
  });

  test("treats heading-qualified link as distinct from a plain link", () => {
    const source = "## Related\n\n- [[Note#Section]]\n";
    const plain = applyApprovedLink(source, { target: "Note" });
    expect(plain).not.toBe(source);
    expect(plain).toContain("- [[Note#Section]]");
    expect(plain).toContain("- [[Note]]");
  });

  test("is idempotent when the qualified link already exists", () => {
    const source = "## Related\n\n- [[Note#Section]]\n";
    const result = applyApprovedLink(source, { target: "Note", heading: "Section" });
    expect(result).toBe(source);
  });

  test("treats block-qualified link as distinct from a plain link", () => {
    const source = "## Related\n\n- [[Note#^block-1]]\n";
    const plain = applyApprovedLink(source, { target: "Note" });
    expect(plain).not.toBe(source);
    expect(plain).toContain("- [[Note#^block-1]]");
    expect(plain).toContain("- [[Note]]");
  });

  test("rejects calls with both heading and block qualifiers", () => {
    expect(() => applyApprovedLink("", { target: "X", heading: "H", block: "B" })).toThrow(
      /mutually exclusive/,
    );
  });

  test("two consecutive applications produce the same output as one", () => {
    const source = loadFixture();
    const once = applyApprovedLink(source, { target: "Determinism" });
    const twice = applyApprovedLink(once, { target: "Determinism" });
    expect(twice).toBe(once);
  });

  test("an existing embed bullet does not block a new wikilink for the same target", () => {
    // wikiEmbed and wikiLink are distinct edge kinds (embed = transclusion,
    // link = reference). An embed already in the section must not block a
    // newly approved link.
    const source = "## Related\n\n- ![[Note]]\n";
    const result = applyApprovedLink(source, { target: "Note" });
    expect(result).not.toBe(source);
    expect(result).toContain("- ![[Note]]");
    expect(result).toContain("- [[Note]]");
  });

  test("applyApprovedLink only emits wikiLink, never wikiEmbed", () => {
    // applyApprovedLink takes no embed flag; an existing plain link is the
    // idempotent block, but the writeback never emits an embed itself.
    const source = "## Related\n\n- [[Note]]\n";
    const result = applyApprovedLink(source, { target: "Note" });
    expect(result).toBe(source);
    // And from a clean slate the appended row is a link, not an embed.
    const empty = "## Related\n";
    const appended = applyApprovedLink(empty, { target: "Note" });
    expect(appended).toContain("- [[Note]]");
    expect(appended).not.toContain("- ![[Note]]");
  });

  test("idempotency walks every wikilink in a list item, not just the first", () => {
    // A bullet that already mentions the target as a non-first wikilink must
    // still be recognised; otherwise we duplicate the row.
    const source = "## Related\n\n- See [[Existing]] also [[Other]]\n";
    const result = applyApprovedLink(source, { target: "Other" });
    expect(result).toBe(source);
  });

  test("first ## Related wins; subsequent ## Related sections are byte-identical", () => {
    const source = [
      "# Doc",
      "",
      "## Related",
      "",
      "- [[First]]",
      "",
      "## Notes",
      "",
      "Body.",
      "",
      "## Related",
      "",
      "- [[Second]]",
      "",
    ].join("\n");
    const result = applyApprovedLink(source, { target: "Fresh" });
    expect(result).not.toBe(source);
    // First section: the new bullet appears.
    const firstRelatedStart = result.indexOf("## Related");
    const notesStart = result.indexOf("## Notes");
    const firstSection = result.slice(firstRelatedStart, notesStart);
    expect(firstSection).toContain("- [[First]]");
    expect(firstSection).toContain("- [[Fresh]]");
    // Second section: byte-identical to the input's second section.
    const secondSourceStart = source.lastIndexOf("## Related");
    const secondSourceTail = source.slice(secondSourceStart);
    const secondResultStart = result.lastIndexOf("## Related");
    const secondResultTail = result.slice(secondResultStart);
    expect(secondResultTail).toBe(secondSourceTail);
  });

  test("ignores a Related heading inside a frontmatter block scalar", () => {
    const source = [
      "---",
      "desc: |",
      "  ## Related",
      "  This is YAML, not a body section.",
      "---",
      "# Doc",
      "",
      "Body.",
      "",
    ].join("\n");
    const result = applyApprovedLink(source, { target: "Fresh" });
    const bodyStart = readFrontmatter(source).end;

    expect(result.startsWith(source)).toBe(true);
    expect(result.indexOf("## Related", bodyStart)).toBeGreaterThan(bodyStart);
    expect(result.slice(0, bodyStart)).toBe(source.slice(0, bodyStart));
    expect(result).toContain("## Related\n\n- [[Fresh]]\n");
  });

  test("closes an unterminated body fence before creating Related", () => {
    const source = [
      "---",
      "desc: |",
      "  ## Related",
      "---",
      "# Probe",
      "",
      "```ts",
      "const open = true;",
    ].join("\n");
    const result = applyApprovedLink(source, { target: "IOWarp" });

    expect(result).toBe(`${source}\n\`\`\`\n\n## Related\n\n- [[IOWarp]]`);
  });

  test("uses the matching fence character and length when repairing EOF", () => {
    const source = "# Probe\n\n~~~~text\ninside\n";
    const result = applyApprovedLink(source, { target: "Fresh" });
    expect(result).toBe("# Probe\n\n~~~~text\ninside\n~~~~\n\n## Related\n\n- [[Fresh]]\n");
  });

  test("inserts after the first list before a nested heading", () => {
    const source = [
      "## Related",
      "",
      "- [[One]]",
      "- [[Two]]",
      "  - nested context",
      "",
      "### Commentary",
      "",
      "The new link must not land here.",
      "",
    ].join("\n");
    const result = applyApprovedLink(source, { target: "Fresh" });

    expect(result).toContain(
      "- [[One]]\n- [[Two]]\n  - nested context\n- [[Fresh]]\n\n### Commentary",
    );
    expect(result.indexOf("- [[Fresh]]")).toBeLessThan(result.indexOf("### Commentary"));
  });

  test("a link shown only inside code does not suppress the real bullet", () => {
    const source = "## Related\n\n```md\n- [[Fresh]]\n```\n";
    const result = applyApprovedLink(source, { target: "Fresh" });
    expect(result).toBe("## Related\n\n- [[Fresh]]\n\n```md\n- [[Fresh]]\n```\n");
  });

  test("an existing link remains a byte-identical no-op with a later open fence", () => {
    const source = "## Related\n\n- [[Fresh]]\n\n```ts\nopen";
    expect(applyApprovedLink(source, { target: "Fresh" })).toBe(source);
  });

  test("recognizes a Related heading on a BOM-prefixed first line", () => {
    const source = "﻿## Related\n\n- [[One]]\n";
    const result = applyApprovedLink(source, { target: "Two" });
    expect(result).toBe("﻿## Related\n\n- [[One]]\n- [[Two]]\n");
  });

  test("skips malformed but fenced frontmatter without parsing it", () => {
    const source = "---\ndesc: [broken\n  ## Related\n---\n# Body\n";
    const result = applyApprovedLink(source, { target: "Fresh" });
    expect(result.startsWith(source)).toBe(true);
    expect(result).toContain("# Body\n\n## Related\n\n- [[Fresh]]\n");
  });
});

describe("applyApprovedRelation", () => {
  test("appends to an existing notient.<key> array preserving prior entries", () => {
    const source = loadFixture();
    const result = applyApprovedRelation(source, {
      key: "contradicts",
      target: "another-note",
    });
    expect(result).not.toBe(source);
    expect(result).toContain("[[contradicting-note]]");
    expect(result).toContain("[[another-note]]");

    const fmEnd = result.indexOf("\n---", 4);
    const frontmatterBlock = result.slice(0, fmEnd);
    expect(frontmatterBlock).toContain("contradicts:");
    const entries = frontmatterBlock.match(/- "?\[\[[^\]]+\]\]"?/g) ?? [];
    expect(entries.length).toBe(2);

    expect(result).toContain("# Writeback Fixture");
    expect(result).toContain("## Notes");
  });

  test("creates a new notient.<key> array under existing frontmatter", () => {
    const source = loadFixture();
    const result = applyApprovedRelation(source, {
      key: "builds_on",
      target: "foundation",
    });
    expect(result).not.toBe(source);
    expect(result).toContain("contradicts:");
    expect(result).toContain("builds_on:");
    expect(result).toContain("[[foundation]]");
  });

  test("creates frontmatter from scratch when absent and leaves body unchanged", () => {
    const source = "# Title\n\nOnly body content here.\n";
    const result = applyApprovedRelation(source, {
      key: "relates_to",
      target: "another",
    });
    expect(result.startsWith("---\n")).toBe(true);
    expect(result).toContain("notient:");
    expect(result).toContain("relates_to:");
    expect(result).toContain("[[another]]");
    expect(result.endsWith("# Title\n\nOnly body content here.\n")).toBe(true);
  });

  test("is a no-op when the wikilink already exists in the array", () => {
    const source = loadFixture();
    const result = applyApprovedRelation(source, {
      key: "contradicts",
      target: "contradicting-note",
    });
    expect(result).toBe(source);
  });

  test("is a byte-identical no-op when an aliased wikilink targets the same note", () => {
    const source = [
      "---",
      "notient:",
      "  supports:",
      '    - "[[Target|A useful display label]]"',
      "---",
      "# Body",
      "",
    ].join("\n");

    const once = applyApprovedRelation(source, { key: "supports", target: "Target" });
    const twice = applyApprovedRelation(once, { key: "supports", target: "Target" });

    expect(once).toBe(source);
    expect(twice).toBe(source);
    expect(once.match(/\[\[Target(?:\|[^\]]+)?\]\]/g)).toHaveLength(1);
  });

  test("recognizes an aliased qualified link as the same note relation", () => {
    const source = [
      "---",
      "notient:",
      "  supports:",
      '    - "[[Target#Section|A useful display label]]"',
      "---",
      "# Body",
      "",
    ].join("\n");

    expect(applyApprovedRelation(source, { key: "supports", target: "Target" })).toBe(source);
  });

  test("two consecutive applications produce the same output as one", () => {
    const source = loadFixture();
    const once = applyApprovedRelation(source, {
      key: "contradicts",
      target: "stable-note",
    });
    const twice = applyApprovedRelation(once, {
      key: "contradicts",
      target: "stable-note",
    });
    expect(twice).toBe(once);
  });
});

describe("round-trip determinism", () => {
  test("running the same writeback twice on the same input yields identical bytes", () => {
    const source = loadFixture();
    const firstLink = applyApprovedLink(source, { target: "Determinism" });
    const secondLink = applyApprovedLink(source, { target: "Determinism" });
    expect(secondLink).toBe(firstLink);

    const firstRelation = applyApprovedRelation(source, {
      key: "contradicts",
      target: "stable",
    });
    const secondRelation = applyApprovedRelation(source, {
      key: "contradicts",
      target: "stable",
    });
    expect(secondRelation).toBe(firstRelation);
  });

  test("applyApprovedLink inserts one contiguous range and touches nothing else", () => {
    for (const name of ["writeback-input.md", "golden.md", "edge-cases.md", "obsidian-syntax.md"]) {
      const source = load(name);
      const result = applyApprovedLink(source, { target: "FreshTarget" });
      const inserted = expectSingleInsertion(source, result);
      expect(inserted).toContain("[[FreshTarget]]");
    }
  });

  test("applyApprovedRelation leaves the body bytes untouched", () => {
    for (const name of ["writeback-input.md", "golden.md", "edge-cases.md", "obsidian-syntax.md"]) {
      const source = load(name);
      const result = applyApprovedRelation(source, { key: "contradicts", target: "fresh-note" });
      const beforeBody = source.slice(readFrontmatter(source).end);
      const afterBody = result.slice(readFrontmatter(result).end);
      expect(afterBody).toBe(beforeBody);
    }
  });
});

describe("no re-serialization of user syntax", () => {
  const hostile = [
    "# Notes",
    "",
    "- [ ] buy milk",
    "- [x] ship it",
    "",
    "> [!note] Heads up",
    "> Careful.",
    "",
    "Math $a_i$ and arithmetic 5 * 3 and an escaped \\* star.",
    "",
    "## Related",
    "",
    "- [[ExistingOne]]",
    "",
    "## Tail",
    "",
    "Trailing.",
    "",
  ].join("\n");

  test("applyApprovedLink preserves checkboxes, callouts, math and escapes", () => {
    const result = applyApprovedLink(hostile, { target: "New" });
    expect(result).toContain("- [ ] buy milk");
    expect(result).toContain("- [x] ship it");
    expect(result).toContain("> [!note] Heads up");
    expect(result).toContain("$a_i$");
    expect(result).toContain("5 * 3");
    expect(result).toContain("escaped \\* star");
    expect(result).toContain("- [[ExistingOne]]\n- [[New]]\n");
    expect(result).toContain("## Tail\n\nTrailing.\n");
  });

  test("applyApprovedRelation preserves the same body byte-for-byte", () => {
    const withFm = `---\ntitle: Hostile\naliases:\n  - h\n---\n${hostile}`;
    const result = applyApprovedRelation(withFm, { key: "supports", target: "New" });
    expect(result.slice(readFrontmatter(result).end)).toBe(hostile);
    expect(result).toContain("aliases:\n  - h\n");
  });

  test("CRLF documents keep CRLF on the inserted bullet", () => {
    const source = "# Doc\r\n\r\n## Related\r\n\r\n- [[One]]\r\n";
    const result = applyApprovedLink(source, { target: "Two" });
    expect(result).toBe("# Doc\r\n\r\n## Related\r\n\r\n- [[One]]\r\n- [[Two]]\r\n");
  });

  test("a file with no trailing newline keeps having none", () => {
    const source = "## Related\n\n- [[One]]";
    expect(applyApprovedLink(source, { target: "Two" })).toBe("## Related\n\n- [[One]]\n- [[Two]]");
  });

  test("`## related` matches case-insensitively with trailing whitespace", () => {
    const source = "## related   \n\n- [[One]]\n";
    const result = applyApprovedLink(source, { target: "Two" });
    expect(result).toBe("## related   \n\n- [[One]]\n- [[Two]]\n");
  });

  test("a `## Related` heading inside a fenced code block is ignored", () => {
    const source = "# Doc\n\n```\n## Related\n```\n";
    const result = applyApprovedLink(source, { target: "One" });
    expect(result.startsWith(source)).toBe(true);
    expect(result.endsWith("## Related\n\n- [[One]]\n")).toBe(true);
  });

  test("an aliased link already present blocks a duplicate", () => {
    const source = "## Related\n\n- [[Note|Display]]\n";
    expect(applyApprovedLink(source, { target: "Note" })).toBe(source);
  });
});
