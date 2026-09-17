import { describe, expect, test } from "bun:test";
import { ReasoningScheduler } from "../../../../src/core/coordinator/reasoningScheduler";
import { EventBus } from "../../../../src/core/events/eventBus";
import {
  ChatJsonParseError,
  type ChatMessage,
  type ChatOptions,
  type JsonSchema,
  type LLMProvider,
} from "../../../../src/core/llm/provider";
import { Reranker } from "../../../../src/core/search/reranker";
import type { SearchHit } from "../../../../src/core/search/types";

function makeHit(chunkId: string, notePath: string, score = 1): SearchHit {
  return {
    notePath,
    chunkId,
    snippet: `snippet at ${notePath}`,
    score,
    matchedText: "x",
  };
}

interface FakeProviderOptions {
  response?: unknown;
  ranking?: number[];
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
      return ("response" in stub ? stub.response : { ranking: stub.ranking ?? [] }) as T;
    },
  };
}

describe("Reranker", () => {
  const scheduler = new ReasoningScheduler({ maxConcurrent: 1 });

  test("identity reorder when model returns input order", async () => {
    const hits = [makeHit("a", "/a.md"), makeHit("b", "/b.md"), makeHit("c", "/c.md")];
    const provider = fakeProvider({ ranking: [1, 2, 3] });
    const reranker = new Reranker({ provider, model: "m", bus: new EventBus() });
    const result = await reranker.rerank("q", hits, 3, new AbortController().signal, scheduler);
    expect(result.map((h) => h.chunkId)).toEqual(["a", "b", "c"]);
  });

  test("partial reorder respects model output and trims to topN", async () => {
    const hits = [makeHit("a", "/a.md"), makeHit("b", "/b.md"), makeHit("c", "/c.md")];
    const provider = fakeProvider({ ranking: [3, 1, 2] });
    const reranker = new Reranker({ provider, model: "m", bus: new EventBus() });
    const result = await reranker.rerank("q", hits, 2, new AbortController().signal, scheduler);
    expect(result.map((h) => h.chunkId)).toEqual(["c", "a"]);
  });

  test("a partial ranking is rejected and transparently preserves input order", async () => {
    const hits = [makeHit("a", "/a.md"), makeHit("b", "/b.md"), makeHit("c", "/c.md")];
    const provider = fakeProvider({ ranking: [2] });
    const reranker = new Reranker({ provider, model: "m", bus: new EventBus() });
    const result = await reranker.rerank("q", hits, 3, new AbortController().signal, scheduler);
    expect(result.map((hit) => hit.chunkId)).toEqual(["a", "b", "c"]);
  });

  test("falls back to input order on parse error", async () => {
    const hits = [makeHit("a", "/a.md"), makeHit("b", "/b.md")];
    const provider = fakeProvider({
      fail: () => new ChatJsonParseError("bad", "raw"),
    });
    const reranker = new Reranker({ provider, model: "m", bus: new EventBus() });
    const result = await reranker.rerank("q", hits, 2, new AbortController().signal, scheduler);
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
    const reranker = new Reranker({ provider, model: "m", bus: new EventBus() });
    const controller = new AbortController();
    controller.abort();
    await expect(reranker.rerank("q", hits, 2, controller.signal, scheduler)).rejects.toBeDefined();
  });

  test("passes signal and model into the provider call", async () => {
    const captured: { options: ChatOptions | null } = { options: null };
    const provider = fakeProvider({
      ranking: [1],
      onCall: (_messages, options) => {
        captured.options = options;
      },
    });
    const reranker = new Reranker({ provider, model: "rerank-1", bus: new EventBus() });
    const controller = new AbortController();
    await reranker.rerank(
      "q",
      [makeHit("a", "/a.md"), makeHit("b", "/b.md")],
      1,
      controller.signal,
      scheduler,
    );
    expect(captured.options).not.toBeNull();
    expect(captured.options?.model).toBe("rerank-1");
    expect(captured.options?.signal).toBeInstanceOf(AbortSignal);
    expect(captured.options?.signal).not.toBe(controller.signal);
  });

  test("emits search:rerank_failed and keeps input order when the model fails", async () => {
    const hits = [makeHit("a", "/a.md"), makeHit("b", "/b.md")];
    const provider = fakeProvider({ fail: () => new ChatJsonParseError("bad", "raw") });
    const bus = new EventBus();
    const seen: Array<{ query: string; candidates: number }> = [];
    bus.on("search:rerank_failed", (event) => {
      seen.push({ query: event.query, candidates: event.candidates });
    });
    const reranker = new Reranker({ provider, model: "m", bus });
    const result = await reranker.rerank("q", hits, 2, new AbortController().signal, scheduler);
    expect(result.map((h) => h.chunkId)).toEqual(["a", "b"]);
    expect(seen).toEqual([{ query: "q", candidates: 2 }]);
  });

  test("emits search:rerank_failed when the ranking is not a complete permutation", async () => {
    const hits = [makeHit("a", "/a.md"), makeHit("b", "/b.md")];
    const provider = fakeProvider({ ranking: [42, -1] });
    const bus = new EventBus();
    let failures = 0;
    bus.on("search:rerank_failed", () => {
      failures += 1;
    });
    const reranker = new Reranker({ provider, model: "m", bus });
    const result = await reranker.rerank("q", hits, 2, new AbortController().signal, scheduler);
    expect(result.map((h) => h.chunkId)).toEqual(["a", "b"]);
    expect(failures).toBe(1);
  });

  test.each([
    ["numeric strings", { ranking: ["1", "2"] }],
    ["duplicate indexes", { ranking: [1, 1] }],
    ["extra response fields", { ranking: [1, 2], legacy: true }],
    ["a missing ranking", {}],
    ["a non-object response", null],
  ])("rejects %s without partially applying it", async (_label, response) => {
    const hits = [makeHit("a", "/a.md"), makeHit("b", "/b.md")];
    const bus = new EventBus();
    let failures = 0;
    bus.on("search:rerank_failed", () => {
      failures += 1;
    });
    const reranker = new Reranker({
      provider: fakeProvider({ response }),
      model: "m",
      bus,
    });
    const result = await reranker.rerank("q", hits, 2, new AbortController().signal, scheduler);
    expect(result.map((hit) => hit.chunkId)).toEqual(["a", "b"]);
    expect(failures).toBe(1);
  });

  test("presents candidates as bracketed integers, never record ids", async () => {
    const captured: { messages: ChatMessage[] | null } = { messages: null };
    const provider = fakeProvider({
      ranking: [1, 2],
      onCall: (messages) => {
        captured.messages = messages;
      },
    });
    const reranker = new Reranker({ provider, model: "m", bus: new EventBus() });
    await reranker.rerank(
      "q",
      [makeHit("chunk:abc", "/a.md"), makeHit("chunk:def", "/b.md")],
      2,
      new AbortController().signal,
      scheduler,
    );
    const userContent = captured.messages?.[1].content ?? "";
    expect(userContent).toContain("[1]");
    expect(userContent).toContain("[2]");
    expect(userContent).not.toContain("chunk:abc");
  });

  test("returns input slice without LLM call when 0 or 1 hits", async () => {
    let calls = 0;
    const provider = fakeProvider({
      ranking: [],
      onCall: () => {
        calls += 1;
      },
    });
    const reranker = new Reranker({ provider, model: "m", bus: new EventBus() });
    const empty = await reranker.rerank("q", [], 5, new AbortController().signal, scheduler);
    const single = await reranker.rerank(
      "q",
      [makeHit("a", "/a.md")],
      5,
      new AbortController().signal,
      scheduler,
    );
    expect(empty).toEqual([]);
    expect(single.map((h) => h.chunkId)).toEqual(["a"]);
    expect(calls).toBe(0);
  });
});
