import { describe, expect, test } from "bun:test";
import { Embedder } from "../../../../src/core/indexer/embedder";
import type {
  ChatMessage,
  ChatOptions,
  EmbedOptions,
  JsonSchema,
  LLMProvider,
} from "../../../../src/core/llm/provider";

function fakeProvider(impl: Partial<LLMProvider>): LLMProvider {
  return {
    isAvailable: async () => true,
    chat: async () => "",
    chatStream: async function* () {
      yield "";
    },
    chatJson: async <T>() => ({}) as T,
    embed: async () => [],
    ...impl,
  };
}

describe("Embedder", () => {
  test("batches inputs into batches of `batchSize`", async () => {
    const seenBatches: string[][] = [];
    const provider = fakeProvider({
      embed: async (input: string[]) => {
        seenBatches.push(input);
        return input.map(() => Array.from({ length: 4 }, () => 0.1));
      },
    });
    const embedder = new Embedder(provider, { model: "e", batchSize: 3 });
    const inputs = ["a", "b", "c", "d", "e", "f", "g"];
    const vectors = await embedder.embed(inputs);
    expect(vectors).toHaveLength(7);
    expect(seenBatches.map((b) => b.length)).toEqual([3, 3, 1]);
  });

  test("preserves input order across batches", async () => {
    const provider = fakeProvider({
      embed: async (input: string[]) =>
        input.map((s) => Array.from({ length: 4 }, () => Number.parseInt(s, 10))),
    });
    const embedder = new Embedder(provider, { model: "e", batchSize: 2 });
    const vectors = await embedder.embed(["1", "2", "3", "4", "5"]);
    expect(vectors.map((v) => v[0])).toEqual([1, 2, 3, 4, 5]);
  });

  test("retries once on transient error then succeeds", async () => {
    let calls = 0;
    const provider = fakeProvider({
      embed: async (input: string[]) => {
        calls++;
        if (calls === 1) throw new Error("ECONNRESET");
        return input.map(() => [0.1, 0.2, 0.3, 0.4]);
      },
    });
    const embedder = new Embedder(provider, { model: "e", batchSize: 4, retryDelayMs: 1 });
    const vectors = await embedder.embed(["a", "b"]);
    expect(vectors).toHaveLength(2);
    expect(calls).toBe(2);
  });

  test("re-throws after exhausting retries", async () => {
    const provider = fakeProvider({
      embed: async () => {
        throw new Error("permanent");
      },
    });
    const embedder = new Embedder(provider, { model: "e", batchSize: 2, retryDelayMs: 1 });
    await expect(embedder.embed(["a"])).rejects.toThrow("permanent");
  });

  test("empty input yields empty vectors", async () => {
    const provider = fakeProvider({});
    const embedder = new Embedder(provider, { model: "e", batchSize: 4 });
    expect(await embedder.embed([])).toEqual([]);
  });
});
