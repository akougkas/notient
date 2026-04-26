import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LMStudioProvider } from "./lmStudioProvider";

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

  test("chat throws on non-OK response", async () => {
    mockFetch(() => new Response("bad", { status: 500 }));
    const p = new LMStudioProvider({ baseUrl: "http://x/v1" });
    await expect(p.chat([{ role: "user", content: "x" }], { model: "m" })).rejects.toThrow(/500/);
  });
});
