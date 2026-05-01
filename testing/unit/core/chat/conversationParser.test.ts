import { describe, expect, test } from "bun:test";
import { parseConversation, serializeConversation } from "../../../../src/core/chat/conversationParser";
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
    summaryEmbeddingB64: null,
    clientIdentity: "human",
    messageCount: 0,
    createdAt: 1745625600000,
    updatedAt: 1745625600000,
    messages: [],
    ...overrides,
  };
}

describe("conversationParser", () => {
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
    expect(parsed.summaryEmbeddingB64).toBeNull();
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

  test("degrades gracefully when a tool callout has malformed JSON args", () => {
    const raw = [
      "---",
      'conversation_id: "conv-bad"',
      'model: "qwen3-4b-mlx"',
      "pinned_context: []",
      "approval_mode: safe",
      'topic: "Broken"',
      'summary: ""',
      "summary_embedding_b64: null",
      "created_at: 1",
      "updated_at: 2",
      "message_count: 1",
      "---",
      "",
      "# Broken",
      "",
      "## Assistant · 1970-01-01T00:00:00.000Z",
      "",
      "> [!notient-tool] busted",
      "> id: c-bad",
      "> args: {not json}",
      "",
      "Plain text body still readable.",
      "",
    ].join("\n");
    const parsed = parseConversation(raw, "Notient/conversations/broken.md");
    expect(parsed.id).toBe("conv-bad");
    expect(parsed.messages.length).toBe(1);
    const message = parsed.messages[0];
    expect(message.toolCalls?.length).toBe(1);
    expect(message.toolCalls?.[0].name).toBe("busted");
    expect(message.toolCalls?.[0].args).toEqual({ __raw_payload__: "{not json}" });
    expect(message.content).toBe("Plain text body still readable.");
  });

  test("roundtrips a non-null summary_embedding_b64", () => {
    const conv = makeConversation({
      summaryEmbeddingB64: "AAECAwQFBgc=",
      messages: [{ id: "m1", role: "user", content: "ping", createdAt: 1745625600000 }],
      messageCount: 1,
    });
    const parsed = parseConversation(serializeConversation(conv), conv.notePath);
    expect(parsed.summaryEmbeddingB64).toBe("AAECAwQFBgc=");
  });
});
