import { describe, expect, test } from "bun:test";
import { createTranscriptDistiller } from "../../../../src/core/distill/transcriptDistiller";
import type { TranscriptMessage } from "../../../../src/core/distill/transcriptParser";
import type {
  ChatOptions,
  EmbedOptions,
  JsonSchema,
  LLMProvider,
  ChatMessage as ProviderChatMessage,
} from "../../../../src/core/llm/provider";

class StubProvider implements LLMProvider {
  public readonly chatCalls: ProviderChatMessage[][] = [];
  constructor(private readonly behavior: { reply: string; throwError?: boolean }) {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async chat(messages: ProviderChatMessage[], _options: ChatOptions): Promise<string> {
    this.chatCalls.push(messages);
    if (this.behavior.throwError === true) throw new Error("provider unavailable");
    return this.behavior.reply;
  }
  async *chatStream(
    _messages: ProviderChatMessage[],
    _options: ChatOptions,
  ): AsyncIterable<string> {
    yield "";
  }
  async chatJson<T>(
    _messages: ProviderChatMessage[],
    _options: ChatOptions,
    _schema: JsonSchema,
  ): Promise<T> {
    return {} as T;
  }
  async embed(_input: string[], _options: EmbedOptions): Promise<number[][]> {
    return [];
  }
}

function fixtureMessages(): TranscriptMessage[] {
  return [
    { role: "user", content: "Should we use OAuth2 with PKCE?", sourceMessageId: "msg-0-aaa" },
    {
      role: "assistant",
      content: "Yes. Going with OAuth2+PKCE for the SPA.",
      sourceMessageId: "msg-1-bbb",
    },
    {
      role: "user",
      content: "How do we handle token rotation?",
      sourceMessageId: "msg-2-ccc",
    },
  ];
}

describe("createTranscriptDistiller", () => {
  test("happy path returns parsed candidates from canned JSON reply", async () => {
    const reply = JSON.stringify([
      {
        kind: "decision",
        text: "Use OAuth2 with PKCE for the SPA.",
        sourceMessageIds: ["msg-1-bbb"],
      },
      {
        kind: "question",
        text: "How do we handle token rotation?",
        sourceMessageIds: ["msg-2-ccc"],
      },
    ]);
    const provider = new StubProvider({ reply });
    const distiller = createTranscriptDistiller({ provider });
    const candidates = await distiller.distill(fixtureMessages());
    expect(candidates).toHaveLength(2);
    expect(candidates[0].kind).toBe("decision");
    expect(candidates[0].sourceMessageIds).toEqual(["msg-1-bbb"]);
    expect(candidates[1].kind).toBe("question");
  });

  test("malformed JSON reply returns empty candidate list", async () => {
    const provider = new StubProvider({ reply: "not json" });
    const distiller = createTranscriptDistiller({ provider });
    const candidates = await distiller.distill(fixtureMessages());
    expect(candidates).toEqual([]);
  });

  test("invalid candidates are dropped, valid ones survive", async () => {
    const reply = JSON.stringify([
      { kind: "claim", text: "Valid claim.", sourceMessageIds: ["msg-1-bbb"] },
      { kind: "rumor", text: "Bogus kind.", sourceMessageIds: [] },
      { kind: "note", text: "   ", sourceMessageIds: [] },
      { kind: "question", text: "Valid question.", sourceMessageIds: [] },
    ]);
    const provider = new StubProvider({ reply });
    const distiller = createTranscriptDistiller({ provider });
    const candidates = await distiller.distill(fixtureMessages());
    expect(candidates.map((entry) => entry.kind)).toEqual(["claim", "question"]);
  });

  test("unknown sourceMessageIds are filtered out", async () => {
    const reply = JSON.stringify([
      {
        kind: "claim",
        text: "Mixed ids.",
        sourceMessageIds: ["msg-1-bbb", "msg-99-zzz"],
      },
    ]);
    const provider = new StubProvider({ reply });
    const distiller = createTranscriptDistiller({ provider });
    const candidates = await distiller.distill(fixtureMessages());
    expect(candidates[0].sourceMessageIds).toEqual(["msg-1-bbb"]);
  });

  test("empty transcript returns [] without calling provider", async () => {
    const provider = new StubProvider({ reply: "[]" });
    const distiller = createTranscriptDistiller({ provider });
    const candidates = await distiller.distill([]);
    expect(candidates).toEqual([]);
    expect(provider.chatCalls).toHaveLength(0);
  });

  test("provider error returns []", async () => {
    const provider = new StubProvider({ reply: "ignored", throwError: true });
    const distiller = createTranscriptDistiller({ provider });
    const candidates = await distiller.distill(fixtureMessages());
    expect(candidates).toEqual([]);
  });

  test("strips fenced code blocks from reply before parsing", async () => {
    const reply =
      '```json\n[{"kind":"note","text":"Wrapped in fence.","sourceMessageIds":["msg-0-aaa"]}]\n```';
    const provider = new StubProvider({ reply });
    const distiller = createTranscriptDistiller({ provider });
    const candidates = await distiller.distill(fixtureMessages());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe("note");
  });
});
