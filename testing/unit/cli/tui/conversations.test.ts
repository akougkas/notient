import { expect, test } from "bun:test";
import type { ClientHandle } from "../../../../src/cli/client";
import {
  conversationLines,
  conversationMatches,
  conversationTitle,
  loadOwnConversation,
  ownConversations,
} from "../../../../src/cli/tui/conversations";
import { resolveKey } from "../../../../src/cli/tui/keymap";
import { createRpc } from "../../../../src/cli/tui/rpc";
import { initialState, reducer } from "../../../../src/cli/tui/store";
import { conversationFixture } from "../../../conversationFixture";

test("restoring a transcript preserves visible context and citations without replayable approvals", () => {
  const conversation = conversationFixture();
  conversation.messages[1] = {
    id: "answer-1",
    role: "assistant",
    createdAt: 1001,
    content: "Use a durable journal. See [[Storage#Recovery]].",
    reasoningContent: "PRIVATE REASONING",
    toolCalls: [{ id: "old-call", name: "notes.append", args: { text: "do not replay" } }],
    approvals: [{ callId: "old-call", approved: true, decidedAt: 1000 }],
  };
  let state = reducer(initialState("/vault"), { type: "ask/buffer", buffer: "old draft" });
  state = reducer(state, { type: "ask/approvalPending", callId: "old-call", tool: "notes.append" });
  state = reducer(state, { type: "ask/restore", conversation });
  expect(state.ask.conversationId).toBe(conversation.id);
  expect(state.ask.notePath).toBe(conversation.notePath);
  expect(state.ask.citations).toEqual(["[[Storage#Recovery]]"]);
  expect(state.ask.pendingApprovals.size).toBe(0);
  expect(state.ask.buffer).toBe("");
  expect(state.ask.lines.some((line) => line.kind === "approval")).toBe(false);
  expect(JSON.stringify(state.ask.lines)).not.toContain("PRIVATE REASONING");
  expect(JSON.stringify(state.ask.lines)).not.toContain("do not replay");
  expect(
    conversationLines(conversation).some(
      (line) => "text" in line && line.text.includes("Approved old-call (recorded)"),
    ),
  ).toBe(true);
  const explored = reducer(state, { type: "view/set", view: "explore" });
  expect(reducer(explored, { type: "view/set", view: "ask" }).ask).toEqual(state.ask);
  const fresh = reducer(state, { type: "ask/new" });
  expect(fresh.ask.conversationId).toBeNull();
  expect(fresh.ask.citations).toEqual([]);
  expect(fresh.ask.lines).toEqual([]);
});

test("thread labels recover meaningful names from old TUI session topics and filter by context", () => {
  const legacy = conversationFixture({ topic: "TUI session" });
  expect(conversationTitle(legacy)).toBe("What did we learn about storage?");
  expect(conversationMatches([legacy], "JOURNAL")).toEqual([legacy]);
  expect(conversationMatches([legacy], "unrelated")).toEqual([]);
});

test("conversation shortcuts work in the composer and explorer without consuming ordinary text", () => {
  for (const state of [
    initialState("/vault"),
    reducer(initialState("/vault"), { type: "view/set", view: "explore" }),
  ]) {
    expect(resolveKey(state, { name: "o", ctrl: true })).toEqual({ kind: "conversations" });
    expect(resolveKey(state, { name: "n", ctrl: true })).toEqual({ kind: "new-conversation" });
  }
  expect(resolveKey(initialState("/vault"), { name: "n" })).toBeNull();
});

test("validated list/load only resume the current identity even for a human administrator", async () => {
  const own = conversationFixture();
  const foreign = conversationFixture({
    id: "agent-thread",
    clientIdentity: "codex",
    updatedAt: 2000,
  });
  const calls: string[] = [];
  const client: ClientHandle = {
    principal: { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
    async *call(method) {
      calls.push(method);
      yield {
        id: "request",
        type: "result",
        ok: true,
        ...(method === "chat.list" ? { conversations: [foreign, own] } : { conversation: foreign }),
      };
    },
    close: async () => {},
  };
  const rpc = createRpc(client);
  expect(await ownConversations(rpc)).toEqual([own]);
  await expect(loadOwnConversation(rpc, foreign.notePath)).rejects.toThrow("another identity");
  expect(calls).toEqual(["chat.list", "chat.load"]);
});

test("list and load reject incomplete stored conversation payloads", async () => {
  const client: ClientHandle = {
    principal: { id: "human", kind: "human", scopes: ["read"] },
    async *call(method) {
      const broken = { ...conversationFixture(), messageCount: 0 };
      yield {
        id: "request",
        type: "result",
        ok: true,
        ...(method === "chat.list" ? { conversations: [broken] } : { conversation: broken }),
      };
    },
    close: async () => {},
  };
  const rpc = createRpc(client);
  await expect(rpc.chatList()).rejects.toThrow("messageCount");
  await expect(rpc.chatLoad(conversationFixture().notePath)).rejects.toThrow("messageCount");
});
