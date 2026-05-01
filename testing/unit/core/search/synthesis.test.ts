import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  ChatOptions,
  JsonSchema,
  LLMProvider,
} from "../../../../src/core/llm/provider";
import { parseSynthesis, synthesize } from "../../../../src/core/search/synthesis";
import type { SearchHit } from "../../../../src/core/search/types";

interface FakeProviderInput {
  tokens?: string[];
  fail?: () => Error;
  delayPerToken?: number;
  onStream?: (messages: ChatMessage[], options: ChatOptions) => void;
}

function fakeProvider(stub: FakeProviderInput): LLMProvider {
  return {
    isAvailable: async () => true,
    chat: async () => "",
    chatStream: async function* (
      messages: ChatMessage[],
      options: ChatOptions,
    ): AsyncIterable<string> {
      stub.onStream?.(messages, options);
      if (stub.fail) throw stub.fail();
      for (const token of stub.tokens ?? []) {
        if (stub.delayPerToken !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, stub.delayPerToken));
        }
        yield token;
      }
    },
    embed: async () => [],
    chatJson: async <T>(
      _messages: ChatMessage[],
      _options: ChatOptions,
      _schema: JsonSchema,
    ): Promise<T> => ({}) as T,
  };
}

function makeHit(notePath: string, snippet: string): SearchHit {
  return {
    notePath,
    chunkId: `chunk-${notePath}`,
    snippet,
    score: 1,
    matchedText: "q",
  };
}

describe("parseSynthesis", () => {
  test("extracts bullets that include at least one wikilink citation", () => {
    const text = [
      "- Graphs work because of expansion [[Graph]]",
      "- This bullet has no citation",
      "* Vector search complements graphs [[Vector]]",
    ].join("\n");
    const card = parseSynthesis(text);
    expect(card.bullets).toHaveLength(2);
    expect(card.bullets[0].text).toContain("[[Graph]]");
    expect(card.bullets[0].citations).toEqual(["[[Graph]]"]);
    expect(card.bullets[1].citations).toEqual(["[[Vector]]"]);
    expect(card.error).toBeUndefined();
  });

  test("drops bullets without citations even when other bullets are valid", () => {
    const text = ["- Cited claim [[Note A]]", "- Uncited claim that should drop"].join("\n");
    const card = parseSynthesis(text);
    expect(card.bullets.map((bullet) => bullet.text)).toEqual(["Cited claim [[Note A]]"]);
  });

  test("captures multiple citations per bullet", () => {
    const card = parseSynthesis("- Mixed claim [[Alpha]] and [[Beta]]");
    expect(card.bullets[0].citations).toEqual(["[[Alpha]]", "[[Beta]]"]);
  });

  test("tolerates trailing prose after the bullet list", () => {
    const text = [
      "- Cited claim [[Note]]",
      "",
      "This is some trailing prose that the parser should ignore.",
    ].join("\n");
    const card = parseSynthesis(text);
    expect(card.bullets).toHaveLength(1);
    expect(card.bullets[0].citations).toEqual(["[[Note]]"]);
  });

  test("returns no-citations error when no bullet survives", () => {
    const card = parseSynthesis("- bullet with no link\n- another raw bullet");
    expect(card.bullets).toEqual([]);
    expect(card.error).toBe("no-citations");
  });

  test("drops bullets whose citations are outside the retrieved-source allowlist", () => {
    const card = parseSynthesis(
      "- Real claim [[Graph]]\n- Hallucinated claim [[Ghost]]",
      new Set(["[[Graph]]"]),
    );
    expect(card.bullets).toHaveLength(1);
    expect(card.bullets[0].citations).toEqual(["[[Graph]]"]);
  });

  test("ignores bullets inside fenced JSON/code blocks", () => {
    const card = parseSynthesis('```json\n{"answer":"- fake [[Ghost]]"}\n```\n- real [[Graph]]');
    expect(card.bullets).toHaveLength(1);
    expect(card.bullets[0].citations).toEqual(["[[Graph]]"]);
  });
});

