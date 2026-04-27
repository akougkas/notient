import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import type { ChatMessage } from "../../../core/chat/types";
import { MessageBubble } from "./MessageBubble";

function userMessage(content: string): ChatMessage {
  return { id: "u-1", role: "user", content, createdAt: 1 };
}

function assistantMessage(content: string, extras: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "a-1", role: "assistant", content, createdAt: 2, ...extras };
}

describe("MessageBubble", () => {
  test("user messages align right via class", () => {
    const html = render(<MessageBubble message={userMessage("hello")} />);
    expect(html).toContain("notient-chat-message--user");
    expect(html).toContain("hello");
  });

  test("assistant messages align left", () => {
    const html = render(<MessageBubble message={assistantMessage("world")} />);
    expect(html).toContain("notient-chat-message--assistant");
    expect(html).toContain("world");
  });

  test("tool role messages render nothing", () => {
    const html = render(
      <MessageBubble message={{ id: "t-1", role: "tool", content: "x", createdAt: 3 }} />,
    );
    expect(html).toBe("");
  });

  test("renders bullet lists from dash-prefixed lines", () => {
    const html = render(
      <MessageBubble message={assistantMessage("intro\n- alpha\n- beta\noutro")} />,
    );
    expect(html).toContain("notient-chat-message__list");
    expect(html).toContain("alpha");
    expect(html).toContain("beta");
    expect(html).toContain("intro");
    expect(html).toContain("outro");
  });

  test("upgrades [[wikilinks]] into citation links", () => {
    const html = render(<MessageBubble message={assistantMessage("see [[notes/a]]")} />);
    expect(html).toContain("notient-chat-citation");
    expect(html).toContain('data-target="notes/a"');
    expect(html).toContain("[[notes/a]]");
  });

  test("renders tool calls when present", () => {
    const message = assistantMessage("calling tool", {
      toolCalls: [{ id: "tc-1", name: "notes.read", args: { path: "x.md" } }],
      toolResults: [{ callId: "tc-1", status: "ok", data: { ok: true }, durationMs: 5 }],
    });
    const html = render(<MessageBubble message={message} />);
    expect(html).toContain("notient-chat-tool");
    expect(html).toContain("notes.read");
    expect(html).toContain("5ms");
  });

  test("renders reasoning block when reasoningContent is present", () => {
    const message = assistantMessage("answer", { reasoningContent: "thinking out loud" });
    const html = render(<MessageBubble message={message} />);
    expect(html).toContain("notient-chat-reasoning");
  });
});
