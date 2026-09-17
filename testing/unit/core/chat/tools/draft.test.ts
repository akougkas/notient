import { expect, test } from "bun:test";
import { conversationLines, lastPreparedDraft } from "../../../../../src/cli/tui/conversations";
import {
  parseConversation,
  serializeConversation,
} from "../../../../../src/core/chat/conversationParser";
import { makePrepareDraftTool, preparedDrafts } from "../../../../../src/core/chat/tools/draft";
import { ToolRegistry } from "../../../../../src/core/chat/tools/registry";
import { conversationFixture } from "../../../../conversationFixture";

test("prepared Markdown is a validated, unsaved artifact and survives the owned Markdown transcript", async () => {
  const registry = new ToolRegistry();
  registry.register(makePrepareDraftTool());
  const draft = {
    title: "A thought",
    markdown: "# A thought\n\nMy uncertainty stays explicit. See [[Source.md]].\n",
  };
  const result = await registry.invoke("notes.prepare_draft", draft, new AbortController().signal, {
    clientIdentity: "human",
  });
  expect(result).toEqual(draft);
  expect(registry.isWriteGated("notes.prepare_draft")).toBe(false);
  const conversation = conversationFixture();
  conversation.messages[1] = {
    id: "draft",
    role: "assistant",
    content: "Here is why I organized it this way.",
    reasoningContent: "PRIVATE",
    createdAt: 1001,
    toolCalls: [{ id: "draft-call", name: "notes.prepare_draft", args: draft }],
    toolResults: [{ callId: "draft-call", status: "ok", data: result, durationMs: 0 }],
  };
  const restored = parseConversation(serializeConversation(conversation), conversation.notePath);
  expect(preparedDrafts(restored.messages)).toEqual([draft]);
  const lines = conversationLines(restored);
  expect(lastPreparedDraft(lines)).toEqual(draft);
  expect(lastPreparedDraft([...lines, { kind: "user", text: "A separate question" }])).toBeNull();
  expect(JSON.stringify(lines)).not.toContain("PRIVATE");
  conversation.messages[1].toolResults = [
    { callId: "wrong-id", status: "ok", data: result, durationMs: 0 },
  ];
  expect(preparedDrafts(conversation.messages)).toEqual([]);
  conversation.messages[1].toolResults = [
    { callId: "draft-call", status: "error", error: "cancelled", durationMs: 0 },
  ];
  expect(preparedDrafts(conversation.messages)).toEqual([]);
  await expect(
    registry.invoke(
      "notes.prepare_draft",
      { ...draft, apply: true },
      new AbortController().signal,
      { clientIdentity: "human" },
    ),
  ).rejects.toThrow("validation failed");
  await expect(
    registry.invoke("notes.prepare_draft", draft, AbortSignal.abort(), { clientIdentity: "human" }),
  ).rejects.toThrow();
});
