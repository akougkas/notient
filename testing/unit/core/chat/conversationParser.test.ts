import { describe, expect, test } from "bun:test";
import {
  parseConversation,
  serializeConversation,
} from "../../../../src/core/chat/conversationParser";
import type { ChatMessage, Conversation } from "../../../../src/core/chat/types";

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    notePath: "Notient/conversations/2026-04-25 hello.md",
    model: "qwen3-4b-mlx",
    pinnedContext: ["Notes/Project.md"],
    approvalMode: "safe",
    topic: "Hello world",
    summary: "Greeting exchange",
    clientIdentity: "human",
    messageCount: 0,
    createdAt: 1745625600000,
    updatedAt: 1745625600000,
    messages: [],
    ...overrides,
  };
}

describe("conversationParser", () => {
  test("writes the one canonical Notient conversation marker and version", () => {
    const serialized = serializeConversation(makeConversation());
    expect(serialized).toStartWith("---\nnotient: conversation\nconversation_version: 1\n");
  });

  test("derives message_count and refuses to persist an invalid client identity", () => {
    const serialized = serializeConversation(
      makeConversation({
        messageCount: 99,
        messages: [{ id: "m1", role: "user", content: "hi", createdAt: 1 }],
      }),
    );
    expect(serialized).toContain("message_count: 1");
    expect(() => serializeConversation(makeConversation({ clientIdentity: "" }))).toThrow(
      "client_identity must match",
    );
  });

  test("rejects ordinary Markdown instead of inventing a conversation", () => {
    expect(() =>
      parseConversation("# Project note\n\nJust ordinary Markdown.\n", "note.md"),
    ).toThrow("missing Notient conversation frontmatter");
  });

  test("rejects frontmatter without the Notient conversation marker", () => {
    const raw = serializeConversation(makeConversation()).replace("notient: conversation\n", "");
    expect(() => parseConversation(raw, "missing-marker.md")).toThrow(
      "missing marker 'notient: conversation'",
    );
  });

  test("rejects a missing or unsupported conversation version", () => {
    const canonical = serializeConversation(makeConversation());
    const missing = canonical.replace("conversation_version: 1\n", "");
    const unsupported = canonical.replace("conversation_version: 1", "conversation_version: 2");

    expect(() => parseConversation(missing, "missing-version.md")).toThrow(
      "missing required frontmatter field 'conversation_version'",
    );
    expect(() => parseConversation(unsupported, "future-version.md")).toThrow(
      "unsupported conversation_version 2; expected 1",
    );
  });

  test("rejects missing and retired sender/client identity fields", () => {
    const canonical = serializeConversation(makeConversation());
    const missing = canonical.replace('client_identity: "human"\n', "");
    expect(() => parseConversation(missing, "missing-identity.md")).toThrow(
      "missing required frontmatter field 'client_identity'",
    );

    for (const retired of ["sender", "sender_identity", "client", "clientIdentity"]) {
      const raw = canonical.replace("client_identity:", `${retired}:`);
      expect(() => parseConversation(raw, `${retired}.md`)).toThrow(
        `retired identity field '${retired}'; use 'client_identity'`,
      );
    }
  });

  test("rejects unknown and duplicate frontmatter fields", () => {
    const canonical = serializeConversation(makeConversation());
    const unknown = canonical.replace(
      "notient: conversation\n",
      "notient: conversation\ntags: []\n",
    );
    const duplicate = canonical.replace(
      'client_identity: "human"',
      'client_identity: "human"\nclient_identity: "codex"',
    );
    expect(() => parseConversation(unknown, "unknown.md")).toThrow(
      "unsupported frontmatter field 'tags'",
    );
    expect(() => parseConversation(duplicate, "duplicate.md")).toThrow(
      "duplicate frontmatter field 'client_identity'",
    );
  });

  test("roundtrips a fixture with text + tool call + tool result + approval", () => {
    const messages: ChatMessage[] = [
      {
        id: "m-user",
        role: "user",
        content: "List my project notes.",
        createdAt: 1745625600000,
      },
      {
        id: "m-assistant",
        role: "assistant",
        content: "Here are the notes I found.",
        toolCalls: [
          {
            id: "call-1",
            name: "search_vault",
            args: { query: "project", limit: 5 },
          },
        ],
        toolResults: [
          {
            callId: "call-1",
            status: "ok",
            data: { hits: 3 },
            durationMs: 142,
          },
        ],
        approvals: [
          {
            callId: "call-1",
            approved: true,
            decidedAt: 1745625610000,
            reason: "auto-approved (read-only)",
          },
        ],
        createdAt: 1745625620000,
      },
    ];
    const original = makeConversation({ messages, messageCount: messages.length });

    const serialized = serializeConversation(original);
    const parsed = parseConversation(serialized, original.notePath);

    expect(parsed.id).toBe(original.id);
    expect(parsed.model).toBe(original.model);
    expect(parsed.pinnedContext).toEqual(original.pinnedContext);
    expect(parsed.approvalMode).toBe(original.approvalMode);
    expect(parsed.topic).toBe(original.topic);
    expect(parsed.summary).toBe(original.summary);
    expect(parsed.createdAt).toBe(original.createdAt);
    expect(parsed.updatedAt).toBe(original.updatedAt);
    expect(parsed.messages.length).toBe(2);

    const [user, assistant] = parsed.messages;
    expect(user.role).toBe("user");
    expect(user.content).toBe("List my project notes.");
    expect(user.createdAt).toBe(1745625600000);

    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("Here are the notes I found.");
    expect(assistant.createdAt).toBe(1745625620000);
    expect(assistant.toolCalls?.length).toBe(1);
    expect(assistant.toolCalls?.[0].name).toBe("search_vault");
    expect(assistant.toolCalls?.[0].args).toEqual({ query: "project", limit: 5 });
    expect(assistant.toolResults?.[0].status).toBe("ok");
    expect(assistant.toolResults?.[0].data).toEqual({ hits: 3 });
    expect(assistant.toolResults?.[0].durationMs).toBe(142);
    expect(assistant.approvals?.[0].approved).toBe(true);
    expect(assistant.approvals?.[0].reason).toBe("auto-approved (read-only)");
    expect(assistant.approvals?.[0].decidedAt).toBe(1745625610000);
  });

  test("roundtrips Markdown headings inside message content", () => {
    const conversation = makeConversation({
      messages: [
        {
          id: "m-heading",
          role: "assistant",
          content: "A preface.\n\n## Evidence\n\nThe notes support this.",
          createdAt: 1745625600000,
        },
      ],
    });
    const parsed = parseConversation(serializeConversation(conversation), conversation.notePath);
    expect(parsed.messages[0].content).toBe("A preface.\n\n## Evidence\n\nThe notes support this.");
  });

  test("rejects retired sender headings and non-canonical timestamps", () => {
    const canonical = serializeConversation(
      makeConversation({
        messages: [{ id: "m1", role: "user", content: "hi", createdAt: 1745625600000 }],
      }),
    );
    const retiredSender = canonical.replace("## User ·", "## Sender ·");
    const looseTimestamp = canonical.replace("2025-04-26T00:00:00.000Z", "2025-04-26 00:00:00Z");
    expect(() => parseConversation(retiredSender, "sender.md")).toThrow("retired sender heading");
    expect(() => parseConversation(looseTimestamp, "timestamp.md")).toThrow(
      "message timestamp must be canonical ISO 8601",
    );
  });

  test("preserves multiple sequential tool calls in one assistant turn", () => {
    const message: ChatMessage = {
      id: "m-multi",
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "c1", name: "read_note", args: { path: "a.md" } },
        { id: "c2", name: "read_note", args: { path: "b.md" } },
      ],
      toolResults: [
        { callId: "c1", status: "ok", data: "alpha", durationMs: 10 },
        { callId: "c2", status: "error", error: "missing", durationMs: 5 },
      ],
      createdAt: 1745625700000,
    };
    const conv = makeConversation({ messages: [message], messageCount: 1 });

    const parsed = parseConversation(serializeConversation(conv), conv.notePath);
    expect(parsed.messages[0].toolCalls?.length).toBe(2);
    expect(parsed.messages[0].toolCalls?.[1].args).toEqual({ path: "b.md" });
    expect(parsed.messages[0].toolResults?.[1].status).toBe("error");
    expect(parsed.messages[0].toolResults?.[1].error).toBe("missing");
  });

  test("tolerates trailing whitespace and a trailing newline", () => {
    const conv = makeConversation({
      messages: [{ id: "m1", role: "user", content: "hi", createdAt: 1745625600000 }],
      messageCount: 1,
    });
    const padded = `${serializeConversation(conv)}\n   \n`;
    const parsed = parseConversation(padded, conv.notePath);
    expect(parsed.messages[0].content).toBe("hi");
    expect(parsed.messages[0].role).toBe("user");
  });

  test("rejects a tool callout with malformed JSON args", () => {
    const raw = serializeConversation(
      makeConversation({
        messages: [
          {
            id: "m-bad",
            role: "assistant",
            content: "Plain text body still readable.",
            toolCalls: [{ id: "c-bad", name: "busted", args: { valid: true } }],
            createdAt: 1,
          },
        ],
      }),
    ).replace('> args: {"valid":true}', "> args: {not json}");
    expect(() => parseConversation(raw, "Notient/conversations/broken.md")).toThrow(
      "tool args must be a JSON object",
    );
  });

  test("keeps embedding bytes out of Markdown and rejects the retired field", () => {
    const conv = makeConversation();
    const canonical = serializeConversation(conv);
    expect(canonical).not.toContain("summary_embedding");
    const polluted = canonical.replace(
      `summary: ${JSON.stringify(conv.summary)}\n`,
      `summary: ${JSON.stringify(conv.summary)}\nsummary_embedding_b64: "AAECAwQFBgc="\n`,
    );
    expect(() => parseConversation(polluted, conv.notePath)).toThrow(
      "unsupported frontmatter field 'summary_embedding_b64'",
    );
  });
});

