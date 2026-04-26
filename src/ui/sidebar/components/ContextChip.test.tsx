import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { pinnedContext, resetChatState } from "../chat-state";
import { ContextChip } from "./ContextChip";

describe("ContextChip", () => {
  test("renders empty hint when no notes are pinned", () => {
    resetChatState();
    const html = render(<ContextChip />);
    expect(html).toContain("notient-chat-context--empty");
    expect(html).toContain("Pin a note for context.");
  });

  test("renders one chip per pinned note path", () => {
    resetChatState();
    pinnedContext.value = ["notes/a.md", "notes/b.md"];
    const html = render(<ContextChip />);
    expect(html).toContain("notes/a.md");
    expect(html).toContain("notes/b.md");
    const chipCount = (html.match(/notient-chat-context__chip/g) ?? []).length;
    expect(chipCount).toBe(2);
  });
});
