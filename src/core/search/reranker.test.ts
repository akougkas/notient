import { describe, expect, test } from "bun:test";
import {
  ChatJsonParseError,
  type ChatMessage,
  type ChatOptions,
  type JsonSchema,
  type LLMProvider,
} from "../llm/provider";
import { Reranker } from "./reranker";
import type { SearchHit } from "./types";

function makeHit(chunkId: string, notePath: string, score = 1): SearchHit {
  return {
    notePath,
    chunkId,
    snippet: `snippet for ${chunkId}`,
    score,
    matchedText: "x",
  };
}

interface FakeProviderOptions {
  ranking?: string[];
  fail?: () => Error;
  onCall?: (messages: ChatMessage[], options: ChatOptions, schema: JsonSchema) => void;
}

function fakeProvider(stub: FakeProviderOptions): LLMProvider {
  return {
    isAvailable: async () => true,
    chat: async () => "",
    chatStream: async function* () {
      yield "";
    },
    embed: async () => [],
    chatJson: async <T>(
      messages: ChatMessage[],
      options: ChatOptions,
      schema: JsonSchema,
    ): Promise<T> => {
      stub.onCall?.(messages, options, schema);
      if (stub.fail) throw stub.fail();
      return { ranking: stub.ranking ?? [] } as T;
    },
  };
}

describe("Reranker", () => {
  test("identity reorder when model returns input order", async () => {
    const hits = [makeHit("a", "/a.md"), makeHit("b", "/b.md"), makeHit("c", "/c.md")];
    const provider = fakeProvider({ ranking: ["a", "b", "c"] });
    const reranker = new Reranker({ provider, model: "m" });
    const result = await reranker.rerank("q", hits, 3, new AbortController().signal);
    expect(result.map((h) => h.chunkId)).toEqual(["a", "b", "c"]);
  });

  test("partial reorder respects model output and trims to topN", async () => {
    const hits = [makeHit("a", "/a.md"), makeHit("b", "/b.md"), makeHit("c", "/c.md")];
    const provider = fakeProvider({ ranking: ["c", "a", "b"] });
    const reranker = new Reranker({ provider, model: "m" });
    const result = await reranker.rerank("q", hits, 2, new AbortController().signal);
    expect(result.map((h) => h.chunkId)).toEqual(["c", "a"]);
  });

  test("ids missing from ranking sink to the bottom but remain present", async () => {
    const hits = [makeHit("a", "/a.md"), makeHit("b", "/b.md"), makeHit("c", "/c.md")];
    const provider = fakeProvider({ ranking: ["b"] });
    const reranker = new Reranker({ provider, model: "m" });
    const result = await reranker.rerank("q", hits, 3, new AbortController().signal);
    expect(result[0].chunkId).toBe("b");
    expect(result.length).toBe(3);
  });

  test("falls back to input order on parse error", async () => {
    const hits = [makeHit("a", "/a.md"), makeHit("b", "/b.md")];
    const provider = fakeProvider({
      fail: () => new ChatJsonParseError("bad", "raw"),
    });
    const reranker = new Reranker({ provider, model: "m" });
    const result = await reranker.rerank("q", hits, 2, new AbortController().signal);
    expect(result.map((h) => h.chunkId)).toEqual(["a", "b"]);
  });

  test("propagates AbortError instead of swallowing it", async () => {
    const hits = [makeHit("a", "/a.md"), makeHit("b", "/b.md")];
    const provider = fakeProvider({
      fail: () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        return error;
      },
    });
    const reranker = new Reranker({ provider, model: "m" });
    const controller = new AbortController();
    controller.abort();
    await expect(reranker.rerank("q", hits, 2, controller.signal)).rejects.toBeDefined();
  });

  test("passes signal and model into the provider call", async () => {
    const captured: { options: ChatOptions | null } = { options: null };
    const provider = fakeProvider({
      ranking: ["a"],
      onCall: (_messages, options) => {
        captured.options = options;
      },
    });
    const reranker = new Reranker({ provider, model: "rerank-1" });
    const controller = new AbortController();
    await reranker.rerank(
      "q",
      [makeHit("a", "/a.md"), makeHit("b", "/b.md")],
      1,
      controller.signal,
    );
    expect(captured.options).not.toBeNull();
    expect(captured.options?.model).toBe("rerank-1");
    expect(captured.options?.signal).toBe(controller.signal);
  });

  test("returns input slice without LLM call when 0 or 1 hits", async () => {
    let calls = 0;
    const provider = fakeProvider({
      ranking: [],
      onCall: () => {
        calls += 1;
      },
    });
    const reranker = new Reranker({ provider, model: "m" });
    const empty = await reranker.rerank("q", [], 5, new AbortController().signal);
    const single = await reranker.rerank(
      "q",
      [makeHit("a", "/a.md")],
      5,
      new AbortController().signal,
    );
    expect(empty).toEqual([]);
    expect(single.map((h) => h.chunkId)).toEqual(["a"]);
    expect(calls).toBe(0);
  });
});
