import { describe, expect, test } from "bun:test";
import type { BlockSpec } from "../../../../src/core/markdown/types";
import { chunkBlocks, chunkNote, tokenEstimate } from "../../../../src/core/indexer/chunker";
import { CHUNK } from "../../../../src/core/indexer/concurrencyDefaults";

describe("chunkNote", () => {
  test("returns single chunk for short note", async () => {
    const chunks = await chunkNote("/n.md", "Hello world.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].notePath).toBe("/n.md");
    expect(chunks[0].ord).toBe(0);
    expect(chunks[0].text).toBe("Hello world.");
    expect(chunks[0].id).toMatch(/^[0-9a-f]{16}$/);
    expect(chunks[0].sha).toMatch(/^[0-9a-f]{64}$/);
    expect(chunks[0].tokenEstimate).toBeGreaterThan(0);
  });

  test("returns empty array for empty body", async () => {
    expect(await chunkNote("/n.md", "")).toEqual([]);
    expect(await chunkNote("/n.md", "   \n  \n")).toEqual([]);
  });

  test("merges short paragraphs while under target tokens", async () => {
    const body = "Para one.\n\nPara two.\n\nPara three.";
    const chunks = await chunkNote("/n.md", body, { targetTokens: 1000, maxTokens: 2000 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("Para one.\n\nPara two.\n\nPara three.");
  });

  test("splits when next paragraph would exceed target tokens", async () => {
    const big = "x ".repeat(800); // ~400 tokens
    const body = `${big.trim()}\n\n${big.trim()}\n\n${big.trim()}`;
    const chunks = await chunkNote("/n.md", body, { targetTokens: 400, maxTokens: 800 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.tokenEstimate).toBeLessThanOrEqual(800);
  });

  test("ord is monotonically increasing from 0", async () => {
    const body = Array.from({ length: 5 }, (_, i) => `${"y ".repeat(900).trim()} P${i}`).join(
      "\n\n",
    );
    const chunks = await chunkNote("/n.md", body, { targetTokens: 400, maxTokens: 800 });
    for (let i = 0; i < chunks.length; i++) expect(chunks[i].ord).toBe(i);
  });

  test("ids are stable across runs and unique within a note", async () => {
    const body = "First.\n\nSecond.\n\nThird.";
    const a = await chunkNote("/n.md", body, { targetTokens: 5, maxTokens: 10 });
    const b = await chunkNote("/n.md", body, { targetTokens: 5, maxTokens: 10 });
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(new Set(a.map((c) => c.id)).size).toBe(a.length);
  });

  test("hard-splits an oversize paragraph at sentence boundaries", async () => {
    const sentence = "This is one sentence with several words. ";
    const body = sentence.repeat(200); // ~10000 chars, far over maxTokens
    const chunks = await chunkNote("/n.md", body, { targetTokens: 200, maxTokens: 400 });
    for (const c of chunks) {
      expect(c.tokenEstimate).toBeLessThanOrEqual(400);
      expect(c.text.trim().length).toBeGreaterThan(0);
    }
  });
});

function makeHeadingBlock(
  ord: number,
  level: 1 | 2 | 3,
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
