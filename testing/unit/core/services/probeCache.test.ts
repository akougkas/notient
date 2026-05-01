import { describe, expect, test } from "bun:test";
import { EventBus } from "../../../../src/core/events/eventBus";
import { ProbeCache } from "../../../../src/core/services/probeCache";

describe("ProbeCache", () => {
  test("returns null until an event arrives", () => {
    const bus = new EventBus();
    const cache = new ProbeCache(bus);
    expect(cache.get()).toBeNull();
  });

  test("captures the latest startup probe event from the bus", () => {
    const bus = new EventBus();
    const cache = new ProbeCache(bus);
    bus.emit({
      type: "daemon:startup_probe",
      endpoint: "http://h:1/v1",
      modelId: "m",
      configuredContextTokens: 200000,
      parallelSlots: 4,
      requestedTotalContextTokens: 800000,
      loadedContextLength: 800000,
      status: "ok",
      message: "fits",
    });
    const cached = cache.get();
    expect(cached?.status).toBe("ok");
    expect(cached?.loadedContextLength).toBe(800000);
    expect(cached?.parallelSlots).toBe(4);
    expect(cached?.requestedTotalContextTokens).toBe(800000);
  });

  test("the latest event wins when multiple are emitted", () => {
    const bus = new EventBus();
    const cache = new ProbeCache(bus);
    bus.emit({
      type: "daemon:startup_probe",
      endpoint: "http://h:1/v1",
      modelId: "m",
      configuredContextTokens: 100,
      parallelSlots: 1,
      requestedTotalContextTokens: 100,
      loadedContextLength: 200,
      status: "ok",
      message: "first",
    });
    bus.emit({
      type: "daemon:startup_probe",
      endpoint: "http://h:1/v1",
      modelId: "m",
      configuredContextTokens: 999,
      parallelSlots: 4,
      requestedTotalContextTokens: 3996,
      loadedContextLength: null,
      status: "endpoint-unreachable",
      message: "second",
    });
    expect(cache.get()?.status).toBe("endpoint-unreachable");
    expect(cache.get()?.message).toBe("second");
  });
});
