import { describe, expect, test } from "bun:test";
import type { Coordinator } from "../../../src/core/coordinator/coordinator";
import { EventBus } from "../../../src/core/events/eventBus";
import { CoordinatorRunner } from "../../../src/daemon/coordinatorRunner";

describe("CoordinatorRunner", () => {
  test("starts coordinator after first indexer:complete", () => {
    const bus = new EventBus();
    let started = 0;
    const coordinator = {
      start: () => {
        started++;
      },
    } as unknown as Coordinator;
    const runner = new CoordinatorRunner({ bus, coordinator });
    runner.arm();
    bus.emit({ type: "indexer:complete", total: 5, durationMs: 1000 });
    expect(started).toBe(1);
  });

  test("does not restart on subsequent indexer:complete", () => {
    const bus = new EventBus();
    let started = 0;
    const coordinator = {
      start: () => {
        started++;
      },
    } as unknown as Coordinator;
    const runner = new CoordinatorRunner({ bus, coordinator });
    runner.arm();
    bus.emit({ type: "indexer:complete", total: 5, durationMs: 1000 });
    bus.emit({ type: "indexer:complete", total: 3, durationMs: 500 });
    expect(started).toBe(1);
  });

  test("disarmed runner does not start", () => {
    const bus = new EventBus();
    let started = 0;
    const coordinator = {
      start: () => {
        started++;
      },
    } as unknown as Coordinator;
    const runner = new CoordinatorRunner({ bus, coordinator });
    runner.arm();
    runner.disarm();
    bus.emit({ type: "indexer:complete", total: 5, durationMs: 1000 });
    expect(started).toBe(0);
  });
});
