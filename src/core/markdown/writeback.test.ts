import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { processAst, stringify } from "./pipeline";
import { applyApprovedLink, applyApprovedRelation } from "./writeback";

const fixturePath = join(import.meta.dir, "__fixtures__", "writeback-input.md");

function loadFixture(): string {
  return readFileSync(fixturePath, "utf8");
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

  test("applyApprovedLink output is fixpoint-stable through the pipeline", () => {
    const source = loadFixture();
    const result = applyApprovedLink(source, { target: "FreshTarget" });
    const restringified = stringify(processAst(result));
    expect(restringified).toBe(result);
  });

  test("applyApprovedRelation output is fixpoint-stable through the pipeline", () => {
    const source = loadFixture();
    const result = applyApprovedRelation(source, {
      key: "contradicts",
      target: "another-note",
    });
    const restringified = stringify(processAst(result));
    expect(restringified).toBe(result);
  });
});
