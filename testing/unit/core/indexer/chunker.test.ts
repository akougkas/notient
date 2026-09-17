import { describe, expect, test } from "bun:test";
import { chunkBlocks, tokenEstimate } from "../../../../src/core/indexer/chunker";
import { CHUNK } from "../../../../src/core/indexer/concurrencyDefaults";
import type { BlockSpec } from "../../../../src/core/markdown/types";

function makeHeadingBlock(
  ord: number,
  level: 1 | 2 | 3 | 4 | 5 | 6,
  headingPath: string[],
  startLine: number,
  endLine: number,
  text: string,
): BlockSpec {
  return {
    blockId: null,
    headingLevel: level,
    headingPath,
    headingSlug: headingPath[headingPath.length - 1]?.toLowerCase().replace(/\s+/g, "-") ?? null,
    ord,
    startLine,
    endLine,
    text,
  };
}

function makeStandaloneBlock(
  ord: number,
  blockId: string,
  headingPath: string[],
  startLine: number,
  endLine: number,
  text: string,
): BlockSpec {
  return {
    blockId,
    headingLevel: null,
    headingPath,
    headingSlug: null,
    ord,
    startLine,
    endLine,
    text,
  };
}

describe("chunkBlocks", () => {
  test("returns [] for empty input", () => {
    expect(chunkBlocks([])).toEqual([]);
  });

  test("short heading section emits one chunk", () => {
    const blocks: BlockSpec[] = [
      makeHeadingBlock(0, 1, ["Intro"], 1, 1, "A short paragraph under the heading."),
    ];
    const specs = chunkBlocks(blocks);
    expect(specs).toHaveLength(1);
    expect(specs[0].ord).toBe(0);
    expect(specs[0].blockOrd).toBe(0);
    expect(specs[0].text).toBe("A short paragraph under the heading.");
    expect(specs[0].startLine).toBe(1);
    expect(specs[0].tokenEstimate).toBe(tokenEstimate("A short paragraph under the heading."));
  });

  test("long section splits into sentence-bounded sub-chunks sharing blockOrd", () => {
    const sentence = "Lorem ipsum dolor sit amet consectetur adipiscing elit. ";
    // Build text > targetTokens (~400). 600 tokens -> 2400 chars. Use 50 sentences (~57 chars each = 2850 chars).
    const longBody = sentence.repeat(50).trim();
    expect(tokenEstimate(longBody)).toBeGreaterThan(CHUNK.targetTokens);
    const blocks: BlockSpec[] = [makeHeadingBlock(0, 2, ["Body"], 5, 200, longBody)];
    const specs = chunkBlocks(blocks);
    expect(specs.length).toBeGreaterThan(1);
    for (const spec of specs) {
      expect(spec.blockOrd).toBe(0);
      expect(spec.tokenEstimate).toBeLessThanOrEqual(CHUNK.maxTokens);
      expect(spec.startLine).toBe(5);
      expect(spec.endLine).toBe(200);
    }
    for (let index = 0; index < specs.length; index++) {
      expect(specs[index].ord).toBe(index);
    }
  });

  test("pre-heading content yields blockOrd null", () => {
    const blocks: BlockSpec[] = [
      makeStandaloneBlock(0, "abc123", [], 1, 1, "Pre-heading paragraph."),
      makeHeadingBlock(1, 1, ["Section"], 3, 3, "Body under heading."),
    ];
    const specs = chunkBlocks(blocks);
    expect(specs).toHaveLength(2);
    expect(specs[0].blockOrd).toBeNull();
    expect(specs[0].text).toBe("Pre-heading paragraph.");
    expect(specs[1].blockOrd).toBe(1);
    expect(specs[1].text).toBe("Body under heading.");
  });

  test("hard-splits a single oversized sentence under a heading", () => {
    const oversized = "word".concat(" word".repeat(700));
    expect(tokenEstimate(oversized)).toBeGreaterThan(CHUNK.maxTokens);
    const blocks: BlockSpec[] = [makeHeadingBlock(0, 2, ["Wall"], 10, 12, oversized)];
    const specs = chunkBlocks(blocks);
    expect(specs.length).toBeGreaterThan(1);
    for (const spec of specs) {
      expect(spec.blockOrd).toBe(0);
      expect(spec.tokenEstimate).toBeLessThanOrEqual(CHUNK.maxTokens);
      expect(spec.text.trim().length).toBeGreaterThan(0);
    }
  });

  test("multiple sections preserve order with monotonic ord", () => {
    const blocks: BlockSpec[] = [
      makeHeadingBlock(0, 1, ["First"], 1, 1, "First section body."),
      makeHeadingBlock(1, 2, ["First", "Second"], 5, 5, "Second section body."),
      makeHeadingBlock(2, 3, ["First", "Second", "Third"], 9, 9, "Third section body."),
    ];
    const specs = chunkBlocks(blocks);
    expect(specs).toHaveLength(3);
    expect(specs[0].ord).toBe(0);
    expect(specs[0].blockOrd).toBe(0);
    expect(specs[0].text).toBe("First section body.");
    expect(specs[1].ord).toBe(1);
    expect(specs[1].blockOrd).toBe(1);
    expect(specs[1].text).toBe("Second section body.");
    expect(specs[2].ord).toBe(2);
    expect(specs[2].blockOrd).toBe(2);
    expect(specs[2].text).toBe("Third section body.");
  });

  test("an H6 block remains a first-class chunk section", () => {
    const blocks: BlockSpec[] = [
      makeHeadingBlock(0, 6, ["One", "Two", "Three", "Four", "Five", "Six"], 6, 7, "Deep."),
    ];
    const specs = chunkBlocks(blocks);
    expect(specs).toHaveLength(1);
    expect(specs[0].blockOrd).toBe(0);
    expect(specs[0].text).toBe("Deep.");
  });

  test("standalone block under heading attaches to that heading section", () => {
    const blocks: BlockSpec[] = [
      makeHeadingBlock(0, 1, ["Heading"], 1, 1, "Heading-attached body."),
      makeStandaloneBlock(1, "block-id-1", ["Heading"], 3, 3, "Standalone child block."),
    ];
    const specs = chunkBlocks(blocks);
    expect(specs).toHaveLength(1);
    expect(specs[0].blockOrd).toBe(0);
    expect(specs[0].text).toBe("Heading-attached body.\n\nStandalone child block.");
    expect(specs[0].startLine).toBe(1);
    expect(specs[0].endLine).toBe(3);
  });

  test("heading with empty text still establishes a section", () => {
    const blocks: BlockSpec[] = [
      makeHeadingBlock(0, 1, ["Empty"], 1, 1, ""),
      makeStandaloneBlock(
        1,
        "block-id-2",
        ["Empty"],
        3,
        5,
        "Only content lives in the standalone.",
      ),
    ];
    const specs = chunkBlocks(blocks);
    expect(specs).toHaveLength(1);
    expect(specs[0].blockOrd).toBe(0);
    expect(specs[0].text).toBe("Only content lives in the standalone.");
    expect(specs[0].startLine).toBe(1);
    expect(specs[0].endLine).toBe(5);
  });
});

