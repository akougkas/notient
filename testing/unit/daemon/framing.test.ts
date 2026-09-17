import { describe, expect, test } from "bun:test";
import { MAX_FRAME_BYTES, consumeChunk } from "../../../src/daemon/framing";

describe("consumeChunk", () => {
  test("splits a chunk carrying several whole frames", () => {
    const result = consumeChunk("", '{"a":1}\n{"b":2}\n');
    expect(result.lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(result.buffer).toBe("");
    expect(result.overflow).toBe(false);
  });

  test("carries a partial frame over to the next chunk", () => {
    const first = consumeChunk("", '{"a":1}\n{"b":');
    expect(first.lines).toEqual(['{"a":1}']);
    expect(first.buffer).toBe('{"b":');
    const second = consumeChunk(first.buffer, "2}\n");
    expect(second.lines).toEqual(['{"b":2}']);
    expect(second.buffer).toBe("");
  });

  test("drops blank lines and trims surrounding whitespace", () => {
    const result = consumeChunk("", '\n  {"a":1}  \n\n');
    expect(result.lines).toEqual(['{"a":1}']);
  });

  test("an unterminated frame past the cap overflows and resets the buffer", () => {
    const result = consumeChunk("", "x".repeat(1001), 1000);
    expect(result.overflow).toBe(true);
    expect(result.buffer).toBe("");
    expect(result.lines).toEqual([]);
  });

  test("the cap applies across chunks, not per chunk", () => {
    const half = "x".repeat(600);
    const first = consumeChunk("", half, 1000);
    expect(first.overflow).toBe(false);
    const second = consumeChunk(first.buffer, half, 1000);
    expect(second.overflow).toBe(true);
    expect(second.buffer).toBe("");
  });

  test("a newline-terminated frame past the cap also overflows", () => {
    const result = consumeChunk("", `${"x".repeat(1001)}\n`, 1000);
    expect(result.overflow).toBe(true);
    expect(result.lines).toEqual([]);
  });

  test("the default cap is 4 MiB and applies with no explicit limit", () => {
    expect(MAX_FRAME_BYTES).toBe(4 * 1024 * 1024);
    expect(consumeChunk("", "x".repeat(MAX_FRAME_BYTES + 1)).overflow).toBe(true);
  });
});
