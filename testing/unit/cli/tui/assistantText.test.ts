import { expect, test } from "bun:test";
import { visibleAssistantText } from "../../../../src/cli/tui/assistantText";

test("Markdown reaches the native renderer intact, including incomplete streamed fences", () => {
  for (const text of [
    "## Heading\n\n**bold** and `code`",
    "```ts\nconst x = 1;\n```",
    "```ts\nconst",
    "| A | B |\n| --- | --- |\n| x | y |",
    "",
  ])
    expect(visibleAssistantText(text)).toBe(text);
});

test("legacy reasoning stays separate from rendered answers, including an incomplete stream", () => {
  expect(visibleAssistantText("<think>private steps</think>\n**Answer**")).toBe("**Answer**");
  expect(visibleAssistantText("intro\n<think>still thinking")).toBe("intro");
  expect(visibleAssistantText("before <think>hidden</think> after")).toBe("before  after");
  expect(visibleAssistantText("<think>a</think>mid<think>b</think>end")).toBe("midend");
});
