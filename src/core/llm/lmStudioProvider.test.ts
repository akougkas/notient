import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LMStudioProvider } from "./lmStudioProvider";
import type { JsonSchema } from "./provider";

let originalFetch: typeof fetch;
let calls: Array<{ url: string; init: RequestInit | undefined }>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
}

describe("LMStudioProvider", () => {
  test("isAvailable returns true on 200", async () => {
    mockFetch(() => new Response("{}", { status: 200 }));
    const p = new LMStudioProvider({ baseUrl: "http://x/v1" });
    expect(await p.isAvailable()).toBe(true);
  });

  test("isAvailable returns false on network error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const p = new LMStudioProvider({ baseUrl: "http://x/v1" });
    expect(await p.isAvailable()).toBe(false);
  });

  test("chat returns assistant content", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "hello world" } }] }), {
          status: 200,
        }),
    );
    const p = new LMStudioProvider({ baseUrl: "http://x/v1" });
    const out = await p.chat([{ role: "user", content: "hi" }], { model: "m" });
    expect(out).toBe("hello world");
    expect(calls[0].url).toBe("http://x/v1/chat/completions");
  });

  test("embed returns vectors", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] }),
          { status: 200 },
        ),
    );
    const p = new LMStudioProvider({ baseUrl: "http://x/v1" });
    const v = await p.embed(["a", "b"], { model: "e" });
    expect(v).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
  });

  test("chatStream yields deltas from SSE stream", async () => {
    const sse = `data: ${JSON.stringify({
      choices: [{ delta: { content: "hel" } }],
    })}\ndata: ${JSON.stringify({
      choices: [{ delta: { content: "lo" } }],
    })}\ndata: [DONE]\n`;
    mockFetch(() => new Response(sse, { status: 200 }));
    const p = new LMStudioProvider({ baseUrl: "http://x/v1" });
    const chunks: string[] = [];
    for await (const c of p.chatStream([{ role: "user", content: "hi" }], { model: "m" })) {
      chunks.push(c);
    }
    expect(chunks.join("")).toBe("hello");
  });

  test("chatStream falls back to reasoning_content deltas when content is empty", async () => {
    const sse = `data: ${JSON.stringify({
      choices: [{ delta: { content: "", reasoning_content: "let me think" } }],
    })}\ndata: ${JSON.stringify({
      choices: [{ delta: { reasoning_content: " step by step" } }],
    })}\ndata: [DONE]\n`;
    mockFetch(() => new Response(sse, { status: 200 }));
    const p = new LMStudioProvider({ baseUrl: "http://x/v1" });
    const chunks: string[] = [];
    for await (const c of p.chatStream([{ role: "user", content: "hi" }], { model: "m" })) {
      chunks.push(c);
    }
    expect(chunks.join("")).toBe("let me think step by step");
  });

  test("chatStream rejects and cancels the SSE reader when aborted during a pending read", async () => {
    const encoder = new TextEncoder();
    let cancelCalled = false;
    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount++;
        if (pullCount === 1) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: "first" } }] })}\n`,
            ),
          );
        }
      },
      cancel() {
        cancelCalled = true;
      },
    });
    mockFetch(() => new Response(stream, { status: 200 }));
    const controller = new AbortController();
    const p = new LMStudioProvider({ baseUrl: "http://x/v1" });
    const iterator = p
      .chatStream([{ role: "user", content: "hi" }], {
        model: "m",
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first).toEqual({ value: "first", done: false });
    const pending = iterator.next();
    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
    expect(cancelCalled).toBe(true);
  });

  test("chat throws on non-OK response", async () => {
    mockFetch(() => new Response("bad", { status: 500 }));
    const p = new LMStudioProvider({ baseUrl: "http://x/v1" });
    await expect(p.chat([{ role: "user", content: "x" }], { model: "m" })).rejects.toThrow(/500/);
  });
});

describe("LMStudioProvider chatJson", () => {
  test("chatJson returns parsed object", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: '{"entities":["X","Y"],"claims":[],"questions":[]}' } },
            ],
          }),
          { status: 200 },
        ),
    );
    const schema: JsonSchema = {
      name: "Extraction",
      schema: {
        type: "object",
        properties: {
          entities: { type: "array", items: { type: "string" } },
          claims: { type: "array", items: { type: "string" } },
          questions: { type: "array", items: { type: "string" } },
        },
        required: ["entities", "claims", "questions"],
      },
    };
    const provider = new LMStudioProvider({ baseUrl: "http://x/v1" });
    const result = await provider.chatJson<{
      entities: string[];
      claims: string[];
      questions: string[];
    }>([{ role: "user", content: "hi" }], { model: "m" }, schema);
    expect(result).toEqual({ entities: ["X", "Y"], claims: [], questions: [] });
    const sent = JSON.parse(calls[0].init?.body as string);
    expect(sent.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "Extraction", strict: true, schema: schema.schema },
    });
  });

  test("chatJson throws on invalid JSON", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "not json at all" } }] }), {
          status: 200,
        }),
    );
    const provider = new LMStudioProvider({ baseUrl: "http://x/v1" });
    await expect(
      provider.chatJson(
        [{ role: "user", content: "hi" }],
        { model: "m" },
        { name: "S", schema: { type: "object" } },
      ),
    ).rejects.toThrow(/JSON/);
  });

  test("chatJson strips ```json fences if present", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '```json\n{"ok":true}\n```' } }],
          }),
          { status: 200 },
        ),
    );
    const provider = new LMStudioProvider({ baseUrl: "http://x/v1" });
    const result = await provider.chatJson<{ ok: boolean }>(
      [{ role: "user", content: "hi" }],
      { model: "m" },
      { name: "S", schema: { type: "object" } },
    );
    expect(result).toEqual({ ok: true });
  });

  test("chatJson falls back to reasoning_content when content is empty", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  reasoning_content: '{"ok":true,"path":"reasoning"}',
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const provider = new LMStudioProvider({ baseUrl: "http://x/v1" });
    const result = await provider.chatJson<{ ok: boolean; path: string }>(
      [{ role: "user", content: "hi" }],
      { model: "m" },
      { name: "S", schema: { type: "object" } },
    );
    expect(result).toEqual({ ok: true, path: "reasoning" });
  });
});

