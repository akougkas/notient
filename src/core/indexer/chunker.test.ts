import { describe, expect, test } from "bun:test";
import { chunkNote } from "./chunker";

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
