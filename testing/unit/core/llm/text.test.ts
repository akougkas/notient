import { describe, expect, test } from "bun:test";
import {
  extractFirstJsonObject,
  stripJsonFences,
  stripThinkTags,
} from "../../../../src/core/llm/text";

describe("stripThinkTags", () => {
  test("removes a balanced think block", () => {
    expect(stripThinkTags("<think>plan the answer</think>\nHello")).toBe("Hello");
  });

  test("removes multiple blocks and keeps the prose between them", () => {
    expect(stripThinkTags("<think>a</think>mid<think>b</think>end")).toBe("midend");
  });

  test("drops everything before an orphan closing tag", () => {
    expect(stripThinkTags("reasoning with no opener</think>The answer.")).toBe("The answer.");
  });

  test("keeps an orphan close after the first 2 KiB", () => {
    const prose = `${"context ".repeat(300)}</think>quoted source material`;
    expect(stripThinkTags(prose)).toBe("quoted source material");
  });

  test("keeps a quoted closing tag in prose", () => {
    const prose = 'The literal tag "</think>" appears in the source.';
    expect(stripThinkTags(prose)).toBe(prose);
  });

  test("drops an unclosed think block that runs to the end", () => {
    expect(stripThinkTags("Partial answer\n<think>still reasoning")).toBe("Partial answer");
  });

  test("leaves ordinary text alone", () => {
    expect(stripThinkTags("plain answer")).toBe("plain answer");
    expect(stripThinkTags("")).toBe("");
  });
});

describe("stripJsonFences", () => {
  test("unwraps a fenced json block", () => {
    expect(stripJsonFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  test("returns unfenced text unchanged", () => {
    expect(stripJsonFences('{"a":1}')).toBe('{"a":1}');
  });
});

describe("extractFirstJsonObject", () => {
  test("pulls the object out of a fenced block", () => {
    expect(extractFirstJsonObject('here you go:\n```json\n{"a":1}\n```\nthanks')).toBe('{"a":1}');
  });

  test("pulls the object out of surrounding prose", () => {
    expect(extractFirstJsonObject('Sure. {"a": {"b": 2}} Done.')).toBe('{"a": {"b": 2}}');
  });

  test("ignores braces inside string values", () => {
    expect(extractFirstJsonObject('{"a":"}"}')).toBe('{"a":"}"}');
  });

  test("returns null when there is no object", () => {
    expect(extractFirstJsonObject("no json here")).toBeNull();
    expect(extractFirstJsonObject('{"unterminated": 1')).toBeNull();
  });
});
