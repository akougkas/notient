import { afterEach, describe, expect, test } from "bun:test";
import { EventBus } from "../../../src/core/events/eventBus";
import { ObsidianProbe } from "../../../src/bridge/obsidianProbe";

interface BusEvent {
  type: string;
  [key: string]: unknown;
}

function captureBus(bus: EventBus): BusEvent[] {
  const events: BusEvent[] = [];
  bus.on("bridge:up", (event) => {
    events.push({ ...event });
  });
  bus.on("bridge:down", (event) => {
    events.push({ ...event });
  });
  return events;
}

describe("ObsidianProbe", () => {
  let probe: ObsidianProbe | null = null;

  afterEach(async () => {
    if (probe) {
      await probe.stop();
      probe = null;
    }
  });

  test("emits bridge:up when the prober reports ready", async () => {
    const bus = new EventBus();
    const events = captureBus(bus);
    probe = new ObsidianProbe({
      bus,
      intervalMs: 50,
      probe: async () => ({ ok: true, version: "1.5.3" }),
    });
    await probe.tickOnce();
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("bridge:up");
    expect(events[0].version).toBe("1.5.3");
  });

  test("emits bridge:down when the prober rejects", async () => {
    const bus = new EventBus();
    const events = captureBus(bus);
    probe = new ObsidianProbe({
      bus,
      intervalMs: 50,
      probe: async () => ({ ok: false, error: "ENOENT" }),
    });
    await probe.tickOnce();
    expect(events[0].type).toBe("bridge:down");
    expect(events[0].error).toBe("ENOENT");
  });

  test("dedupes consecutive identical states", async () => {
    const bus = new EventBus();
    const events = captureBus(bus);
    probe = new ObsidianProbe({
      bus,
      intervalMs: 50,
      probe: async () => ({ ok: true, version: "1.5.3" }),
    });
    await probe.tickOnce();
    await probe.tickOnce();
    await probe.tickOnce();
    expect(events.length).toBe(1);
  });

  test("emits state transitions", async () => {
    const bus = new EventBus();
    const events = captureBus(bus);
    let state: "up" | "down" = "up";
    probe = new ObsidianProbe({
      bus,
      intervalMs: 50,
      probe: async () => (state === "up" ? { ok: true } : { ok: false, error: "down" }),
    });
    await probe.tickOnce();
    state = "down";
    await probe.tickOnce();
    state = "up";
    await probe.tickOnce();
    expect(events.map((event) => event.type)).toEqual(["bridge:up", "bridge:down", "bridge:up"]);
  });
});
