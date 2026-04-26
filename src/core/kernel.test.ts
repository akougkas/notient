import { describe, expect, test } from "bun:test";
import { Kernel } from "./kernel";

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
    for (const key of [
      "bus",
      "settings",
      "facade",
      "database",
      "graph",
      "primaryLLM",
      "deepLLM",
      "health",
      "lock",
      "echoGuard",
      "indexer",
      "vectorIndex",
      "embedder",
      "extractor",
      "reasoningMutex",
      "idleDetector",
      "coordinator",
      "approvalService",
      "coAuthor",
    ] as const) {
      k.register(key, {} as never);
    }
    expect(() => k.seal()).not.toThrow();
    expect(k.isSealed()).toBe(true);
  });

  test("register after seal throws", () => {
    const k = new Kernel();
    for (const key of [
      "bus",
      "settings",
      "facade",
      "database",
      "graph",
      "primaryLLM",
      "deepLLM",
      "health",
      "lock",
      "echoGuard",
      "indexer",
      "vectorIndex",
      "embedder",
      "extractor",
      "reasoningMutex",
      "idleDetector",
      "coordinator",
      "approvalService",
      "coAuthor",
    ] as const) {
      k.register(key, {} as never);
    }
    k.seal();
    expect(() => k.register("bus", {} as never)).toThrow(/sealed/);
  });
});
