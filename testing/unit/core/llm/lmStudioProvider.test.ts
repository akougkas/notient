import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { NoteApiError } from "../../../../src/api/schema";
import { LMStudioProvider } from "../../../../src/core/llm/lmStudioProvider";
import type { JsonSchema } from "../../../../src/core/llm/provider";

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
  test("credential redaction preserves the domain failure code for an aborted budget", async () => {
    mockFetch(() => {
      throw new NoteApiError("LIMIT_EXCEEDED", "Budget exhausted for sk-private_123");
    });
    const provider = new LMStudioProvider({
      baseUrl: "http://localhost/v1",
      apiKey: "sk-private_123",
    });
    let caught: unknown;
    try {
      await provider.chatJson([], { model: "test" }, { name: "test", schema: { type: "object" } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NoteApiError);
    expect(caught).toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(String(caught)).not.toContain("sk-private_123");
  });
  test("structured HTTP rejections retain a bounded redacted diagnostic and a retry classification", async () => {
    mockFetch(() =>
      Response.json({ error: { message: "Invalid schema with sk-private_123" } }, { status: 400 }),
    );
    const provider = new LMStudioProvider({
      baseUrl: "http://localhost/v1",
      apiKey: "sk-private_123",
    });
    let caught: unknown;
    try {
      await provider.chatJson([], { model: "test" }, { name: "test", schema: { type: "object" } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ status: 400, retryable: false });
    expect(String(caught)).toContain("Invalid schema");
    expect(String(caught)).not.toContain("sk-private_123");
  });
  test("sends one bearer credential on health, chat, stream, embedding, tools, vision, and JSON requests", async () => {
    mockFetch((_url, init) => {
      if (init?.method !== "POST") return new Response("{}", { status: 200 });
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (Object.hasOwn(body, "input")) {
        return Response.json({ data: [{ index: 0, embedding: [0.1, 0.2] }] });
      }
      if (body.stream === true)
        return new Response(
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { status: 200 },
        );
      const content = Object.hasOwn(body, "response_format") ? "{}" : "ok";
      return Response.json({ choices: [{ finish_reason: "stop", message: { content } }] });
    });
    const provider = new LMStudioProvider({
      baseUrl: "https://compatible.example/v1",
      apiKey: "sk-private_123",
    });

    expect(await provider.isAvailable()).toBe(true);
    await provider.chat([{ role: "user", content: "chat" }], { model: "m" });
    for await (const _delta of provider.chatStream([{ role: "user", content: "stream" }], {
      model: "m",
    })) {
      // The fixture intentionally emits no content before [DONE].
    }
    await provider.embed(["embed"], { model: "e" });
    const toolHandle = await provider.chatWithTools({
      model: "m",
      messages: [{ role: "user", content: "tools" }],
      tools: [],
      signal: new AbortController().signal,
    });
    for await (const _event of toolHandle.events) {
      // The fixture intentionally emits no content before [DONE].
    }
    await toolHandle.result();
    await provider.chatVision({
      model: "m",
      messages: [{ role: "user", content: "vision" }],
    });
    await provider.chatJson(
      [{ role: "user", content: "json" }],
      { model: "m" },
      {
        name: "answer",
        schema: { type: "object" },
      },
    );

    expect(calls).toHaveLength(7);
    for (const call of calls) {
      expect(new Headers(call.init?.headers).get("authorization")).toBe("Bearer sk-private_123");
      if (call.init?.method === "POST") {
        expect(new Headers(call.init.headers).get("content-type")).toBe("application/json");
      }
    }
  });

  test("rejects malformed provider credentials without exposing them", () => {
    const malformed = "secret with spaces";
    expect(
      () =>
        new LMStudioProvider({
          baseUrl: "https://compatible.example/v1",
          apiKey: malformed,
        }),
    ).toThrow("provider apiKey");
    try {
      new LMStudioProvider({
        baseUrl: "https://compatible.example/v1",
        apiKey: malformed,
      });
    } catch (error) {
      expect((error as Error).message).not.toContain(malformed);
    }
  });

  test("redacts a credential echoed by an endpoint error body", async () => {
    mockFetch(() => new Response("credential=sk-private_123", { status: 401 }));
    const provider = new LMStudioProvider({
      baseUrl: "https://compatible.example/v1",
      apiKey: "sk-private_123",
    });
    let thrown: unknown;
    try {
      await provider.embed(["x"], { model: "e" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/redacted|configured provider credential/);
    expect((thrown as Error).message).not.toContain("sk-private_123");
  });

  test("rejects a credential echoed inside malformed structured output", async () => {
    mockFetch(() =>
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "not-json sk-private_123" } }],
      }),
    );
    const provider = new LMStudioProvider({
      baseUrl: "https://compatible.example/v1",
      apiKey: "sk-private_123",
    });

    let thrown: unknown;
    try {
      await provider.chatJson(
        [{ role: "user", content: "json" }],
        { model: "m" },
        { name: "answer", schema: { type: "object" } },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("configured provider credential");
    expect(JSON.stringify(thrown)).not.toContain("sk-private_123");
  });

  test("redacts endpoint-controlled status text at every surfaced HTTP boundary", async () => {
    const token = "sk-status-private_123";
    const provider = new LMStudioProvider({
      baseUrl: "https://compatible.example/v1",
      apiKey: token,
    });
    const actions: Array<() => Promise<unknown>> = [
      () => provider.chat([{ role: "user", content: "x" }], { model: "m" }),
      async () => {
        for await (const _chunk of provider.chatStream([{ role: "user", content: "x" }], {
          model: "m",
        })) {
          // drain
        }
      },
      () => provider.embed(["x"], { model: "e" }),
      () =>
        provider.chatWithTools({
          model: "m",
          messages: [{ role: "user", content: "x" }],
          tools: [],
          signal: new AbortController().signal,
        }),
      () =>
        provider.chatVision({
          model: "m",
          messages: [{ role: "user", content: "x" }],
        }),
      () =>
        provider.chatJson(
          [{ role: "user", content: "x" }],
          { model: "m" },
          { name: "answer", schema: { type: "object" } },
        ),
    ];

    for (const action of actions) {
      mockFetch(
        () =>
          new Response(`body ${token}`, {
            status: 502,
            statusText: `endpoint echoed ${token}`,
          }),
      );
      let thrown: unknown;
      try {
        await action();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(String((thrown as Error).message)).toContain("[redacted]");
      expect(String((thrown as Error).stack)).not.toContain(token);
    }
  });

  test("redacts successful-response JSON parser failures before they escape", async () => {
    const token = "sk-json-private_123";
    const provider = new LMStudioProvider({
      baseUrl: "https://compatible.example/v1",
      apiKey: token,
    });
    const actions: Array<() => Promise<unknown>> = [
      () => provider.chat([{ role: "user", content: "x" }], { model: "m" }),
      () => provider.embed(["x"], { model: "e" }),
      () =>
        provider.chatVision({
          model: "m",
          messages: [{ role: "user", content: "x" }],
        }),
      () =>
        provider.chatJson(
          [{ role: "user", content: "x" }],
          { model: "m" },
          { name: "answer", schema: { type: "object" } },
        ),
    ];
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => {
          throw new SyntaxError(`invalid JSON near ${token}`);
        },
      }) as unknown as Response) as unknown as typeof fetch;

    for (const action of actions) {
      let thrown: unknown;
      try {
        await action();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("[redacted]");
      expect(String((thrown as Error).stack)).not.toContain(token);
    }
  });

  test("rejects a credential echoed by every successful non-stream response", async () => {
    const token = "sk-success-private_123";
    const provider = new LMStudioProvider({
      baseUrl: "https://compatible.example/v1",
      apiKey: token,
    });
    const cases: Array<{ payload: unknown; invoke: () => Promise<unknown> }> = [
      {
        payload: { choices: [{ finish_reason: "stop", message: { content: `answer ${token}` } }] },
        invoke: () => provider.chat([{ role: "user", content: "x" }], { model: "m" }),
      },
      {
        payload: { data: [{ embedding: [0.1, 0.2] }], endpointEcho: token },
        invoke: () => provider.embed(["x"], { model: "e" }),
      },
      {
        payload: { choices: [{ finish_reason: "stop", message: { content: `vision ${token}` } }] },
        invoke: () =>
          provider.chatVision({
            model: "m",
            messages: [{ role: "user", content: "x" }],
          }),
      },
      {
        payload: {
          choices: [
            { finish_reason: "stop", message: { content: JSON.stringify({ answer: token }) } },
          ],
        },
        invoke: () =>
          provider.chatJson(
            [{ role: "user", content: "x" }],
            { model: "m" },
            { name: "answer", schema: { type: "object" } },
          ),
      },
    ];

    for (const item of cases) {
      mockFetch(() => Response.json(item.payload));
      let thrown: unknown;
      try {
        await item.invoke();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("configured provider credential");
      expect(JSON.stringify(thrown)).not.toContain(token);
    }
  });

  test("writes opt-in LLM request diagnostics only inside a private directory", async () => {
    const previousDebug = process.env.NOTIENT_DEBUG_LLM;
    const originalWrite = process.stderr.write;
    let stderr = "";
    process.env.NOTIENT_DEBUG_LLM = "1";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stderr.write;
    mockFetch(() => new Response("failed", { status: 500 }));
    const provider = new LMStudioProvider({ baseUrl: "http://x/v1" });
    let directory: string | null = null;

    try {
      await expect(
        provider.chatWithTools({
          model: "m",
          messages: [{ role: "user", content: "private note body" }],
          tools: [],
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("LLM 500");
      const match = stderr.match(/request body dumped to (.+)\n/u);
      expect(match).not.toBeNull();
      const file = match?.[1];
      if (file === undefined) throw new Error("debug dump path missing");
      directory = dirname(file);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    } finally {
      process.stderr.write = originalWrite;
      if (previousDebug === undefined) Reflect.deleteProperty(process.env, "NOTIENT_DEBUG_LLM");
      else process.env.NOTIENT_DEBUG_LLM = previousDebug;
      if (directory !== null) await rm(directory, { recursive: true, force: true });
    }
  });

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
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: "hello world" } }],
          }),
          {
            status: 200,
          },
        ),
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
          JSON.stringify({
            data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
          }),
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

  test("embed reorders vectors by the OpenAI index field", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: [0.3, 0.4] },
              { index: 0, embedding: [0.1, 0.2] },
            ],
          }),
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

  test("embed throws when the response count does not match the input count", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
          status: 200,
        }),
    );
    const p = new LMStudioProvider({ baseUrl: "http://x/v1" });
    await expect(p.embed(["a", "b"], { model: "e" })).rejects.toThrow(/expected 2/);
  });

  test.each([
    [{ data: [{ index: 0, embedding: [0.1] }, { embedding: [0.2] }] }, "partial index"],
    [
      {
        data: [
          { index: 0, embedding: [0.1] },
          { index: 0, embedding: [0.2] },
        ],
      },
      "complete unique",
    ],
    [{ data: [{ embedding: [0.1] }, { embedding: [0.2, 0.3] }] }, "dimensions"],
    [{ data: [{ embedding: [Number.NaN] }, { embedding: [0.2] }] }, "non-finite"],
  ])("embed rejects malformed vector responses %#", async (payload, message) => {
    mockFetch(() => new Response(JSON.stringify(payload), { status: 200 }));
    const provider = new LMStudioProvider({ baseUrl: "http://x/v1" });
    await expect(provider.embed(["a", "b"], { model: "e" })).rejects.toThrow(message);
  });

  test("chatStream yields deltas from SSE stream", async () => {
    const sse = `data: ${JSON.stringify({
      choices: [{ delta: { content: "hel" } }],
    })}\n\ndata: ${JSON.stringify({
      choices: [{ delta: { content: "lo" } }],
    })}\n\ndata: ${JSON.stringify({
      choices: [{ delta: { content: null } }],
    })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
    mockFetch(() => new Response(sse, { status: 200 }));
    const p = new LMStudioProvider({ baseUrl: "http://x/v1" });
    const chunks: string[] = [];
    for await (const c of p.chatStream([{ role: "user", content: "hi" }], {
      model: "m",
    })) {
      chunks.push(c);
    }
    expect(chunks.join("")).toBe("hello");
  });

  test("SSE metadata, multiline data, CRLF and fragmented UTF-8 preserve the final answer", async () => {
    const sse =
      ': keepalive\r\nid: 42\r\nevent: message\r\nretry: 1000\r\ndata: {"choices":\r\ndata: [{"delta":{"reasoning_content":"private deliberation"}}]}\r\n\r\n' +
      'event: message\r\ndata: {"choices":[{"delta":{"content":"café"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n';
    const bytes = new TextEncoder().encode(sse);
    let offset = 0;
    mockFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (offset === bytes.length) controller.close();
              else controller.enqueue(bytes.slice(offset, ++offset));
            },
          }),
        ),
    );
    const provider = new LMStudioProvider({ baseUrl: "http://x/v1" });
    const handle = await provider.chatWithTools({
      model: "m",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    });
    const visible: string[] = [];
    for await (const event of handle.events)
      if (event.contentDelta) visible.push(event.contentDelta);
    expect(visible.join("")).toBe("café");
    expect((await handle.result()).reasoningContent).toBe("private deliberation");
  });

  test("named SSE error events report the provider failure without leaking credentials", async () => {
    mockFetch(
      () =>
        new Response(
          'event: error\ndata: {"error":{"message":"Context window exceeded sk-private_123"}}\n\n',
        ),
    );
    const provider = new LMStudioProvider({ baseUrl: "http://x/v1", apiKey: "sk-private_123" });
    const handle = await provider.chatWithTools({
      model: "m",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    });
    let failure: unknown;
    try {
      for await (const _event of handle.events) {
      }
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("Context window exceeded");
    expect((failure as Error).message).not.toContain("sk-private_123");
  });

  test("rejects a successful credential echo split across chat stream frames", async () => {
    const token = "stream-secret_123";
    const sse = `data: ${JSON.stringify({
      choices: [{ delta: { content: "before stream-" } }],
    })}\n\ndata: ${JSON.stringify({
      choices: [{ delta: { content: "secret_123 after" } }],
    })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
    mockFetch(() => new Response(sse, { status: 200 }));
    const provider = new LMStudioProvider({
      baseUrl: "http://x/v1",
      apiKey: token,
    });
    const chunks: string[] = [];
    let thrown: unknown;
    try {
      for await (const chunk of provider.chatStream([{ role: "user", content: "x" }], {
        model: "m",
      })) {
        chunks.push(chunk);
      }
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("configured provider credential");
    expect(chunks.join("")).not.toContain(token);
  });

  test("redacts a credential echoed by a successful streaming error frame", async () => {
    const sse = `data: ${JSON.stringify({ error: { message: "bad sk-private_123" } })}\n\n`;
    mockFetch(() => new Response(sse, { status: 200 }));
    const provider = new LMStudioProvider({
      baseUrl: "https://compatible.example/v1",
      apiKey: "sk-private_123",
    });
    let thrown: unknown;
    try {
      for await (const _delta of provider.chatStream([{ role: "user", content: "x" }], {
        model: "m",
      })) {
        // drain until the error frame
      }
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/redacted|configured provider credential/);
    expect((thrown as Error).message).not.toContain("sk-private_123");
  });

  test("chatStream rejects reasoning-only responses without emitting hidden text", async () => {
    const sse = `data: ${JSON.stringify({
      choices: [{ delta: { content: "", reasoning_content: "let me think" } }],
    })}\n\ndata: ${JSON.stringify({
      choices: [{ delta: { reasoning_content: " step by step" } }],
    })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
    mockFetch(() => new Response(sse, { status: 200 }));
    const p = new LMStudioProvider({ baseUrl: "http://x/v1" });
    const chunks: string[] = [];
    await expect(
      (async () => {
        for await (const c of p.chatStream([{ role: "user", content: "hi" }], { model: "m" }))
          chunks.push(c);
      })(),
    ).rejects.toThrow("incomplete");
    expect(chunks).toEqual([]);
  });

  test("chatStream rejects invalid JSON and an EOF without [DONE]", async () => {
    for (const sse of ["data: {nope}\n\n", 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n']) {
      mockFetch(() => new Response(sse, { status: 200 }));
      const provider = new LMStudioProvider({ baseUrl: "http://x/v1" });
      const drain = async (): Promise<void> => {
        for await (const _chunk of provider.chatStream([{ role: "user", content: "hi" }], {
          model: "m",
        })) {
          // drain
        }
      };
      await expect(drain()).rejects.toThrow(/invalid JSON|before \[DONE\]/);
    }
  });

  test("chat rejects a successful HTTP response without one assistant message", async () => {
    mockFetch(() => new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    const provider = new LMStudioProvider({ baseUrl: "http://x/v1" });
    await expect(provider.chat([{ role: "user", content: "x" }], { model: "m" })).rejects.toThrow(
      "choices envelope",
    );
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
              `data: ${JSON.stringify({ choices: [{ delta: { content: "first" } }] })}\n\n`,
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

    const pending = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 5));
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
              {
                finish_reason: "stop",
                message: {
                  content: '{"entities":["X","Y"],"claims":[],"questions":[]}',
                },
              },
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
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: "not json at all" } }],
          }),
          {
            status: 200,
          },
        ),
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

  test("chatJson rejects fenced compatibility output", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: '```json\n{"ok":true}\n```' } }],
          }),
          { status: 200 },
        ),
    );
    const provider = new LMStudioProvider({ baseUrl: "http://x/v1" });
    await expect(
      provider.chatJson<{ ok: boolean }>(
        [{ role: "user", content: "hi" }],
        { model: "m" },
        { name: "S", schema: { type: "object" } },
      ),
    ).rejects.toThrow("JSON");
  });

  test("chatJson refuses to reinterpret reasoning_content as the structured answer", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
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
    await expect(
      provider.chatJson<{ ok: boolean; path: string }>(
        [{ role: "user", content: "hi" }],
        { model: "m" },
        { name: "S", schema: { type: "object" } },
      ),
    ).rejects.toThrow("incomplete");
  });
});

describe("LMStudioProvider chatWithTools", () => {
  test("sends response_format when responseSchema is provided", async () => {
    mockFetch(
      () =>
        new Response(
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { status: 200 },
        ),
    );
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

  test("an error frame on the tool stream surfaces the server's message", async () => {
    const sse = `data: ${JSON.stringify({
      choices: [{ delta: { content: "partial" } }],
    })}\n\ndata: ${JSON.stringify({ error: { message: "Model unloaded", code: 503 } })}\n\n`;
    mockFetch(() => new Response(sse, { status: 200 }));
    const provider = new LMStudioProvider({ baseUrl: "http://x/v1" });
    const handle = await provider.chatWithTools({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      signal: new AbortController().signal,
    });
    let caught: unknown = null;
    try {
      for await (const _event of handle.events) {
        // drain until the error frame
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("Model unloaded");
    expect((caught as Error).message).not.toContain("undefined is not an object");
  });

  test("rejects split credential echoes in tool content, reasoning, and arguments", async () => {
    const token = "tool-secret_123";
    const fragments = [
      [
        { choices: [{ delta: { content: "tool-" } }] },
        { choices: [{ delta: { content: "secret_123" } }] },
      ],
      [
        { choices: [{ delta: { reasoning_content: "tool-" } }] },
        { choices: [{ delta: { reasoning_content: "secret_123" } }] },
      ],
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "vault.search_notes",
                      arguments: '{"query":"tool-',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: 'secret_123"}' } }],
              },
            },
          ],
        },
      ],
    ] as const;

    for (const frames of fragments) {
      const sse = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
      mockFetch(() => new Response(sse, { status: 200 }));
      const provider = new LMStudioProvider({
        baseUrl: "http://x/v1",
        apiKey: token,
      });
      const handle = await provider.chatWithTools({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        tools: [],
        signal: new AbortController().signal,
      });
      const emitted: unknown[] = [];
      let thrown: unknown;
      try {
        for await (const event of handle.events) emitted.push(event);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("configured provider credential");
      expect(JSON.stringify(emitted)).not.toContain(token);
    }
  });

  test("a frame without choices fails instead of disappearing", async () => {
    const sse = `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk" })}\n\ndata: ${JSON.stringify(
      {
        choices: [{ delta: { content: "ok" } }],
      },
    )}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
    mockFetch(() => new Response(sse, { status: 200 }));
    const provider = new LMStudioProvider({ baseUrl: "http://x/v1" });
    const handle = await provider.chatWithTools({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      signal: new AbortController().signal,
    });
    const drain = async (): Promise<void> => {
      for await (const _event of handle.events) {
        // drain
      }
    };
    await expect(drain()).rejects.toThrow("exactly one choice");
    await expect(handle.result()).rejects.toThrow("before [DONE]");
  });

  test("assembles one exact indexed tool call without synthetic ids or arguments", async () => {
    const first = {
      choices: [
        {
          delta: {
            content: null,
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: {
                  name: "vault.search_notes",
                  arguments: '{"query":',
                },
              },
            ],
          },
        },
      ],
    };
    const second = {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '"HDF5"}' } }],
          },
        },
      ],
    };
    mockFetch(
      () =>
        new Response(
          `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(second)}\n\ndata: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n`,
          {
            status: 200,
          },
        ),
    );
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
    expect(await handle.result()).toMatchObject({
      content: "",
      reasoningContent: "",
      toolCalls: [{ id: "call_1", name: "vault.search_notes", args: { query: "HDF5" } }],
    });
  });

  test("rejects missing tool indices and invalid final argument JSON", async () => {
    const cases = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "vault.search_notes", arguments: "{}" },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "vault.search_notes",
                    arguments: "not-json",
                  },
                },
              ],
            },
          },
        ],
      },
    ];
    for (const [index, frame] of cases.entries()) {
      mockFetch(
        () =>
          new Response(
            `data: ${JSON.stringify(frame)}\n\ndata: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n`,
            {
              status: 200,
            },
          ),
      );
      const provider = new LMStudioProvider({ baseUrl: "http://x/v1" });
      const handle = await provider.chatWithTools({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        signal: new AbortController().signal,
      });
      if (index === 0) {
        const drain = async (): Promise<void> => {
          for await (const _event of handle.events) {
            // drain
          }
        };
        await expect(drain()).rejects.toThrow("index is invalid");
      } else {
        await expect(
          (async () => {
            for await (const _event of handle.events) {
              /* drain */
            }
            await handle.result();
          })(),
        ).rejects.toThrow("invalid JSON");
      }
    }
  });

  test("rejects reasoning-only tool completion without promoting hidden content", async () => {
    const sse = `data: ${JSON.stringify({
      choices: [{ delta: { reasoning_content: "thinking out loud" } }],
    })}\n\ndata: ${JSON.stringify({
      choices: [{ delta: { reasoning_content: " about your question" } }],
    })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
    mockFetch(() => new Response(sse, { status: 200 }));
    const provider = new LMStudioProvider({ baseUrl: "http://x/v1" });
    const handle = await provider.chatWithTools({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      signal: new AbortController().signal,
    });
    const visible: string[] = [];
    await expect(
      (async () => {
        for await (const event of handle.events)
          if (event.contentDelta) visible.push(event.contentDelta);
        await handle.result();
      })(),
    ).rejects.toThrow("incomplete");
    expect(visible).toEqual([]);
  });

  test("does not clobber non-empty content with reasoning_content", async () => {
    const sse = `data: ${JSON.stringify({
      choices: [{ delta: { content: "real answer", reasoning_content: "scratchpad" } }],
    })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
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
