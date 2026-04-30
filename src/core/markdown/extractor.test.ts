import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extract } from "./extractor";
import { processAst } from "./pipeline";

const fixturePath = join(import.meta.dir, "__fixtures__", "edge-cases.md");
const fixtureSource = readFileSync(fixturePath, "utf8");
const tree = processAst(fixtureSource);
const extraction = extract(tree, "notes/edge-cases.md", fixtureSource);

describe("markdown extractor", () => {
  test("only H1/H2/H3 produce heading blocks", () => {
    const headingBlocks = extraction.blocks.filter((b) => b.headingLevel !== null);
    for (const block of headingBlocks) {
      expect(block.headingLevel).toBeGreaterThanOrEqual(1);
      expect(block.headingLevel).toBeLessThanOrEqual(3);
    }
    expect(
      headingBlocks.find((b) => b.headingLevel === 1 && b.headingPath.includes("H1 Heading")),
    ).toBeDefined();
    expect(
      headingBlocks.find((b) => b.headingLevel === 2 && b.headingPath.includes("H2 Heading")),
    ).toBeDefined();
    expect(
      headingBlocks.find((b) => b.headingLevel === 3 && b.headingPath.includes("H3 Heading")),
    ).toBeDefined();
    const h4Path = headingBlocks.find((b) => b.headingPath.includes("H4 (rolls into H3)"));
    expect(h4Path?.headingLevel).toBe(3);
  });

  test("H4-H6 text rolls into the nearest H3 block via headingPath", () => {
    const h3 = extraction.blocks.find(
      (b) => b.headingLevel === 3 && b.headingPath.includes("H3 Heading"),
    );
    expect(h3).toBeDefined();
    expect(h3?.headingPath).toContain("H4 (rolls into H3)");
    expect(h3?.headingPath).toContain("H5 (also rolls in)");
  });

  test("paragraphs with ^block-id produce standalone blocks", () => {
    const standalone = extraction.blocks.filter((b) => b.blockId !== null);
    const ids = standalone.map((b) => b.blockId);
    expect(ids).toContain("para-1");
    expect(ids).toContain("list-id");
    expect(ids).toContain("h3-trailing");
  });

  test("wikilinks carry targetHeading and targetBlockId correctly", () => {
    const headingLink = extraction.wikilinks.find((w) => w.targetHeading === "Heading Two");
    expect(headingLink?.rawTarget).toBe("note");

    const blockLink = extraction.wikilinks.find((w) => w.targetBlockId === "block-x");
    expect(blockLink?.rawTarget).toBe("note");

    const embed = extraction.wikilinks.find((w) => w.isEmbed);
    expect(embed?.rawTarget).toBe("asset.png");
  });

  test("frontmatter refs include nested keys", () => {
    const keys = extraction.frontmatterRefs.map((ref) => ref.key);
    expect(keys).toContain("related");
    expect(keys).toContain("also");
    expect(keys).toContain("notient.contradicts");
    expect(keys).toContain("notient.notes.primary");

    const contradicts = extraction.frontmatterRefs.filter(
      (ref) => ref.key === "notient.contradicts",
    );
    expect(contradicts).toHaveLength(2);
    const targets = contradicts.map((ref) => ref.rawTarget).sort();
    expect(targets).toEqual(["disputed", "disputed-too"]);
  });

  test("bodySha is a hex sha-256 and wordCount is positive", () => {
    expect(extraction.bodySha).toMatch(/^[a-f0-9]{64}$/);
    expect(extraction.wordCount).toBeGreaterThan(0);
  });

  test("tags are lowercased and include nested paths", () => {
    const tagPaths = extraction.tags.map((tag) => tag.path);
    expect(tagPaths).toContain("orphan-tag");
    expect(tagPaths).toContain("under-h1");
  });

  test("inline-code and fenced-code wikilinks/tags are excluded", () => {
    const allRaw = extraction.wikilinks.map((w) => w.rawTarget);
    expect(allRaw).not.toContain("skipped");
    expect(extraction.tags.map((tag) => tag.path)).not.toContain("skipped");
  });
});

function extractFromSource(source: string) {
  const tree = processAst(source);
  return extract(tree, "notes/inline.md", source);
}

