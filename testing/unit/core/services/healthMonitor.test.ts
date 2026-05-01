import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventBus } from "../../../../src/core/events/eventBus";
import type {
  ChatMessage,
  ChatOptions,
  JsonSchema,
  LLMProvider,
} from "../../../../src/core/llm/provider";
import { HealthMonitor } from "../../../../src/core/services/healthMonitor";

class FakeProvider implements LLMProvider {
  constructor(private value: boolean) {}
  setAvailable(v: boolean): void {
    this.value = v;
  }
  async isAvailable(): Promise<boolean> {
    return this.value;
  }
  chat(_messages: ChatMessage[], _options: ChatOptions): Promise<string> {
    throw new Error("not used");
  }
  async *chatStream(_messages: ChatMessage[], _options: ChatOptions): AsyncIterable<string> {
    yield "";
  }
  embed(): Promise<number[][]> {
    return Promise.resolve([]);
  }
  chatJson<T>(_messages: ChatMessage[], _options: ChatOptions, _schema: JsonSchema): Promise<T> {
    throw new Error("not used");
  }
}

/**
 * Provider that sleeps for `sleepMs` but resolves/rejects early when its abort
 * signal fires. Captures the most recent signal it received so tests can assert
 * on the final aborted state.
 */
class SleepyProvider implements LLMProvider {
  public lastSignal: AbortSignal | undefined;
  public abortObserved = false;
  constructor(private readonly sleepMs: number) {}
  isAvailable(signal?: AbortSignal): Promise<boolean> {
    this.lastSignal = signal;
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => resolve(true), this.sleepMs);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          this.abortObserved = true;
          reject(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
    });
  }
  chat(_messages: ChatMessage[], _options: ChatOptions): Promise<string> {
    throw new Error("not used");
  }
  async *chatStream(_messages: ChatMessage[], _options: ChatOptions): AsyncIterable<string> {
    yield "";
  }
  embed(): Promise<number[][]> {
    return Promise.resolve([]);
  }
  chatJson<T>(_messages: ChatMessage[], _options: ChatOptions, _schema: JsonSchema): Promise<T> {
    throw new Error("not used");
  }
}

let originalSetInterval: typeof setInterval;
let originalClearInterval: typeof clearInterval;
beforeEach(() => {
  originalSetInterval = globalThis.setInterval;
  originalClearInterval = globalThis.clearInterval;
  // Stub setInterval so the monitor never schedules a second probe; the
  // initial probeAll() call from start() is enough for these tests.
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

describe("HealthMonitor abort paths", () => {
  test("timer aborts probe at floor(intervalMs/2) when floor is 500ms", async () => {
    // intervalMs=1100 → timeoutMs = max(500, floor(1100/2)) = 550ms.
    // Provider sleeps 1500ms, so the timer fires first.
    const provider = new SleepyProvider(1500);
    const bus = new EventBus();
    const events: { endpoint: string; ok: boolean }[] = [];
    bus.on("llm:health", (event) => events.push({ endpoint: event.endpoint, ok: event.ok }));
    const monitor = new HealthMonitor([{ label: "primary", baseUrl: "http://x", provider }], bus, {
      intervalMs: 1100,
    });
    const startedAt = Date.now();
    monitor.start();

    // Wait long enough for the 550ms timer to fire and probeAll to settle,
    // but well under the 1500ms provider sleep and the 3000ms test bound.
    await new Promise((resolve) => setTimeout(resolve, 900));
    const elapsed = Date.now() - startedAt;

    expect(provider.abortObserved).toBe(true);
    expect(provider.lastSignal?.aborted).toBe(true);
    expect(events).toEqual([{ endpoint: "primary", ok: false }]);
    // Timer fires near 550ms; allow generous slack for CI jitter.
    expect(elapsed).toBeLessThan(1400);
    monitor.stop();
  }, 3000);

  test("stop() aborts in-flight probes before timer or provider settle", async () => {
    // intervalMs=10_000 → timeoutMs = 5000ms. Provider sleeps 5000ms. We
    // call stop() ~100ms in, so neither the timer nor the provider would
    // have completed without stop() intervening.
    const provider = new SleepyProvider(5000);
    const bus = new EventBus();
    const monitor = new HealthMonitor([{ label: "primary", baseUrl: "http://x", provider }], bus, {
      intervalMs: 10_000,
    });
    monitor.start();

    // Wait for probeAll() to register the in-flight controller.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const inflightBeforeStop = monitor.inflightControllers().size;
    const capturedSignal = provider.lastSignal;
    expect(inflightBeforeStop).toBe(1);
    expect(capturedSignal?.aborted).toBe(false);

    monitor.stop();

    // Allow microtasks to flush so the probe's finally block runs.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(capturedSignal?.aborted).toBe(true);
    expect(provider.abortObserved).toBe(true);
    expect(monitor.inflightControllers().size).toBe(0);
  }, 3000);
});
