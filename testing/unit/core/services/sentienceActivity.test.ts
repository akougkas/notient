import { describe, expect, test } from "bun:test";
import { EventBus } from "../../../../src/core/events/eventBus";
import { SentienceActivity } from "../../../../src/core/services/sentienceActivity";

function makeActivity(
  bus: EventBus,
  clock: { now: number },
  loadActiveNote: () => Promise<string | null> = async () => "notes/persisted.md",
): SentienceActivity {
  return new SentienceActivity(bus, {
    loadActiveNote,
    now: () => clock.now,
    thresholds: { link: 30_000, synthesize: 300_000, mature: 1_800_000 },
  });
}

describe("SentienceActivity", () => {
  test("emits each rung exactly once with one epoch and engaged-note snapshot", async () => {
    const bus = new EventBus();
    const clock = { now: 0 };
    const events: Array<Record<string, unknown>> = [];
    bus.on("sentience:idle", (event) => events.push(event));
    const activity = makeActivity(bus, clock);

    await activity.start();
    clock.now = 1_800_001;
    activity.tick();
    activity.tick();
    activity.stop();

    expect(events.map((event) => event.rung)).toEqual(["link", "synthesize", "mature"]);
    expect(new Set(events.map((event) => event.epoch)).size).toBe(1);
    expect(events.map((event) => event.activeNotePath)).toEqual([
      "notes/persisted.md",
      "notes/persisted.md",
      "notes/persisted.md",
    ]);
  });

  test("never emits before readiness and starts fresh after a slow boot", async () => {
    const bus = new EventBus();
    const clock = { now: 0 };
    const events: string[] = [];
    bus.on("sentience:idle", (event) => events.push(event.rung));
    const activity = makeActivity(bus, clock);

    clock.now = 400_000;
    activity.tick();
    expect(events).toEqual([]);

    await activity.start();
    activity.tick();
    expect(events).toEqual([]);
    clock.now += 30_001;
    activity.tick();
    activity.stop();
    expect(events).toEqual(["link"]);
  });

  test("human activity starts a new epoch and rearms every rung", async () => {
    const bus = new EventBus();
    const clock = { now: 0 };
    const events: Array<{ epoch: number; rung: string; path: string | null }> = [];
    bus.on("sentience:idle", (event) =>
      events.push({ epoch: event.epoch, rung: event.rung, path: event.activeNotePath }),
    );
    const activity = makeActivity(bus, clock);
    await activity.start();

    clock.now = 30_001;
    activity.tick();
    const firstEpoch = events[0].epoch;
    activity.recordHumanActivity({ source: "vault:change", notePath: "notes/new.md" });
    const secondEpoch = activity.snapshot().epoch;
    expect(secondEpoch).toBeGreaterThan(firstEpoch);

    clock.now = 60_002;
    activity.tick();
    activity.stop();
    expect(events).toEqual([
      { epoch: firstEpoch, rung: "link", path: "notes/persisted.md" },
      { epoch: secondEpoch, rung: "link", path: "notes/new.md" },
    ]);
  });

  test("activity observed during startup wins over persisted focus", async () => {
    const bus = new EventBus();
    const clock = { now: 0 };
    let releaseLoad!: (path: string | null) => void;
    const activity = makeActivity(
      bus,
      clock,
      () =>
        new Promise<string | null>((resolve) => {
          releaseLoad = resolve;
        }),
    );

    const starting = activity.start();
    activity.recordHumanActivity({ source: "vault:add", notePath: "notes/during-boot.md" });
    releaseLoad("notes/stale.md");
    await starting;
    expect(activity.snapshot().activeNotePath).toBe("notes/during-boot.md");
    activity.stop();
  });

  test("deleting the active note clears focus but deleting another note preserves it", async () => {
    const bus = new EventBus();
    const clock = { now: 0 };
    const activity = makeActivity(bus, clock);
    await activity.start();

    activity.recordDeletion("notes/other.md");
    expect(activity.snapshot().activeNotePath).toBe("notes/persisted.md");
    activity.recordDeletion("notes/persisted.md");
    expect(activity.snapshot().activeNotePath).toBeNull();
    activity.stop();
  });

  test("stop invalidates the current epoch and prevents later dispatch", async () => {
    const bus = new EventBus();
    const clock = { now: 0 };
    const events: string[] = [];
    bus.on("sentience:idle", (event) => events.push(event.rung));
    const activity = makeActivity(bus, clock);
    await activity.start();
    const epoch = activity.snapshot().epoch;

    activity.stop();
    clock.now = 2_000_000;
    activity.tick();
    expect(activity.isCurrentEpoch(epoch)).toBe(false);
    expect(events).toEqual([]);
  });
});
