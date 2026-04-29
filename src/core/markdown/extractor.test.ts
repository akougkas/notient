import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extract } from "./extractor";
import { processAst } from "./pipeline";

const fixturePath = join(import.meta.dir, "__fixtures__", "edge-cases.md");
const fixtureSource = readFileSync(fixturePath, "utf8");
const tree = processAst(fixtureSource);
const extraction = extract(tree, "notes/edge-cases.md");

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
