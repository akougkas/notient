import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extract } from "../../../../src/core/markdown/extractor";
import { processAst } from "../../../../src/core/markdown/pipeline";

const fixturePath = join(import.meta.dir, "../../../fixtures/markdown", "edge-cases.md");
const fixtureSource = readFileSync(fixturePath, "utf8");
const tree = processAst(fixtureSource);
const extraction = extract(tree, "notes/edge-cases.md", fixtureSource);

describe("markdown extractor", () => {
  test("indexes Markdown destinations in headings, paragraphs, reference links and embeds", () => {
    const source =
      '# [Plan](../Design%20Notes.md#Trade%20offs)\n\n[block][B] and ![excerpt](./Reference.md#^key).\n\n[B]: /Archive/Decision.md#^choice "Decision"\n\n[external](https://example.com/note.md) [mail](mailto:a@b.com) [bad](%ZZ) `[[code]]`\n';
    const result = extractFromSource(source);
    expect(result.links).toEqual([
      {
        syntax: "markdown",
        fromBlockOrd: 0,
        rawTarget: "../Design Notes.md",
        targetHeading: "Trade offs",
        targetBlockId: null,
        isEmbed: false,
      },
      {
        syntax: "markdown",
        fromBlockOrd: 0,
        rawTarget: "/Archive/Decision.md",
        targetHeading: null,
        targetBlockId: "choice",
        isEmbed: false,
      },
      {
        syntax: "markdown",
        fromBlockOrd: 0,
        rawTarget: "./Reference.md",
        targetHeading: null,
        targetBlockId: "key",
        isEmbed: true,
      },
    ]);
    expect(result.bodySha).toBe(extract(processAst(source), "other.md", source).bodySha);
  });

  test("wiki links in headings participate in the same structural graph", () => {
    const result = extractFromSource("# See [[Destination]]\n\nBody.");
    expect(result.links).toEqual([
      {
        syntax: "wiki",
        fromBlockOrd: 0,
        rawTarget: "Destination",
        targetHeading: null,
        targetBlockId: null,
        isEmbed: false,
      },
    ]);
  });
  test("preserves each Markdown heading level exactly", () => {
    const headingBlocks = extraction.blocks.filter((b) => b.headingLevel !== null);
    for (const block of headingBlocks) {
      expect(block.headingLevel).toBeGreaterThanOrEqual(1);
      expect(block.headingLevel).toBeLessThanOrEqual(6);
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
    expect(
      headingBlocks.find((b) => b.headingLevel === 4 && b.headingPath.includes("H4 Heading")),
    ).toBeDefined();
    expect(
      headingBlocks.find((b) => b.headingLevel === 5 && b.headingPath.includes("H5 Heading")),
    ).toBeDefined();
  });

  test("H4 and H5 are their own blocks with honest ancestry", () => {
    const h4 = extraction.blocks.find((b) => b.headingPath.includes("H4 Heading"));
    const h5 = extraction.blocks.find((b) => b.headingPath.includes("H5 Heading"));
    expect(h4?.headingLevel).toBe(4);
    expect(h5?.headingLevel).toBe(5);
    // The H3 block no longer swallows deeper headings.
    const h3 = extraction.blocks.find(
      (b) => b.headingLevel === 3 && b.headingPath.includes("H3 Heading"),
    );
    expect(h3?.headingPath).not.toContain("H4 Heading");
    // Ancestry still threads through headingPath.
    expect(h4?.headingPath).toEqual(["H1 Heading", "H2 Heading", "H3 Heading", "H4 Heading"]);
    expect(h5?.headingPath).toEqual([
      "H1 Heading",
      "H2 Heading",
      "H3 Heading",
      "H4 Heading",
      "H5 Heading",
    ]);
  });

  test("paragraphs with ^block-id produce standalone blocks", () => {
    const standalone = extraction.blocks.filter((b) => b.blockId !== null);
    const ids = standalone.map((b) => b.blockId);
    expect(ids).toContain("para-1");
    expect(ids).toContain("list-id");
    expect(ids).toContain("h3-trailing");
  });

  test("wikilinks carry targetHeading and targetBlockId correctly", () => {
    const headingLink = extraction.links.find((w) => w.targetHeading === "Heading Two");
    expect(headingLink?.rawTarget).toBe("note");

    const blockLink = extraction.links.find((w) => w.targetBlockId === "block-x");
    expect(blockLink?.rawTarget).toBe("note");

    const embed = extraction.links.find((w) => w.isEmbed);
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
    const allRaw = extraction.links.map((w) => w.rawTarget);
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

  test("uses canonical wikilink parsing for aliases and qualifiers", () => {
    const source = [
      "---",
      "notient:",
      "  related:",
      '    - "[[target#Section|Display label]]"',
      '    - "[[block-target#^anchor|Block label]]"',
      "---",
      "",
      "body.",
    ].join("\n");
    const result = extractFromSource(source);
    expect(result.frontmatterRefs.map((ref) => ref.rawTarget)).toEqual(["target", "block-target"]);
  });
});

describe("Obsidian syntax fidelity", () => {
  const source = readFileSync(
    join(import.meta.dir, "../../../fixtures/markdown", "obsidian-syntax.md"),
    "utf8",
  );
  const result = extract(processAst(source), "notes/obsidian-syntax.md", source);

  test("callout markers remain semantic indexed text", () => {
    const note = result.blocks.find((block) => block.text.startsWith("[!note]"));
    const warning = result.blocks.find((block) => block.text.startsWith("[!warning]"));
    expect(note?.text).toBe("[!note] Plain note\nBody of the note callout.");
    expect(warning?.text).toContain("[!warning]- Collapsed warning");
    expect(warning?.text).toContain("Careful with");
  });

  test("a plain blockquote is not a callout", () => {
    const joined = result.blocks.map((b) => b.text).join("\n");
    expect(joined).toContain("Not a callout, just a quotation.");
    expect(
      result.blocks.some(
        (block) => block.text.startsWith("[!") && block.text.includes("just a quotation"),
      ),
    ).toBe(false);
  });

  test("task list items keep their checkbox state in block text", () => {
    const joined = result.blocks.map((b) => b.text).join("\n");
    expect(joined).toContain("- [ ] buy milk");
    expect(joined).toContain("- [x] ship the writeback");
    expect(joined).not.toContain("- buy milk");
  });

  test("H4/H5/H6 persist their native levels", () => {
    const levels = result.blocks
      .filter((block) => (block.headingLevel ?? 0) > 3)
      .map((block) => block.headingLevel);
    expect(levels).toEqual([4, 5, 6]);
  });

  test("extraction exposes only fields consumed by the indexing substrate", () => {
    expect(Object.keys(result).sort()).toEqual([
      "blocks",
      "bodySha",
      "frontmatterRefs",
      "links",
      "tags",
      "wordCount",
    ]);
    expect(Object.keys(result.blocks[0]).sort()).toEqual([
      "blockId",
      "endLine",
      "headingLevel",
      "headingPath",
      "headingSlug",
      "ord",
      "startLine",
      "text",
    ]);
  });
});