describe("tokenEstimate", () => {
  test("returns ceil(length / 4)", () => {
    expect(tokenEstimate("")).toBe(0);
    expect(tokenEstimate("a")).toBe(1);
    expect(tokenEstimate("abcd")).toBe(1);
    expect(tokenEstimate("abcde")).toBe(2);
    expect(tokenEstimate("x".repeat(400))).toBe(100);
  });
});

describe("stripHtmlTags", () => {
  test("removes inline HTML and MathML but keeps text and autolinks", async () => {
    const { stripHtmlTags } = await import("../../../../src/core/indexer/chunker");
    const input =
      "score <math><semantics><mrow><mi>n</mi><mo>,</mo><mi>m</mi></mrow></semantics></math> see <https://example.com> and <sup>1</sup>";
    const out = stripHtmlTags(input);
    expect(out).not.toContain("<mi>");
    expect(out).not.toContain("<sup>");
    expect(out).toContain("<https://example.com>");
    expect(out).toContain("n , m");
    expect(out).toContain("1");
  });

  test("is the identity for text without angle brackets", async () => {
    const { stripHtmlTags } = await import("../../../../src/core/indexer/chunker");
    expect(stripHtmlTags("plain text\n\nmore")).toBe("plain text\n\nmore");
  });

  test("preserves angle-bracket syntax inside fenced and inline code", async () => {
    const { stripHtmlTags } = await import("../../../../src/core/indexer/chunker");
    const input = `outside <b>bold</b>

\`\`\`cpp
Vec<int> values;
if (left < right) return Map<Key, Value>{};
\`\`\`

Keep \`Vec<float>\` and remove <em>this markup</em>.`;

    const output = stripHtmlTags(input);
    expect(output).toContain(`\`\`\`cpp
Vec<int> values;
if (left < right) return Map<Key, Value>{};
\`\`\``);
    expect(output).toContain("Keep `Vec<float>`");
    expect(output).not.toContain("<b>");
    expect(output).not.toContain("<em>");
  });

  test("preserves code through an unterminated fence", async () => {
    const { stripHtmlTags } = await import("../../../../src/core/indexer/chunker");
    const input = "before <i>text</i>\n~~~rust\nlet value: Vec<int> = read();\n<!-- code -->";

    expect(stripHtmlTags(input)).toEndWith("~~~rust\nlet value: Vec<int> = read();\n<!-- code -->");
  });
});
