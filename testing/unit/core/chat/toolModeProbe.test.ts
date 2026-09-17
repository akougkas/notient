import { describe, expect, test } from "bun:test";
import { probeToolMode } from "../../../../src/core/chat/toolModeProbe";
import type { ToolMode } from "../../../../src/core/chat/toolModeProbe";
import { EventBus } from "../../../../src/core/events/eventBus";
import type { EventOf } from "../../../../src/core/events/types";
import {
  IncompleteCompletionError,
  completionMetadata,
  decodeUsage,
} from "../../../../src/core/llm/completion";
import type {
  ChatMessage,
  ChatOptions,
  ChatWithToolsHandle,
  ChatWithToolsRequest,
  ChatWithToolsResult,
  EmbedOptions,
  JsonSchema,
  LLMProvider,
} from "../../../../src/core/llm/provider";

interface ProbeOutcome {
  result: ChatWithToolsResult;
  /** When true the probe call throws instead of returning. */
  fail?: boolean;
  error?: Error;
}

class StubProvider implements LLMProvider {
  public calls = 0;
  public ceilings: number[] = [];
  public chatCalls = 0;
  /** When true the warmup chat() call throws so the probe sees a cold start. */
  public warmupFails = false;
  constructor(private readonly outcomes: ProbeOutcome[]) {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async chat(_messages: ChatMessage[], _opts: ChatOptions): Promise<string> {
    this.chatCalls += 1;
    if (this.warmupFails) throw new Error("warmup simulated failure");
    return "";
  }
  async *chatStream(_messages: ChatMessage[], _opts: ChatOptions): AsyncIterable<string> {
    yield "";
  }
  async chatJson<T>(_messages: ChatMessage[], _opts: ChatOptions, _schema: JsonSchema): Promise<T> {
    return {} as T;
  }
  async embed(_input: string[], _opts: EmbedOptions): Promise<number[][]> {
    return [];
  }
  async chatWithTools(_request: ChatWithToolsRequest): Promise<ChatWithToolsHandle> {
    this.ceilings.push(_request.maxTokens ?? 0);
    const callIndex = this.calls;
    this.calls += 1;
    const outcome = this.outcomes[callIndex] ?? this.outcomes[this.outcomes.length - 1];
    if (outcome.error) throw outcome.error;
    if (outcome.fail) throw new Error("probe simulated failure");
    return {
      events: emptyEvents(),
      result: async () => outcome.result,
    };
  }
}

async function* emptyEvents(): AsyncIterable<never> {
  // No deltas needed; aggregator state is supplied via outcome.result.
}

function makeCache(initial: Record<string, ToolMode> = {}): {
  store: Record<string, ToolMode>;
  cache: {
    read: (model: string) => ToolMode | null;
    write: (model: string, mode: ToolMode) => Promise<void>;
  };
  writes: { model: string; mode: ToolMode }[];
} {
  const store = { ...initial };
  const writes: { model: string; mode: ToolMode }[] = [];
  return {
    store,
    writes,
    cache: {
      read: (model) => store[model] ?? null,
      write: async (model, mode) => {
        store[model] = mode;
        writes.push({ model, mode });
      },
    },
  };
}

describe("probeToolMode", () => {
  test("returns native when the model emits tool_calls and caches the result", async () => {
    const provider = new StubProvider([
      {
        result: {
          content: "",
          reasoningContent: "",
          toolCalls: [{ id: "c", name: "echo", args: { value: "ping" } }],
        },
      },
    ]);
    const cache = makeCache();
    const mode = await probeToolMode({
      provider,
      model: "Test-Model-Mixed-Case",
      signal: new AbortController().signal,
      cache: cache.cache,

      bus: new EventBus(),
    });
    expect(mode).toBe("native");
    expect(cache.writes).toEqual([{ model: "Test-Model-Mixed-Case", mode: "native" }]);
  });

  test("classifies JSON-in-prose tool narration as disabled", async () => {
    const provider = new StubProvider([
      {
        result: {
          content: '{"tool":"echo","args":{"value":"ping"}}',
          reasoningContent: "",
          toolCalls: [],
        },
      },
      {
        result: {
          content: '{"tool":"echo","args":{"value":"ping"}}',
          reasoningContent: "",
          toolCalls: [],
        },
      },
    ]);
    const cache = makeCache();
    const mode = await probeToolMode({
      provider,
      model: "json-only",
      signal: new AbortController().signal,
      cache: cache.cache,
      retryTimeoutMs: 50,

      bus: new EventBus(),
    });
    expect(mode).toBe("disabled");
    expect(cache.store["json-only"]).toBe("disabled");
  });

  test("retries once before locking disabled and respects the retry timeout option", async () => {
    const provider = new StubProvider([
      { result: { content: "no tools", reasoningContent: "", toolCalls: [] } },
      { result: { content: "no tools either", reasoningContent: "", toolCalls: [] } },
    ]);
    const cache = makeCache();
    const mode = await probeToolMode({
      provider,
      model: "broken",
      signal: new AbortController().signal,
      cache: cache.cache,
      retryTimeoutMs: 50,

      bus: new EventBus(),
    });
    expect(mode).toBe("disabled");
    expect(provider.calls).toBe(2);
    expect(cache.writes).toEqual([{ model: "broken", mode: "disabled" }]);
  });

  test("retry path can upgrade an initial disabled to native", async () => {
    const provider = new StubProvider([
      { result: { content: "blank", reasoningContent: "", toolCalls: [] } },
      {
        result: {
          content: "",
          reasoningContent: "",
          toolCalls: [{ id: "c", name: "echo", args: { value: "ping" } }],
        },
      },
    ]);
    const cache = makeCache();
    const mode = await probeToolMode({
      provider,
      model: "slow-loader",
      signal: new AbortController().signal,
      cache: cache.cache,
      retryTimeoutMs: 50,

      bus: new EventBus(),
    });
    expect(mode).toBe("native");
    expect(provider.calls).toBe(2);
  });

  test("an outage remains retryable and does not poison the capability cache", async () => {
    const provider = new StubProvider([{ fail: true, result: blankResult() }]);
    const cache = makeCache();
    await expect(
      probeToolMode({
        provider,
        model: "offline",
        signal: new AbortController().signal,
        cache: cache.cache,
        bus: new EventBus(),
      }),
    ).rejects.toThrow("probe simulated failure");
    expect(provider.calls).toBe(1);
    expect(cache.writes).toEqual([]);
  });
  test("one bounded recovery gives truncated reasoning room to emit a real call", async () => {
    const error = new IncompleteCompletionError(
      "reasoning exhausted the ceiling",
      completionMetadata(
        "length",
        decodeUsage({
          completion_tokens: 4096,
          completion_tokens_details: { reasoning_tokens: 4096 },
        }),
      ),
    );
    const provider = new StubProvider([
      { error, result: blankResult() },
      {
        result: {
          ...blankResult(),
          toolCalls: [{ id: "echo-1", name: "echo", args: { value: "ping" } }],
        },
      },
    ]);
    const cache = makeCache();
    expect(
      await probeToolMode({
        provider,
        model: "reasoning",
        signal: new AbortController().signal,
        cache: cache.cache,
        bus: new EventBus(),
      }),
    ).toBe("native");
    expect(provider.ceilings).toEqual([4096, 8192]);
    expect(provider.chatCalls).toBe(0);
    const unfinished = new StubProvider([{ error, result: blankResult() }]);
    const failedCache = makeCache();
    await expect(
      probeToolMode({
        provider: unfinished,
        model: "reasoning",
        signal: new AbortController().signal,
        cache: failedCache.cache,
        bus: new EventBus(),
      }),
    ).rejects.toBe(error);
    expect(unfinished.calls).toBe(2);
    expect(failedCache.writes).toEqual([]);
  });

  test("uses cached value without invoking the provider", async () => {
    const provider = new StubProvider([{ result: blankResult() }]);
    const cache = makeCache({ cached: "native" });
    const mode = await probeToolMode({
      provider,
      model: "cached",
      signal: new AbortController().signal,
      cache: cache.cache,

      bus: new EventBus(),
    });
    expect(mode).toBe("native");
    expect(provider.calls).toBe(0);
    expect(cache.writes).toEqual([]);
  });

  test("probes tools directly without wasting a separate warmup generation", async () => {
    const provider = new StubProvider([
      {
        result: {
          content: "",
          reasoningContent: "",
          toolCalls: [{ id: "c", name: "echo", args: { value: "ping" } }],
        },
      },
    ]);
    const cache = makeCache();
    const mode = await probeToolMode({
      provider,
      model: "cold-start",
      signal: new AbortController().signal,
      cache: cache.cache,

      bus: new EventBus(),
    });
    expect(mode).toBe("native");
    expect(provider.chatCalls).toBe(0);
    expect(provider.calls).toBe(1);
  });

  test("a provider without ordinary chat can still prove native tool support", async () => {
    const provider = new StubProvider([
      {
        result: {
          content: "",
          reasoningContent: "",
          toolCalls: [{ id: "c", name: "echo", args: { value: "ping" } }],
        },
      },
    ]);
    provider.warmupFails = true;
    const cache = makeCache();
    const mode = await probeToolMode({
      provider,
      model: "warmup-rejects",
      signal: new AbortController().signal,
      cache: cache.cache,

      bus: new EventBus(),
    });
    expect(mode).toBe("native");
    expect(provider.chatCalls).toBe(0);
    expect(provider.calls).toBe(1);
  });

  test("warmup is skipped when the cache already has a pinned mode", async () => {
    const provider = new StubProvider([{ result: blankResult() }]);
    const cache = makeCache({ "warm-cache": "native" });
    await probeToolMode({
      provider,
      model: "warm-cache",
      signal: new AbortController().signal,
      cache: cache.cache,

      bus: new EventBus(),
    });
    expect(provider.chatCalls).toBe(0);
    expect(provider.calls).toBe(0);
  });

  test("propagates AbortError without poisoning the cache as disabled", async () => {
    const provider: LLMProvider = {
      isAvailable: async () => true,
      chat: async () => "",
      chatStream: async function* () {
        yield "";
      },
      embed: async () => [],
      chatJson: async <T>() => ({}) as T,
      chatWithTools: async () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    };
    const cache = makeCache();
    const controller = new AbortController();
    controller.abort();
    await expect(
      probeToolMode({
        provider,
        model: "abort-mid-probe",
        signal: controller.signal,
        cache: cache.cache,
        retryTimeoutMs: 50,

        bus: new EventBus(),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cache.writes).toEqual([]);
    expect(cache.store["abort-mid-probe"]).toBeUndefined();
  });

  test("cache key is case-sensitive (exact model id)", async () => {
    const provider = new StubProvider([
      {
        result: {
          content: "",
          reasoningContent: "",
          toolCalls: [{ id: "c", name: "echo", args: { value: "ping" } }],
        },
      },
    ]);
    const cache = makeCache({ "test-model-mixed-case": "disabled" });
    const mode = await probeToolMode({
      provider,
      model: "Test-Model-Mixed-Case",
      signal: new AbortController().signal,
      cache: cache.cache,

      bus: new EventBus(),
    });
    expect(mode).toBe("native");
    expect(cache.store["Test-Model-Mixed-Case"]).toBe("native");
    expect(cache.store["test-model-mixed-case"]).toBe("disabled");
  });

  test("returns native after the second attempt yields a parseable tool call", async () => {
    const provider = new StubProvider([
      { result: { content: "no tools", reasoningContent: "", toolCalls: [] } },
      {
        result: {
          content: "",
          reasoningContent: "",
          toolCalls: [{ id: "c", name: "echo", args: { value: "ping" } }],
        },
      },
    ]);
    const cache = makeCache();
    const mode = await probeToolMode({
      provider,
      model: "test",
      signal: new AbortController().signal,
      cache: cache.cache,
      retryTimeoutMs: 50,

      bus: new EventBus(),
    });
    expect(mode).toBe("native");
    expect(provider.calls).toBe(2);
  });

  test("returns disabled when both attempts yield no tool calls", async () => {
    const provider = new StubProvider([
      { result: { content: "blank", reasoningContent: "", toolCalls: [] } },
      { result: { content: "blank again", reasoningContent: "", toolCalls: [] } },
    ]);
    const cache = makeCache();
    const mode = await probeToolMode({
      provider,
      model: "no-calls",
      signal: new AbortController().signal,
      cache: cache.cache,
      retryTimeoutMs: 50,

      bus: new EventBus(),
    });
    expect(mode).toBe("disabled");
  });

  test("returns disabled when the second attempt yields a tool call with empty args (malformed)", async () => {
    const provider = new StubProvider([
      { result: { content: "blank", reasoningContent: "", toolCalls: [] } },
      {
        result: {
          content: "",
          reasoningContent: "",
          toolCalls: [{ id: "c", name: "echo", args: {} }],
        },
      },
    ]);
    const cache = makeCache();
    const mode = await probeToolMode({
      provider,
      model: "malformed",
      signal: new AbortController().signal,
      cache: cache.cache,
      retryTimeoutMs: 50,

      bus: new EventBus(),
    });
    expect(mode).toBe("disabled");
  });

  test("emits loop:tool_mode_probed with attempts count on classification", async () => {
    const provider = new StubProvider([
      {
        result: {
          content: "",
          reasoningContent: "",
          toolCalls: [{ id: "c", name: "echo", args: { value: "ping" } }],
        },
      },
    ]);
    const bus = new EventBus();
    const events: EventOf<"loop:tool_mode_probed">[] = [];
    bus.on("loop:tool_mode_probed", (event) => {
      events.push(event);
    });
    const cache = makeCache();
    await probeToolMode({
      provider,
      model: "first-pass",
      signal: new AbortController().signal,
      cache: cache.cache,
      bus,
    });
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({
      type: "loop:tool_mode_probed",
      model: "first-pass",
      mode: "native",
      attempts: 1,
    });
  });
});

function blankResult(): ChatWithToolsResult {
  return { content: "", reasoningContent: "", toolCalls: [] };
}
