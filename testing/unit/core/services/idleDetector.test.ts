import { describe, expect, test } from "bun:test";
import { EventBus } from "../../../../src/core/events/eventBus";
import { IdleDetector } from "../../../../src/core/services/idleDetector";

describe("IdleDetector", () => {
  test("emits 30s, 5m, 30m sequentially while inactive", async () => {
    const bus = new EventBus();
    const events: string[] = [];
    bus.on("user:idle", (e) => events.push(e.level));
    bus.on("user:active", () => events.push("active"));
    let now = 0;
    const detector = new IdleDetector(bus, {
      now: () => now,
      thresholds: { "30s": 30_000, "5m": 300_000, "30m": 1_800_000 },
    });
    detector.start();
    detector.recordActivity();
    now = 30_001;
    detector.tick();
    now = 300_001;
    detector.tick();
    now = 1_800_001;
    detector.tick();
    detector.stop();
    expect(events).toEqual(["30s", "5m", "30m"]);
  });

  test("recordActivity resets idle and re-emits active", async () => {
    const bus = new EventBus();
    const events: string[] = [];
    bus.on("user:idle", (e) => events.push(`idle:${e.level}`));
    bus.on("user:active", () => events.push("active"));
    let now = 0;
    const detector = new IdleDetector(bus, {
      now: () => now,
      thresholds: { "30s": 30_000, "5m": 300_000, "30m": 1_800_000 },
    });
    detector.start();
    detector.recordActivity();
    now = 30_001;
    detector.tick();
    detector.recordActivity();
    expect(events).toEqual(["idle:30s", "active"]);
    now = 60_002;
    detector.tick();
    expect(events).toEqual(["idle:30s", "active", "idle:30s"]);
  });

  test("stop clears any timer", () => {
    const bus = new EventBus();
    const detector = new IdleDetector(bus);
    detector.start();
    detector.stop();
    expect(detector.isRunning()).toBe(false);
  });
});
