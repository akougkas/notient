import { describe, expect, test } from "bun:test";
import {
  type EndpointModelCatalog,
  applyResolvedModels,
  fetchEndpointModelCatalog,
  resolveEndpointModels,
} from "../../../../src/core/llm/modelSelection";
import { resolveSettings } from "../../../../src/core/settings/envOverrides";
import { DEFAULT_NOTIENT_CONFIG } from "../../../../src/core/settings/types";

const RUNTIME_DEFAULTS = resolveSettings(DEFAULT_NOTIENT_CONFIG, {});

test("catalog deadline includes a response body that stalls after headers", async () => {
  let cancelled = false;
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"object":"list","data":['));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
  });
  const started = performance.now();
  try {
    await expect(
      fetchEndpointModelCatalog({ baseUrl: `${server.url.origin}/v1`, timeoutMs: 100 }),
    ).rejects.toThrow(/catalog/);
    expect(performance.now() - started).toBeLessThan(2000);
    for (let i = 0; i < 20 && !cancelled; i++) await Bun.sleep(10);
    expect(cancelled).toBe(true);
  } finally {
    await server.stop(true);
  }
});

function settings(chatModel = "", embeddingModel = "") {
  return {
    ...RUNTIME_DEFAULTS,
    primary: {
      ...RUNTIME_DEFAULTS.primary,
      baseUrl: "http://host:1234/v1",
      reasoningModel: chatModel,
    },
    embedding: {
      ...RUNTIME_DEFAULTS.embedding,
      baseUrl: "http://host:1234/v1",
      model: embeddingModel,
    },
  };
}

function catalog(models: EndpointModelCatalog["models"]): EndpointModelCatalog {
  return { source: "lmstudio-native", models };
}

function openAiCatalog(models: EndpointModelCatalog["models"]): EndpointModelCatalog {
  return { source: "openai-compatible", models };
}

