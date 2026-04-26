import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventBus } from "../events/eventBus";
import type { ChatMessage, ChatOptions, LLMProvider } from "../llm/provider";
import { HealthMonitor } from "./healthMonitor";

class FakeProvider implements LLMProvider {
  constructor(private value: boolean) {}
  setAvailable(v: boolean): void {
    this.value = v;
  }
  async isAvailable(): Promise<boolean> {
    return this.value;
  }
  chat(_messages: ChatMessage[], _opts: ChatOptions): Promise<string> {
    throw new Error("not used");
  }
  async *chatStream(_messages: ChatMessage[], _opts: ChatOptions): AsyncIterable<string> {
    yield "";
  }
  embed(): Promise<number[][]> {
    return Promise.resolve([]);
  }
  chatJson<T>(): Promise<T> {
    throw new Error("not used");
  }
}

let originalSetInterval: typeof setInterval;
let originalClearInterval: typeof clearInterval;
beforeEach(() => {
  originalSetInterval = globalThis.setInterval;
  originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (() => 0) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => undefined) as unknown as typeof clearInterval;
});
afterEach(() => {
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
});

describe("HealthMonitor", () => {
  test("emits llm:health events on probe", async () => {
    const bus = new EventBus();
    const events: { endpoint: string; ok: boolean }[] = [];
    bus.on("llm:health", (event) => events.push({ endpoint: event.endpoint, ok: event.ok }));
    const provider = new FakeProvider(true);
    const monitor = new HealthMonitor(
      [{ label: "primary", baseUrl: "http://x/v1", provider }],
      bus,
      { intervalMs: 30_000 },
    );
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events).toEqual([{ endpoint: "primary", ok: true }]);
    monitor.stop();
  });

  test("current() reflects last probe result", async () => {
    const bus = new EventBus();
    const provider = new FakeProvider(false);
    const monitor = new HealthMonitor(
      [{ label: "primary", baseUrl: "http://x/v1", provider }],
      bus,
      { intervalMs: 30_000 },
    );
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(monitor.current()).toEqual([{ label: "primary", ok: false }]);
    monitor.stop();
  });
});
