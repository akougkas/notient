import { describe, expect, test } from "bun:test";
import { runStartupProbe } from "../../../../src/core/services/startupProbe";

function fakeFetch(response: { ok?: boolean; status?: number; body?: unknown }) {
  return async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    if (response.ok === false) {
      return new Response("error", { status: response.status ?? 500 });
    }
    return new Response(JSON.stringify(response.body ?? {}), { status: 200 });
  };
}

describe("runStartupProbe", () => {
  test("ok when configured budget fits the loaded window", async () => {
    const result = await runStartupProbe({
      endpoint: "http://h:1/v1",
      modelId: "model-x",
      configuredContextTokens: 200000,
      fetchImpl: fakeFetch({
        body: { data: [{ id: "model-x", state: "loaded", loaded_context_length: 800000 }] },
      }),
    });
    expect(result.status).toBe("ok");
    expect(result.loadedContextLength).toBe(800000);
    expect(result.parallelSlots).toBe(1);
    expect(result.requestedTotalContextTokens).toBe(200000);
  });

  test("ok when four 200K slots fit an 800K loaded window", async () => {
    const result = await runStartupProbe({
      endpoint: "http://h:1/v1",
      modelId: "model-x",
      configuredContextTokens: 200000,
      parallelSlots: 4,
      fetchImpl: fakeFetch({
        body: { data: [{ id: "model-x", state: "loaded", loaded_context_length: 800000 }] },
      }),
    });
    expect(result.status).toBe("ok");
    expect(result.parallelSlots).toBe(4);
    expect(result.requestedTotalContextTokens).toBe(800000);
  });

  test("loaded-too-small when configured exceeds loaded window", async () => {
    const result = await runStartupProbe({
      endpoint: "http://h:1/v1",
      modelId: "model-x",
      configuredContextTokens: 1_000_000,
      fetchImpl: fakeFetch({
        body: { data: [{ id: "model-x", state: "loaded", loaded_context_length: 200000 }] },
      }),
    });
    expect(result.status).toBe("loaded-too-small");
    expect(result.loadedContextLength).toBe(200000);
    expect(result.message).toContain("1,000,000");
    expect(result.message).toContain("200,000");
  });

  test("loaded-too-small when total slot budget exceeds loaded window", async () => {
    const result = await runStartupProbe({
      endpoint: "http://h:1/v1",
      modelId: "model-x",
      configuredContextTokens: 200000,
      parallelSlots: 4,
      fetchImpl: fakeFetch({
        body: { data: [{ id: "model-x", state: "loaded", loaded_context_length: 600000 }] },
      }),
    });
    expect(result.status).toBe("loaded-too-small");
    expect(result.requestedTotalContextTokens).toBe(800000);
    expect(result.message).toContain("800,000");
    expect(result.message).toContain("600,000");
  });

  test("model-not-loaded when the id is not in /api/v0/models", async () => {
    const result = await runStartupProbe({
      endpoint: "http://h:1/v1",
      modelId: "missing",
      configuredContextTokens: 100,
      fetchImpl: fakeFetch({ body: { data: [{ id: "other", state: "loaded" }] } }),
    });
    expect(result.status).toBe("model-not-loaded");
  });

  test("model-not-loaded when state is not loaded", async () => {
    const result = await runStartupProbe({
      endpoint: "http://h:1/v1",
      modelId: "model-x",
      configuredContextTokens: 100,
      fetchImpl: fakeFetch({ body: { data: [{ id: "model-x", state: "not-loaded" }] } }),
    });
    expect(result.status).toBe("model-not-loaded");
  });

  test("model-not-loaded when loaded_context_length is missing", async () => {
    const result = await runStartupProbe({
      endpoint: "http://h:1/v1",
      modelId: "model-x",
      configuredContextTokens: 100,
      fetchImpl: fakeFetch({ body: { data: [{ id: "model-x", state: "loaded" }] } }),
    });
    expect(result.status).toBe("model-not-loaded");
    expect(result.message).toContain("loaded_context_length");
  });

  test("endpoint-unreachable on non-2xx status", async () => {
    const result = await runStartupProbe({
      endpoint: "http://h:1/v1",
      modelId: "model-x",
      configuredContextTokens: 100,
      fetchImpl: fakeFetch({ ok: false, status: 503 }),
    });
    expect(result.status).toBe("endpoint-unreachable");
    expect(result.message).toContain("503");
  });

  test("endpoint-unreachable on fetch throw", async () => {
    const result = await runStartupProbe({
      endpoint: "http://h:1/v1",
      modelId: "model-x",
      configuredContextTokens: 100,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(result.status).toBe("endpoint-unreachable");
    expect(result.message).toContain("ECONNREFUSED");
  });

  test("aborts the fetch when timeoutMs elapses", async () => {
    const result = await runStartupProbe({
      endpoint: "http://h:1/v1",
      modelId: "model-x",
      configuredContextTokens: 100,
      timeoutMs: 25,
      fetchImpl: async (_url, init) => {
        return await new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
          setTimeout(() => resolve(new Response("{}")), 1000);
        });
      },
    });
    expect(result.status).toBe("endpoint-unreachable");
  });

  test("strips a trailing /v1 from the endpoint when querying the native API", async () => {
    let observed = "";
    await runStartupProbe({
      endpoint: "http://h:1/v1",
      modelId: "model-x",
      configuredContextTokens: 100,
      fetchImpl: async (url) => {
        observed = String(url);
        return new Response(
          JSON.stringify({
            data: [{ id: "model-x", state: "loaded", loaded_context_length: 1000 }],
          }),
        );
      },
    });
    expect(observed).toBe("http://h:1/api/v0/models");
  });
});