describe("resolveEndpointModels", () => {
  test("applies a resolved chat model to every live reasoning slot", () => {
    const result = applyResolvedModels(settings(), {
      chatModel: "resolved-chat",
      embeddingModel: "resolved-embed",
      reason: "test",
      warnings: [],
    });

    expect(result.primary.reasoningModel).toBe("resolved-chat");
    expect(result.deep.reasoningModel).toBe("resolved-chat");
    expect(result.deep.rerankerModel).toBe("resolved-chat");
    expect(result.embedding.model).toBe("resolved-embed");
  });

  test("uses the configured ids when they are present in the catalog", () => {
    const result = resolveEndpointModels({
      settings: settings("chat-a", "embed-a"),
      catalog: catalog([
        {
          id: "chat-a",
          type: "chat",
          state: "loaded",
          loadedContextLength: 1000,
        },
        {
          id: "embed-a",
          type: "embedding",
          state: "loaded",
          loadedContextLength: null,
        },
      ]),
    });

    expect(result.chatModel).toBe("chat-a");
    expect(result.embeddingModel).toBe("embed-a");
    expect(result.warnings).toEqual([]);
  });

  test("does not normalize an untagged configured id to a tagged catalog id", () => {
    const result = resolveEndpointModels({
      settings: settings("ornith1.5-35b-moe", "nomic-embed-text-v2-moe"),
      catalog: openAiCatalog([
        {
          id: "ornith1.5-35b-moe",
          type: "chat",
          state: "unknown",
          loadedContextLength: null,
        },
      ]),
      embeddingCatalog: openAiCatalog([
        {
          id: "nomic-embed-text-v2-moe:latest",
          type: "embedding",
          state: "unknown",
          loadedContextLength: null,
        },
      ]),
    });

    expect(result.chatModel).toBe("ornith1.5-35b-moe");
    expect(result.embeddingModel).toBe("nomic-embed-text-v2-moe");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("nomic-embed-text-v2-moe is not listed");
  });

  test("never maps one explicit model tag to another", () => {
    const result = resolveEndpointModels({
      settings: settings("qwen3:8b", "embed"),
      catalog: openAiCatalog([
        {
          id: "qwen3:32b",
          type: "chat",
          state: "unknown",
          loadedContextLength: null,
        },
      ]),
    });

    expect(result.chatModel).toBe("qwen3:8b");
    expect(result.warnings.join("\n")).toContain("qwen3:8b is not listed");
  });

  test("does not normalize a configured latest tag to an untagged catalog id", () => {
    const result = resolveEndpointModels({
      settings: settings("qwen3:latest", "embed"),
      catalog: openAiCatalog([
        {
          id: "qwen3",
          type: "chat",
          state: "unknown",
          loadedContextLength: null,
        },
        {
          id: "embed",
          type: "embedding",
          state: "unknown",
          loadedContextLength: null,
        },
      ]),
    });

    expect(result.chatModel).toBe("qwen3:latest");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("qwen3:latest is not listed");
  });

  test("keeps a configured id that the catalog does not list, with a warning", () => {
    const result = resolveEndpointModels({
      settings: settings("router-alias", "router-embed"),
      catalog: openAiCatalog([
        {
          id: "some-other-model",
          type: "chat",
          state: "unknown",
          loadedContextLength: null,
        },
      ]),
    });

    expect(result.chatModel).toBe("router-alias");
    expect(result.embeddingModel).toBe("router-embed");
    expect(result.warnings.join("\n")).toContain(
      "configured model router-alias is not listed by the endpoint",
    );
  });

  test("keeps configured ids when the endpoint catalog probe came back empty", () => {
    const result = resolveEndpointModels({
      settings: settings("ornith1.5-35b-moe", "nomic-embed-text-v2-moe"),
      catalog: openAiCatalog([]),
    });

    expect(result.chatModel).toBe("ornith1.5-35b-moe");
    expect(result.embeddingModel).toBe("nomic-embed-text-v2-moe");
    expect(result.warnings.length).toBe(2);
  });

  test("selects the only compatible model when nothing is configured", () => {
    const result = resolveEndpointModels({
      settings: settings(),
      catalog: openAiCatalog([
        {
          id: "only-chat",
          type: "chat",
          state: "unknown",
          loadedContextLength: null,
        },
        {
          id: "only-embed",
          type: "embedding",
          state: "unknown",
          loadedContextLength: null,
        },
      ]),
    });

    expect(result.chatModel).toBe("only-chat");
    expect(result.embeddingModel).toBe("only-embed");
    expect(result.warnings).toEqual([]);
  });

  test("prefers the loaded model on an LM Studio catalog when nothing is configured", () => {
    const result = resolveEndpointModels({
      settings: settings(),
      catalog: catalog([
        {
          id: "cold-chat",
          type: "chat",
          state: "not-loaded",
          loadedContextLength: null,
        },
        {
          id: "hot-chat",
          type: "chat",
          state: "loaded",
          loadedContextLength: 8192,
        },
        {
          id: "only-embed",
          type: "embedding",
          state: "loaded",
          loadedContextLength: null,
        },
      ]),
    });

    expect(result.chatModel).toBe("hot-chat");
    expect(result.embeddingModel).toBe("only-embed");
  });

  test("throws and lists the catalog when nothing is configured and the choice is ambiguous", () => {
    expect(() =>
      resolveEndpointModels({
        settings: settings(),
        catalog: openAiCatalog([
          {
            id: "chat-one",
            type: "chat",
            state: "unknown",
            loadedContextLength: null,
          },
          {
            id: "chat-two",
            type: "chat",
            state: "unknown",
            loadedContextLength: null,
          },
          {
            id: "only-embed",
            type: "embedding",
            state: "unknown",
            loadedContextLength: null,
          },
        ]),
      }),
    ).toThrow(/Ambiguous chat candidates: chat-one, chat-two/);
  });

  test("throws when nothing is configured and the catalog is empty", () => {
    expect(() =>
      resolveEndpointModels({
        settings: settings(),
        catalog: openAiCatalog([]),
      }),
    ).toThrow(/catalog empty/);
  });
});

