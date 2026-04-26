import { describe, expect, test } from "bun:test";
import { findChunkParagraphs, splitParagraphs } from "./paragraphMap";

const doc = [
  "First paragraph about apples.",
  "",
  "Second paragraph about oranges and bananas in detail.",
  "",
  "Third paragraph about pears.",
].join("\n");

describe("paragraphMap", () => {
  test("splits a document into paragraph spans", () => {
    const paragraphs = splitParagraphs(doc);
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0].text).toContain("apples");
    expect(paragraphs[2].text).toContain("pears");
    expect(paragraphs[0].from).toBe(0);
    expect(paragraphs[0].to).toBe("First paragraph about apples.".length);
  });

  test("findChunkParagraphs locates each chunk by 80-char prefix", () => {
    const chunks = [
      { id: "c1", text: "First paragraph about apples." },
      { id: "c2", text: "Second paragraph about oranges and bananas in detail." },
      { id: "c3", text: "MISSING - drifted away" },
    ];
    const matches = findChunkParagraphs(doc, chunks);
    expect(matches.get("c1")).toBeDefined();
    expect(matches.get("c2")).toBeDefined();
    expect(matches.get("c3")).toBeUndefined();
    const paragraph = matches.get("c1");
    if (!paragraph) throw new Error("expected paragraph match for c1");
    expect(paragraph.text).toContain("apples");
  });

  test("matches chunk regardless of trailing whitespace differences", () => {
    const chunks = [{ id: "c1", text: "First paragraph about apples.\n\n  " }];
    const matches = findChunkParagraphs(doc, chunks);
    expect(matches.get("c1")).toBeDefined();
  });

  test("returns no match when prefix is shorter than 12 chars (avoids spurious hits)", () => {
    const chunks = [{ id: "c1", text: "tiny" }];
    const matches = findChunkParagraphs("paragraph one\n\nparagraph two", chunks);
    expect(matches.get("c1")).toBeUndefined();
  });
});
