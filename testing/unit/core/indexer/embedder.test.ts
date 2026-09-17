import { describe, expect, test } from "bun:test";
import { Embedder, EmbeddingContextOverflowError } from "../../../../src/core/indexer/embedder";
import { createEmbeddingIdentity } from "../../../../src/core/llm/embeddingIdentity";
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

function identity(model: string, dimension: number | null = 4) {
  return createEmbeddingIdentity(model, dimension);
}

describe("Embedder", () => {
  test("rejects invalid embedding concurrency instead of clamping it", () => {
    for (const concurrency of [0, 1.5, 129, Number.NaN]) {
      expect(
        () => new Embedder(fakeProvider({}), { identity: identity("e"), concurrency }),
      ).toThrow("concurrency must be an integer between 1 and 128");
    }
  });

  test("batches inputs into batches of `batchSize`", async () => {
    const seenBatches: string[][] = [];
    const provider = fakeProvider({
      embed: async (input: string[]) => {
        seenBatches.push(input);
        return input.map(() => Array.from({ length: 4 }, () => 0.1));
      },
    });
    const embedder = new Embedder(provider, {
      identity: identity("e"),
      batchSize: 3,
      concurrency: 1,
    });
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
    const embedder = new Embedder(provider, {
      identity: identity("e"),
      batchSize: 2,
      concurrency: 1,
    });
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
    const embedder = new Embedder(provider, {
      identity: identity("e"),
      batchSize: 4,
      retryDelayMs: 1,

      concurrency: 1,
    });
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
    const embedder = new Embedder(provider, {
      identity: identity("e"),
      batchSize: 2,
      retryDelayMs: 1,

      concurrency: 1,
    });
    await expect(embedder.embed(["a"])).rejects.toThrow("permanent");
  });

  test("empty input yields empty vectors", async () => {
    const provider = fakeProvider({});
    const embedder = new Embedder(provider, {
      identity: identity("e"),
      batchSize: 4,
      concurrency: 1,
    });
    expect(await embedder.embed([])).toEqual([]);
  });

  test("embedAll sends batches, not one request per input", async () => {
    const seenBatches: string[][] = [];
    const provider = fakeProvider({
      embed: async (input: string[]) => {
        seenBatches.push([...input]);
        return input.map((s) => [Number.parseInt(s, 10)]);
      },
    });
    const embedder = new Embedder(provider, {
      identity: identity("e", 1),
      batchSize: 3,
      concurrency: 2,
    });
    const inputs = Array.from({ length: 7 }, (_, i) => String(i));

    const vectors = await embedder.embedAll(inputs);

    expect(vectors.map((v) => v[0])).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(seenBatches).toHaveLength(3);
    expect(seenBatches.map((b) => b.length).sort()).toEqual([1, 3, 3]);
  });

  test("embedAll caps in-flight batches at `concurrency`", async () => {
    let inFlight = 0;
    let peak = 0;
    const provider = fakeProvider({
      embed: async (input: string[]) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return input.map(() => [0.1]);
      },
    });
    const embedder = new Embedder(provider, {
      identity: identity("e", 1),
      batchSize: 1,
      concurrency: 2,
    });

    await embedder.embedAll(["a", "b", "c", "d", "e"]);

    expect(peak).toBe(2);
  });

  test("embedAll retries with backoff and reports the attempt count", async () => {
    let calls = 0;
    const provider = fakeProvider({
      embed: async () => {
        calls += 1;
        throw new Error("boom");
      },
    });
    const embedder = new Embedder(provider, {
      identity: identity("e"),
      batchSize: 2,
      retryDelayMs: 1,

      concurrency: 1,
    });

    await expect(embedder.embedAll(["a", "b"])).rejects.toThrow("failed after 4 attempts");
    expect(calls).toBe(4);
  });

  test("refuses to embed when the boot probe reported no dimension", async () => {
    let calls = 0;
    const provider = fakeProvider({
      embed: async () => {
        calls += 1;
        return [[0.1]];
      },
    });
    const embedder = new Embedder(provider, { identity: identity("e", null), concurrency: 1 });

    await expect(embedder.embedAll(["a"])).rejects.toThrow("no resolved vector dimension");
    expect(calls).toBe(0);
  });

  test("concurrent embedding APIs resolve an unavailable identity once and recover after a failed probe", async () => {
    let probes = 0;
    const embedder = new Embedder(
      fakeProvider({ embed: async (inputs) => inputs.map(() => [0.1]) }),
      {
        identity: identity("e", null),
        concurrency: 1,
        resolveIdentity: async () => {
          probes += 1;
          if (probes === 1) throw new Error("endpoint unavailable");
          await Bun.sleep(5);
          return { model: "e", dimension: 1 };
        },
      },
    );
    await expect(embedder.embedAll(["a"])).rejects.toThrow("endpoint unavailable");
    expect(await Promise.all([embedder.embedAll(["a"]), embedder.embed(["b"])])).toEqual([
      [[0.1]],
      [[0.1]],
    ]);
    expect(probes).toBe(2);
    expect(embedder.getIdentity()).toEqual({ model: "e", dimension: 1 });
  });

  test("exposes the one immutable resolved identity", () => {
    const configured = { model: "some-model-v9", dimension: 17 };
    const embedder = new Embedder(fakeProvider({}), { identity: configured, concurrency: 1 });
    configured.model = "mutated-after-construction";

    expect(embedder.getIdentity()).toEqual({ model: "some-model-v9", dimension: 17 });
    expect(Object.isFrozen(embedder.getIdentity())).toBe(true);
  });

  test("rejects vectors outside the boot-resolved embedding space", async () => {
    let calls = 0;
    const embedder = new Embedder(
      fakeProvider({
        embed: async () => {
          calls += 1;
          return [[0.1, 0.2, 0.3]];
        },
      }),
      { identity: identity("e", 4), retryDelayMs: 0, concurrency: 1 },
    );

    await expect(embedder.embed(["a"])).rejects.toThrow("boot resolved 4");
    expect(calls).toBe(1);
  });
});

describe("Embedder context overflow recovery", () => {
  test("isolates a rejected input without embedding a prefix", async () => {
    const calls: string[][] = [];
    const provider = {
      isAvailable: async () => true,
      chat: async () => "",
      chatStream: async function* () {
        yield "";
      },
      chatJson: async <T>() => ({}) as T,
      embed: async (input: string[]) => {
        calls.push([...input]);
        if (input.some((text) => text.length > 300)) {
          throw new Error("Embed 400 Bad Request the input length exceeds the context length");
        }
        return input.map(() => [1, 2, 3]);
      },
    };
    const embedder = new Embedder(provider, {
      identity: identity("m", 3),
      retryDelayMs: 0,
      batchSize: 16,

      concurrency: 1,
    });
    const big = "x".repeat(500);

    const promise = embedder.embedAll(["a", big, "b"]);
    await expect(promise).rejects.toBeInstanceOf(EmbeddingContextOverflowError);
    await expect(promise).rejects.toMatchObject({ inputLength: 500 });

    // Batch bisection isolates the input, but no shortened prefix is sent.
    const lone = calls.filter((c) => c.length === 1 && c[0].startsWith("x"));
    expect(lone).toHaveLength(1);
    expect(lone[0][0]).toBe(big);
  });
});