describe("fetchEndpointModelCatalog", () => {
  test("authenticates both the compatible and optional native catalog requests", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const result = await fetchEndpointModelCatalog({
      baseUrl: "https://compatible.example/v1",
      apiKey: "catalog-token_123",
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push({
          url,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        if (url.endsWith("/api/v0/models")) {
          return new Response("not found", { status: 404 });
        }
        return Response.json({
          object: "list",
          data: [{ id: "chat-model", object: "model" }],
        });
      },
    });

    expect(result.source).toBe("openai-compatible");
    expect(calls).toEqual([
      {
        url: "https://compatible.example/v1/models",
        authorization: "Bearer catalog-token_123",
      },
      {
        url: "https://compatible.example/api/v0/models",
        authorization: "Bearer catalog-token_123",
      },
    ]);
  });

  test("rejects malformed catalog credentials without exposing them", async () => {
    const malformed = "catalog secret";
    let thrown: unknown;
    try {
      await fetchEndpointModelCatalog({
        baseUrl: "https://compatible.example/v1",
        apiKey: malformed,
        fetchImpl: async () => new Response(null, { status: 500 }),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("model endpoint apiKey");
    expect((thrown as Error).message).not.toContain(malformed);
  });

  test("redacts a credential echoed by the fetch boundary", async () => {
    let thrown: unknown;
    try {
      await fetchEndpointModelCatalog({
        baseUrl: "https://compatible.example/v1",
        apiKey: "catalog-token_123",
        fetchImpl: async () => {
          throw new Error("failed with catalog-token_123");
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("[redacted]");
    expect((thrown as Error).message).not.toContain("catalog-token_123");
  });

  test("redacts endpoint-controlled catalog status text", async () => {
    const token = "catalog-status-token_123";
    let thrown: unknown;
    try {
      await fetchEndpointModelCatalog({
        baseUrl: "https://compatible.example/v1",
        apiKey: token,
        fetchImpl: async () => new Response(null, { status: 502, statusText: `echoed ${token}` }),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("[redacted]");
    expect(String((thrown as Error).stack)).not.toContain(token);
  });

  test("redacts catalog JSON parser failures from successful responses", async () => {
    const token = "catalog-json-token_123";
    let thrown: unknown;
    try {
      await fetchEndpointModelCatalog({
        baseUrl: "https://compatible.example/v1",
        apiKey: token,
        fetchImpl: async () =>
          ({
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => {
              throw new SyntaxError(`invalid JSON near ${token}`);
            },
          }) as unknown as Response,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("[redacted]");
    expect(String((thrown as Error).stack)).not.toContain(token);
  });

  test("rejects a credential echoed by a successful compatible or native catalog", async () => {
    const token = "catalog-success-token_123";
    const cases: Array<(input: RequestInfo | URL) => Response> = [
      () =>
        Response.json({
          object: "list",
          data: [{ id: `chat-${token}`, object: "model" }],
        }),
      (input) =>
        String(input).endsWith("/v1/models")
          ? Response.json({
              object: "list",
              data: [{ id: "chat-model", object: "model" }],
            })
          : Response.json({
              object: "list",
              data: [
                {
                  id: "chat-model",
                  object: "model",
                  type: "llm",
                  state: "loaded",
                  loaded_context_length: 4096,
                  capabilities: [`echo-${token}`],
                },
              ],
            }),
    ];

    for (const respond of cases) {
      let thrown: unknown;
      try {
        await fetchEndpointModelCatalog({
          baseUrl: "https://compatible.example/v1",
          apiKey: token,
          fetchImpl: async (input) => respond(input),
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("configured provider credential");
      expect(JSON.stringify(thrown)).not.toContain(token);
    }
  });

  test("validates /v1/models first and uses it when the native route is absent", async () => {
    const calls: string[] = [];
    const result = await fetchEndpointModelCatalog({
      baseUrl: "http://host:11434/v1",
      fetchImpl: async (input) => {
        calls.push(String(input));
        if (String(input) === "http://host:11434/api/v0/models") {
          return new Response("not found", { status: 404 });
        }
        return Response.json({
          object: "list",
          data: [
            {
              id: "Qwopus3.6-35B-A3B-Coder-MTP-Q4_K_M-262K",
              object: "model",
              owned_by: "llama.cpp",
              status: { value: "sleeping" },
            },
            {
              id: "nomic-embed-text-v2-moe:latest",
              object: "model",
              created: 1_800_000_000,
              owned_by: "library",
            },
          ],
        });
      },
    });

    expect(calls).toEqual(["http://host:11434/v1/models", "http://host:11434/api/v0/models"]);
    expect(result.source).toBe("openai-compatible");
    expect(result.models[0]).toEqual({
      id: "Qwopus3.6-35B-A3B-Coder-MTP-Q4_K_M-262K",
      type: "unknown",
      state: "unknown",
      loadedContextLength: null,
    });
    expect(result.models).toContainEqual({
      id: "nomic-embed-text-v2-moe:latest",
      type: "embedding",
      state: "unknown",
      loadedContextLength: null,
    });
  });

  test("uses a valid LM Studio native catalog as richer metadata", async () => {
    const calls: string[] = [];
    const result = await fetchEndpointModelCatalog({
      baseUrl: "http://host:1234/v1",
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/v1/models")) {
          return Response.json({
            object: "list",
            data: [
              { id: "chat.gguf", object: "model" },
              { id: "embed.gguf", object: "model" },
            ],
          });
        }
        return Response.json({
          object: "list",
          data: [
            {
              id: "chat.gguf",
              object: "model",
              type: "llm",
              state: "loaded",
              loaded_context_length: 131_072,
              max_context_length: 262_144,
              capabilities: ["tool_use"],
            },
            {
              id: "embed.gguf",
              type: "embedding",
              state: "not-loaded",
              loaded_context_length: null,
            },
          ],
        });
      },
    });

    expect(calls).toEqual(["http://host:1234/v1/models", "http://host:1234/api/v0/models"]);
    expect(result).toEqual({
      source: "lmstudio-native",
      models: [
        {
          id: "chat.gguf",
          type: "chat",
          state: "loaded",
          loadedContextLength: 131_072,
          maxContextLength: 262_144,
          capabilities: ["tool_use"],
        },
        {
          id: "embed.gguf",
          type: "embedding",
          state: "not-loaded",
          loadedContextLength: null,
        },
      ],
    });
  });

  test("does not hide an OpenAI catalog HTTP failure behind the native route", async () => {
    const calls: string[] = [];
    const promise = fetchEndpointModelCatalog({
      baseUrl: "http://host:8080/v1",
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response("unavailable", { status: 503 });
      },
    });

    await expect(promise).rejects.toThrow(
      "OpenAI model catalog request failed at http://host:8080/v1/models: HTTP 503",
    );
    expect(calls).toEqual(["http://host:8080/v1/models"]);
  });

  test("rejects malformed OpenAI rows instead of silently dropping them", async () => {
    const promise = fetchEndpointModelCatalog({
      baseUrl: "http://host:8080/v1",
      fetchImpl: async () =>
        Response.json({
          object: "list",
          data: [
            { id: "valid", object: "model" },
            { id: " malformed ", object: "model" },
          ],
        }),
    });

    await expect(promise).rejects.toThrow(
      "OpenAI model catalog.data[1].id must be a canonical nonblank string",
    );
  });

  test("rejects malformed native metadata after validating the OpenAI endpoint", async () => {
    const promise = fetchEndpointModelCatalog({
      baseUrl: "http://host:1234/v1",
      fetchImpl: async (input) =>
        String(input).endsWith("/v1/models")
          ? Response.json({
              object: "list",
              data: [{ id: "chat.gguf", object: "model" }],
            })
          : Response.json({
              data: [{ id: "chat.gguf", type: "llm", state: "ready" }],
            }),
    });

    await expect(promise).rejects.toThrow(
      'LM Studio native model catalog.data[0].state must be "loaded" or "not-loaded"',
    );
  });

  test("surfaces a non-404 native endpoint failure", async () => {
    const promise = fetchEndpointModelCatalog({
      baseUrl: "http://host:1234/v1",
      fetchImpl: async (input) =>
        String(input).endsWith("/v1/models")
          ? Response.json({ object: "list", data: [] })
          : new Response("native failed", { status: 500 }),
    });

    await expect(promise).rejects.toThrow(
      "LM Studio native model catalog request failed at http://host:1234/api/v0/models: HTTP 500",
    );
  });

  test("rejects noncanonical base URLs instead of rewriting them", async () => {
    let called = false;
    const promise = fetchEndpointModelCatalog({
      baseUrl: "http://host:1234/v1/",
      fetchImpl: async () => {
        called = true;
        return Response.json({ object: "list", data: [] });
      },
    });

    await expect(promise).rejects.toThrow(
      "model endpoint must be the canonical OpenAI-compatible base URL ending in /v1",
    );
    expect(called).toBe(false);
  });

  test("never repeats credentials embedded in a rejected endpoint URL", async () => {
    const secrets = ["url-password-secret", "query-api-secret", "fragment-secret"];
    const urls = [
      `https://operator:${secrets[0]}@compatible.example/v1`,
      `https://compatible.example/v1?api_key=${secrets[1]}`,
      `https://compatible.example/v1#${secrets[2]}`,
    ];

    for (const baseUrl of urls) {
      let thrown: unknown;
      try {
        await fetchEndpointModelCatalog({
          baseUrl,
          fetchImpl: async () => {
            throw new Error("fetch must not run");
          },
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      const rendered = `${(thrown as Error).message}\n${String((thrown as Error).stack)}`;
      for (const secret of secrets) expect(rendered).not.toContain(secret);
    }
  });
});
