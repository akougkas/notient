import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LMStudioProvider } from "../../../../src/core/llm/lmStudioProvider";

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

describe("LMStudioProvider.chatVision", () => {
  test("posts multipart content and returns the assistant string", async () => {
    mockFetch((_url, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const userMessage = body.messages.find(
        (message: { role: string }) => message.role === "user",
      );
      expect(Array.isArray(userMessage.content)).toBe(true);
      expect(userMessage.content[0].type).toBe("text");
      expect(userMessage.content[1].type).toBe("image_url");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "a cat sitting on a fence" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const provider = new LMStudioProvider({ baseUrl: "http://x/v1" });
    const result = await provider.chatVision({
      model: "qwen2.5-vl",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this image" },
            { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
          ],
        },
      ],
    });
    expect(result.content).toBe("a cat sitting on a fence");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(calls[0].url).toBe("http://x/v1/chat/completions");
    const sent = JSON.parse(calls[0].init?.body as string);
    expect(sent.max_tokens).toBeUndefined();
  });

  test("throws when the server returns 4xx", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: "model does not support vision" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    const provider = new LMStudioProvider({ baseUrl: "http://x/v1" });
    let thrown: unknown = null;
    try {
      await provider.chatVision({
        model: "text-only-model",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "x" },
              { type: "image_url", image_url: { url: "data:..." } },
            ],
          },
        ],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("vision");
  });
});
