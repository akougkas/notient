import { describe, expect, test } from "bun:test";
import { Kernel, type ServiceKey } from "./kernel";

const ALL_SERVICE_KEYS: readonly ServiceKey[] = [
  "bus",
  "settings",
  "vault",
  "database",
  "graph",
  "primaryLLM",
  "deepLLM",
  "embeddingLLM",
  "health",
  "lock",
  "probeCache",
  "agentEventStore",
  "sessionGrants",
  "indexer",
  "embedder",
  "extractor",
  "reasoningMutex",
  "idleDetector",
  "coordinator",
  "approvalService",
  "coAuthor",
  "streamService",
  "vitalsService",
  "searchPipeline",
  "savedQueries",
  "searchHistory",
  "conversationStore",
  "conversationIndex",
  "toolRegistry",
  "toolModeCache",
  "approvalGate",
  "contextManager",
  "chatService",
  "historyService",
  "transcriptDistiller",
  "vaultBootstrap",
];

describe("Kernel", () => {
  test("get throws if service not registered", () => {
    const k = new Kernel();
    expect(() => k.get("bus")).toThrow(/not registered/);
  });

  test("seal throws if any required service missing", () => {
    const k = new Kernel();
    k.register("bus", {} as never);
    expect(() => k.seal()).toThrow(/missing required services/);
  });

  test("seal succeeds when all required services registered", () => {
    const k = new Kernel();
    for (const key of ALL_SERVICE_KEYS) {
      k.register(key, {} as never);
    }
    expect(() => k.seal()).not.toThrow();
    expect(k.isSealed()).toBe(true);
  });

  test("register after seal throws", () => {
    const k = new Kernel();
    for (const key of ALL_SERVICE_KEYS) {
      k.register(key, {} as never);
    }
    k.seal();
    expect(() => k.register("bus", {} as never)).toThrow(/sealed/);
  });
});
