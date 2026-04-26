import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { ReasoningBlock } from "./ReasoningBlock";

describe("ReasoningBlock", () => {
  test("returns nothing when reasoning is empty and not streaming", () => {
    const html = render(<ReasoningBlock reasoning="" />);
    expect(html).toBe("");
  });

  test("renders Thinking placeholder while streaming with no content yet", () => {
    const html = render(<ReasoningBlock reasoning="" streaming />);
    expect(html).toContain("notient-chat-reasoning");
    expect(html).toContain("Thinking...");
  });

  test("renders Show reasoning summary when content is present", () => {
    const html = render(<ReasoningBlock reasoning="step one" />);
    expect(html).toContain("Show reasoning");
    expect(html).toContain("step one");
  });

  test("respects defaultOpen prop", () => {
    const open = render(<ReasoningBlock reasoning="step one" defaultOpen />);
    expect(open).toContain("open");
  });
});
