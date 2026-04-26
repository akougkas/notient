import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { ToolCallCard } from "./ToolCallCard";

describe("ToolCallCard", () => {
  test("renders pending state when result is missing", () => {
    const html = render(
      <ToolCallCard call={{ id: "tc-1", name: "notes.read", args: { path: "x.md" } }} />,
    );
    expect(html).toContain("notient-chat-tool--pending");
    expect(html).toContain("notes.read");
    expect(html).toContain("...");
  });

  test("renders ok status with duration", () => {
    const html = render(
      <ToolCallCard
        call={{ id: "tc-1", name: "notes.read", args: { path: "x.md" } }}
        result={{ callId: "tc-1", status: "ok", data: { lines: 3 }, durationMs: 7 }}
      />,
    );
    expect(html).toContain("notient-chat-tool--ok");
    expect(html).toContain("7ms");
  });

  test("renders error status", () => {
    const html = render(
      <ToolCallCard
        call={{ id: "tc-1", name: "notes.read", args: {} }}
        result={{ callId: "tc-1", status: "error", error: "missing path", durationMs: 1 }}
      />,
    );
    expect(html).toContain("notient-chat-tool--error");
  });
});
