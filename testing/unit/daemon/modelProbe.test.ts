import { expect, test } from "bun:test";
import { fetchEndpointModelCatalog } from "../../../src/core/llm/modelSelection";
import { probeDaemonModel } from "../../../src/daemon/modelProbe";

test("actual LM Studio plural embedding type cannot masquerade as an unloaded reasoning model", async () => {
  let requests = 0;
  const catalog = await fetchEndpointModelCatalog({
    baseUrl: "http://test:1234/v1",
    fetchImpl: async (url) => {
      requests++;
      return Response.json({
        object: "list",
        data: String(url).includes("/api/v0/")
          ? [
              {
                id: "text-embedding-nomic",
                type: "embeddings",
                state: "loaded",
                loaded_context_length: 2048,
              },
              { id: "qwen3.8-27b", type: "vlm", state: "not-loaded" },
            ]
          : [
              { id: "text-embedding-nomic", object: "model" },
              { id: "qwen3.8-27b", object: "model" },
            ],
      });
    },
  });
  expect(catalog.models[0].type).toBe("embedding");
  const result = await probeDaemonModel({
    endpoint: "http://test:1234/v1",
    configuredModel: "qwen3.8-27b",
    configuredContextTokens: 32768,
    parallelSlots: 4,
    fetchCatalog: async () => catalog,
  });
  expect(result.status).toBe("not-loaded");
  expect(result.loadedModel).toBeNull();
  expect(result.loadedContextLength).toBeNull();
  expect(result.message).not.toContain("nomic");
  expect(requests).toBe(2);
});

test("unconfigured, unreachable, advertised and loaded capacity remain distinct", async () => {
  const base = {
    endpoint: "http://test:1234/v1",
    configuredModel: "qwen",
    configuredContextTokens: 32768,
    parallelSlots: 4,
  };
  expect(
    (
      await probeDaemonModel({
        ...base,
        configuredModel: "",
        fetchCatalog: async () => {
          throw new Error("must not probe");
        },
      })
    ).status,
  ).toBe("unconfigured");
  expect(
    (
      await probeDaemonModel({
        ...base,
        fetchCatalog: async () => {
          throw new Error("offline");
        },
      })
    ).status,
  ).toBe("unavailable");
  const fetchCatalog = async () => ({
    source: "openai-compatible" as const,
    models: [
      { id: "qwen", type: "chat" as const, state: "unknown" as const, loadedContextLength: null },
    ],
  });
  expect((await probeDaemonModel({ ...base, fetchCatalog })).status).toBe("available");
  const loaded = async (capacity: number) =>
    probeDaemonModel({
      ...base,
      fetchCatalog: async () => ({
        source: "lmstudio-native",
        models: [{ id: "qwen", type: "chat", state: "loaded", loadedContextLength: capacity }],
      }),
    });
  expect((await loaded(131072)).status).toBe("ok");
  expect((await loaded(32768)).status).toBe("mismatch");
});