describe("LMStudioProvider chatWithTools", () => {
  test("sends response_format when responseSchema is provided", async () => {
    mockFetch(() => new Response("data: [DONE]\n", { status: 200 }));
    const schema: JsonSchema = {
      name: "agent_ask_response",
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
    };
    const provider = new LMStudioProvider({ baseUrl: "http://x/v1" });
    await provider.chatWithTools({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      signal: new AbortController().signal,
      responseSchema: schema,
    });

    const sent = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(sent.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: schema.name, strict: true, schema: schema.schema },
    });
  });

  test("falls back to reasoning_content when no tool calls and content is empty", async () => {
    const sse = `data: ${JSON.stringify({
      choices: [{ delta: { reasoning_content: "thinking out loud" } }],
    })}\ndata: ${JSON.stringify({
      choices: [{ delta: { reasoning_content: " about your question" } }],
    })}\ndata: [DONE]\n`;
    mockFetch(() => new Response(sse, { status: 200 }));
    const provider = new LMStudioProvider({ baseUrl: "http://x/v1" });
    const handle = await provider.chatWithTools({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      signal: new AbortController().signal,
    });
    for await (const _event of handle.events) {
      // drain
    }
    const result = await handle.result();
    expect(result.toolCalls).toEqual([]);
    expect(result.reasoningContent).toBe("thinking out loud about your question");
    expect(result.content).toBe("thinking out loud about your question");
  });

  test("does not clobber non-empty content with reasoning_content", async () => {
    const sse = `data: ${JSON.stringify({
      choices: [{ delta: { content: "real answer", reasoning_content: "scratchpad" } }],
    })}\ndata: [DONE]\n`;
    mockFetch(() => new Response(sse, { status: 200 }));
    const provider = new LMStudioProvider({ baseUrl: "http://x/v1" });
    const handle = await provider.chatWithTools({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      signal: new AbortController().signal,
    });
    for await (const _event of handle.events) {
      // drain
    }
    const result = await handle.result();
    expect(result.content).toBe("real answer");
    expect(result.reasoningContent).toBe("scratchpad");
  });

  test("rejects on non-OK response", async () => {
    mockFetch(() => new Response("nope", { status: 500 }));
    const provider = new LMStudioProvider({ baseUrl: "http://x/v1" });
    await expect(
      provider.chatWithTools({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/500/);
  });
});
