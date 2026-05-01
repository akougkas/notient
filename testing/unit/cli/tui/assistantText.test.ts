import { describe, expect, test } from "bun:test";
import { parseAssistantText } from "../../../../src/cli/tui/assistantText";

describe("parseAssistantText", () => {
  test("plain prose stays as a single prose segment", () => {
    expect(parseAssistantText("hello world")).toEqual([{ type: "prose", text: "hello world" }]);
  });

  test("empty input returns no segments", () => {
    expect(parseAssistantText("")).toEqual([]);
  });

  test("a fenced block becomes a code segment", () => {
    expect(parseAssistantText("```\ncode body\n```")).toEqual([
      { type: "code", lang: "", text: "code body" },
    ]);
  });

  test("captures the language tag from the fence", () => {
    expect(parseAssistantText("```ts\nconst x = 1;\n```")).toEqual([
      { type: "code", lang: "ts", text: "const x = 1;" },
    ]);
  });

  test("interleaves prose and code segments", () => {
    const parsed = parseAssistantText("before\n```js\nfn()\n```\nafter");
    expect(parsed).toEqual([
      { type: "prose", text: "before" },
      { type: "code", lang: "js", text: "fn()" },
      { type: "prose", text: "after" },
    ]);
  });

  test("multi-line prose is preserved verbatim", () => {
    expect(parseAssistantText("line one\nline two")).toEqual([
      { type: "prose", text: "line one\nline two" },
    ]);
  });

  test("multi-line code is preserved verbatim", () => {
    const parsed = parseAssistantText("```\na\nb\nc\n```");
    expect(parsed[0]).toEqual({ type: "code", lang: "", text: "a\nb\nc" });
  });

  test("an unterminated fence captures the remaining text as code", () => {
    expect(parseAssistantText("intro\n```\nstart of code")).toEqual([
      { type: "prose", text: "intro" },
      { type: "code", lang: "", text: "start of code" },
    ]);
  });

  test("empty prose segments between two code blocks are dropped", () => {
    const parsed = parseAssistantText("```\na\n```\n```\nb\n```");
    expect(parsed).toEqual([
      { type: "code", lang: "", text: "a" },
      { type: "code", lang: "", text: "b" },
    ]);
  });

  test("an empty fenced block still produces a code segment", () => {
    expect(parseAssistantText("```\n```")).toEqual([{ type: "code", lang: "", text: "" }]);
  });
});