describe("tool message round-trip", () => {
  test("preserves toolCallId through serialize/parse", () => {
    const conv = makeConversation({
      messages: [
        {
          id: "a",
          role: "assistant",
          content: "looking",
          toolCalls: [{ id: "call-1", name: "vault.read", args: { path: "A.md" } }],
          toolResults: [{ callId: "call-1", status: "ok", data: { body: "x" }, durationMs: 3 }],
          createdAt: 1,
        },
        {
          id: "t",
          role: "tool",
          content: '{"body":"x"}',
          toolCallId: "call-1",
          createdAt: 2,
        },
      ],
    });

    const parsed = parseConversation(serializeConversation(conv), conv.notePath);
    const toolMessage = parsed.messages.find((message) => message.role === "tool");
    expect(toolMessage?.toolCallId).toBe("call-1");
    expect(toolMessage?.content).toBe('{"body":"x"}');
    expect(parsed.messages[0]?.toolCalls?.[0]?.id).toBe("call-1");
  });

  test("rejects a tool message without its canonical tool-call-id callout", () => {
    const raw = serializeConversation(
      makeConversation({
        messages: [
          {
            id: "t",
            role: "tool",
            content: '{"body":"x"}',
            toolCallId: "call-1",
            createdAt: 2,
          },
        ],
      }),
    ).replace("\n\n> [!notient-tool-result] call-1", "");
    expect(() => parseConversation(raw, "p.md")).toThrow(
      "tool message is missing its tool-call id",
    );
  });
});
