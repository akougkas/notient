import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { conversationsList, resetChatState } from "../chat-state";
import { ConversationsDrawer } from "./ConversationsDrawer";

describe("ConversationsDrawer", () => {
  test("renders empty state when no conversations exist", () => {
    resetChatState();
    const html = render(<ConversationsDrawer />);
    expect(html).toContain("notient-chat-drawer");
    expect(html).toContain("No prior conversations.");
  });

  test("groups conversations by relative date with newest first", () => {
    resetChatState();
    const today = startOfDay(Date.now());
    const earlier = today - 5 * 24 * 60 * 60 * 1000;
    conversationsList.value = [
      {
        id: "c-1",
        notePath: "Notient/conversations/c-1.md",
        topic: "Today topic",
        updatedAt: today + 60_000,
      },
      {
        id: "c-2",
        notePath: "Notient/conversations/c-2.md",
        topic: "Older topic",
        updatedAt: earlier,
      },
    ];
    const html = render(<ConversationsDrawer />);
    expect(html).toContain("Today");
    expect(html).toContain("Today topic");
    expect(html).toContain("Older topic");
    const todayBeforeOlder = html.indexOf("Today topic") < html.indexOf("Older topic");
    expect(todayBeforeOlder).toBe(true);
  });
});

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