describe("frontmatter tags", () => {
  test("array form yields one TagSpec per entry, all note-rooted", () => {
    const source = "---\ntags: [homelab, architecture]\n---\n\nbody.\n";
    const result = extractFromSource(source);
    const paths = result.tags.map((tag) => tag.path);
    expect(paths).toContain("homelab");
    expect(paths).toContain("architecture");
    const fromForFrontmatter = result.tags
      .filter((tag) => tag.path === "homelab" || tag.path === "architecture")
      .map((tag) => tag.fromBlockOrd);
    for (const from of fromForFrontmatter) {
      expect(from).toBeNull();
    }
  });

  test("string form yields a single TagSpec", () => {
    const source = "---\ntags: homelab\n---\n\nbody.\n";
    const result = extractFromSource(source);
    expect(result.tags).toHaveLength(1);
    expect(result.tags[0]).toEqual({ fromBlockOrd: null, path: "homelab" });
  });

  test("singular `tag:` array form is honored", () => {
    const source = "---\ntag: [foo, bar]\n---\n\nbody.\n";
    const result = extractFromSource(source);
    const paths = result.tags.map((tag) => tag.path).sort();
    expect(paths).toEqual(["bar", "foo"]);
    for (const tag of result.tags) {
      expect(tag.fromBlockOrd).toBeNull();
    }
  });

  test("mixed-case values are lowercased", () => {
    const source = "---\ntags: [Homelab, ARCHITECTURE]\n---\n\nbody.\n";
    const result = extractFromSource(source);
    const paths = result.tags.map((tag) => tag.path).sort();
    expect(paths).toEqual(["architecture", "homelab"]);
  });

  test("malformed values drop silently, valid ones survive", () => {
    const source =
      '---\ntags: ["-leading-dash", "/leading-slash", "space in tag", "valid"]\n---\n\nbody.\n';
    const result = extractFromSource(source);
    const paths = result.tags.map((tag) => tag.path);
    expect(paths).toEqual(["valid"]);
  });

  test("nested tag paths are preserved", () => {
    const source = '---\ntags: ["homelab/cluster"]\n---\n\nbody.\n';
    const result = extractFromSource(source);
    expect(result.tags).toHaveLength(1);
    expect(result.tags[0]).toEqual({ fromBlockOrd: null, path: "homelab/cluster" });
  });

  test("frontmatter tags coexist with inline body tags", () => {
    const source = "---\ntags: [a]\n---\n\n# Section\n\nbody with #b inline.\n";
    const result = extractFromSource(source);
    const frontmatterTag = result.tags.find((tag) => tag.path === "a" && tag.fromBlockOrd === null);
    const inlineTag = result.tags.find((tag) => tag.path === "b" && tag.fromBlockOrd !== null);
    expect(frontmatterTag).toBeDefined();
    expect(inlineTag).toBeDefined();
    // Frontmatter tags emit before inline tags walk the body.
    const aIndex = result.tags.findIndex((tag) => tag.path === "a");
    const bIndex = result.tags.findIndex((tag) => tag.path === "b");
    expect(aIndex).toBeLessThan(bIndex);
  });
});

describe("heading-less notes", () => {
  test("note without any heading produces a single preamble block carrying all text", () => {
    const source = "This is a reference letter.\n\nIt has multiple paragraphs but no headings.\n";
    const result = extractFromSource(source);
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0].headingLevel).toBeNull();
    expect(result.blocks[0].text).toContain("reference letter");
    expect(result.blocks[0].text).toContain("no headings");
    expect(result.wordCount).toBeGreaterThan(0);
  });
});

describe("frontmatter wikilink enumeration", () => {
  test("recursive walker captures every wikilink under nested notient.* keys", () => {
    const source = [
      "---",
      "notient:",
      "  related:",
      '    - "[[a]]"',
      "  supports:",
      '    - "[[b]]"',
      "  contradicts:",
      '    - "[[c]]"',
      "  extends:",
      '    - "[[d]]"',
      "  exemplifies:",
      '    - "[[e]]"',
      "  synthesizes:",
      '    - "[[f]]"',
      '  author: "Anthony"',
      "---",
      "",
      "body.",
      "",
    ].join("\n");
    const result = extractFromSource(source);
    expect(result.frontmatterRefs).toHaveLength(6);
    const pairs = result.frontmatterRefs.map((ref) => `${ref.key}::${ref.rawTarget}`).sort();
    expect(pairs).toEqual(
      [
        "notient.contradicts::c",
        "notient.exemplifies::e",
        "notient.extends::d",
        "notient.related::a",
        "notient.supports::b",
        "notient.synthesizes::f",
      ].sort(),
    );
    const authorRef = result.frontmatterRefs.find((ref) => ref.key === "notient.author");
    expect(authorRef).toBeUndefined();
  });
});
