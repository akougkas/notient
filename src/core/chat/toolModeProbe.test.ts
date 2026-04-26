import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  ChatOptions,
  ChatWithToolsHandle,
  ChatWithToolsRequest,
  ChatWithToolsResult,
  EmbedOptions,
  JsonSchema,
  LLMProvider,
} from "../llm/provider";
import { probeToolMode, tryParseToolJson } from "./toolModeProbe";
import type { ToolMode } from "./toolModeProbe";

interface ProbeOutcome {
  result: ChatWithToolsResult;
  /** When true the probe call throws instead of returning. */
  fail?: boolean;
}

class StubProvider implements LLMProvider {
  public calls = 0;
  constructor(private readonly outcomes: ProbeOutcome[]) {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async chat(_messages: ChatMessage[], _opts: ChatOptions): Promise<string> {
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
    const callIndex = this.calls;
    this.calls += 1;
    const outcome = this.outcomes[callIndex] ?? this.outcomes[this.outcomes.length - 1];
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

describe("tryParseToolJson", () => {
  test("parses {tool, args} JSON", () => {
    expect(tryParseToolJson('{"tool":"echo","args":{"value":"ping"}}')).toEqual({
      tool: "echo",
      args: { value: "ping" },
    });
  });

  test("strips ```json fences", () => {
    const wrapped = '```json\n{"tool":"echo","args":{}}\n```';
    expect(tryParseToolJson(wrapped)).toEqual({ tool: "echo", args: {} });
  });

  test("returns args={} when args is missing", () => {
    expect(tryParseToolJson('{"tool":"echo"}')).toEqual({ tool: "echo", args: {} });
  });

  test("returns null for plain prose", () => {
    expect(tryParseToolJson("I do not call tools.")).toBeNull();
  });

  test("returns null when tool field is missing", () => {
    expect(tryParseToolJson('{"value":"ping"}')).toBeNull();
  });
});

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
      model: "Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M",
      signal: new AbortController().signal,
      cache: cache.cache,
    });
    expect(mode).toBe("native");
    expect(cache.writes).toEqual([
      { model: "Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M", mode: "native" },
    ]);
  });

  test("returns json-fallback when content carries a {tool, args} JSON object", async () => {
    const provider = new StubProvider([
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
    });
    expect(mode).toBe("json-fallback");
    expect(cache.store["json-only"]).toBe("json-fallback");
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
          toolCalls: [{ id: "c", name: "echo", args: {} }],
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
    });
    expect(mode).toBe("native");
    expect(provider.calls).toBe(2);
  });

  test("returns disabled when the provider throws on both attempts", async () => {
    const provider = new StubProvider([{ fail: true, result: blankResult() }]);
    const cache = makeCache();
    const mode = await probeToolMode({
      provider,
      model: "throws",
      signal: new AbortController().signal,
      cache: cache.cache,
      retryTimeoutMs: 50,
    });
    expect(mode).toBe("disabled");
    expect(cache.store.throws).toBe("disabled");
  });

  test("provider throwing on both attempts writes cache EXACTLY ONCE", async () => {
    // Hardening: regression guard against double-writing the disabled cache
    // entry (or skipping it). The probe must call the provider twice (first
    // attempt + one retry) and persist `disabled` exactly once.
    const provider = new StubProvider([
      { fail: true, result: blankResult() },
      { fail: true, result: blankResult() },
    ]);
    const cache = makeCache();
    const mode = await probeToolMode({
      provider,
      model: "double-throws",
      signal: new AbortController().signal,
      cache: cache.cache,
      retryTimeoutMs: 50,
    });
    expect(mode).toBe("disabled");
    expect(provider.calls).toBe(2);
    expect(cache.writes).toEqual([{ model: "double-throws", mode: "disabled" }]);
    expect(cache.writes).toHaveLength(1);
  });

  test("uses cached value without invoking the provider", async () => {
    const provider = new StubProvider([{ result: blankResult() }]);
    const cache = makeCache({ cached: "native" });
    const mode = await probeToolMode({
      provider,
      model: "cached",
      signal: new AbortController().signal,
      cache: cache.cache,
    });
    expect(mode).toBe("native");
    expect(provider.calls).toBe(0);
    expect(cache.writes).toEqual([]);
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
          toolCalls: [{ id: "c", name: "echo", args: {} }],
        },
      },
    ]);
    const cache = makeCache({ "nemotron-cascade-2-30b-a3b-i1-q4_k_m": "json-fallback" });
    const mode = await probeToolMode({
      provider,
      model: "Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M",
      signal: new AbortController().signal,
      cache: cache.cache,
    });
    expect(mode).toBe("native");
    expect(cache.store["Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M"]).toBe("native");
    expect(cache.store["nemotron-cascade-2-30b-a3b-i1-q4_k_m"]).toBe("json-fallback");
  });
});

function blankResult(): ChatWithToolsResult {
  return { content: "", reasoningContent: "", toolCalls: [] };
}