describe("synthesize", () => {
  const baseHits: SearchHit[] = [makeHit("/Notes/Graph.md", "graph reasoning")];

  test("streams tokens, parses bullets, and emits onToken callback", async () => {
    const tokens = [
      "- Graph reasoning ",
      "is grounded ",
      "[[Graph]]\n",
      "- Vector search complements ",
      "[[Vector]]\n",
    ];
    const seen: string[] = [];
    const provider = fakeProvider({ tokens });
    const card = await synthesize({
      provider,
      model: "reasoning",
      query: "why graphs",
      hits: [...baseHits, makeHit("/Notes/Vector.md", "vector search")],
      signal: new AbortController().signal,
      onToken: (token) => {
        seen.push(token);
      },
    });
    expect(seen).toEqual(tokens);
    expect(card.bullets).toHaveLength(2);
    expect(card.bullets[0].citations).toEqual(["[[Graph]]"]);
    expect(card.error).toBeUndefined();
  });

  test("drops streamed bullets with hallucinated citations", async () => {
    const provider = fakeProvider({
      tokens: ["- unsupported [[Ghost]]\n", "- grounded [[Graph]]\n"],
    });
    const card = await synthesize({
      provider,
      model: "reasoning",
      query: "why graphs",
      hits: baseHits,
      signal: new AbortController().signal,
    });
    expect(card.bullets).toHaveLength(1);
    expect(card.bullets[0].citations).toEqual(["[[Graph]]"]);
  });

  test("returns no-hits stub when called with an empty hit list", async () => {
    const provider = fakeProvider({ tokens: ["unused"] });
    const card = await synthesize({
      provider,
      model: "reasoning",
      query: "anything",
      hits: [],
      signal: new AbortController().signal,
    });
    expect(card.bullets).toEqual([]);
    expect(card.error).toBe("no-hits");
  });

  test("returns empty-response error when the model emits nothing", async () => {
    const provider = fakeProvider({ tokens: ["", "", ""] });
    const card = await synthesize({
      provider,
      model: "reasoning",
      query: "q",
      hits: baseHits,
      signal: new AbortController().signal,
    });
    expect(card.bullets).toEqual([]);
    expect(card.error).toBe("empty-response");
  });

  test("returns error stub instead of throwing on provider transport failure", async () => {
    const provider = fakeProvider({
      fail: () => new Error("llama-server 500"),
    });
    const card = await synthesize({
      provider,
      model: "reasoning",
      query: "q",
      hits: baseHits,
      signal: new AbortController().signal,
    });
    expect(card.bullets).toEqual([]);
    expect(card.error).toBe("llama-server 500");
  });

  test("propagates AbortError so callers can short-circuit", async () => {
    const provider = fakeProvider({
      fail: () => {
        const aborted = new Error("aborted");
        aborted.name = "AbortError";
        return aborted;
      },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      synthesize({
        provider,
        model: "reasoning",
        query: "q",
        hits: baseHits,
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();
  });

  test("tolerates graph-expanded hits that lack a notePath at runtime", async () => {
    // Graph-expanded hits set viaPath instead of notePath. The runtime can
    // produce entries where notePath is undefined even though the SearchHit
    // type declares it required. The prompt builder must not crash on such
    // entries via `notePath.split("/")`.
    const baseHit: SearchHit = makeHit("/Notes/Indexing.md", "tier 1 indexing");
    const graphExpandedHit = {
      notePath: undefined,
      chunkId: null,
      snippet: "via [[06-indexing.md]] (wikilink, agent: unknown)",
      score: 0.5,
      matchedText: "",
      viaPath: "06-indexing.md",
    } as unknown as SearchHit;
    const provider = fakeProvider({
      tokens: ["- Indexing is tiered [[Indexing]]\n"],
    });
    const card = await synthesize({
      provider,
      model: "reasoning",
      query: "tier 1 indexing",
      hits: [baseHit, graphExpandedHit],
      signal: new AbortController().signal,
    });
    expect(card.error).toBeUndefined();
    expect(card.rawText.length).toBeGreaterThan(0);
    expect(card.bullets).toHaveLength(1);
    expect(card.bullets[0].citations).toEqual(["[[Indexing]]"]);
  });

  test("forwards model and signal into the provider call", async () => {
    const captured: { options: ChatOptions | null } = { options: null };
    const provider = fakeProvider({
      tokens: ["- ok [[Graph]]\n"],
      onStream: (_messages, options) => {
        captured.options = options;
      },
    });
    const controller = new AbortController();
    await synthesize({
      provider,
      model: "reason-1",
      query: "q",
      hits: baseHits,
      signal: controller.signal,
    });
    expect(captured.options?.model).toBe("reason-1");
    expect(captured.options?.signal).toBe(controller.signal);
  });
});
