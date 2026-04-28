import { describe, expect, test } from "bun:test";
import { type ChatLineKind, chatLineMeta, shouldRenderSpacer } from "./chatLineStyles";

describe("chatLineMeta", () => {
  test("user uses cyan label", () => {
    const meta = chatLineMeta("user");
    expect(meta.label).toBe("you");
    expect(meta.labelColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  test("assistant uses a distinct color from user", () => {
    expect(chatLineMeta("assistant").labelColor).not.toBe(chatLineMeta("user").labelColor);
  });

  test("approval and tool share the amber family but differ from error", () => {
    expect(chatLineMeta("approval").labelColor).toBe(chatLineMeta("tool").labelColor);
    expect(chatLineMeta("error").labelColor).not.toBe(chatLineMeta("tool").labelColor);
  });

  test("every kind has a label", () => {
    const kinds: ChatLineKind[] = ["user", "assistant", "tool", "error", "system", "approval"];
    for (const kind of kinds) {
      expect(chatLineMeta(kind).label.length).toBeGreaterThan(0);
    }
  });
});

describe("shouldRenderSpacer", () => {
  test("never inserts a spacer at index 0", () => {
    expect(shouldRenderSpacer(["user"], 0)).toBe(false);
  });

  test("inserts a spacer before an assistant turn that follows a user turn", () => {
    expect(shouldRenderSpacer(["user", "assistant"], 1)).toBe(true);
  });

  test("inserts a spacer between an assistant turn and a user turn", () => {
    expect(shouldRenderSpacer(["assistant", "user"], 1)).toBe(true);
  });

  test("does not insert a spacer between two assistant lines", () => {
    expect(shouldRenderSpacer(["assistant", "assistant"], 1)).toBe(false);
  });

  test("does not insert a spacer between two non-assistant lines of different kinds", () => {
    expect(shouldRenderSpacer(["system", "tool"], 1)).toBe(false);
  });
});
