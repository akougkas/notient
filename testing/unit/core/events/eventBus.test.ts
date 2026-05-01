import { describe, expect, test } from "bun:test";
import { EventBus } from "../../../../src/core/events/eventBus";

describe("EventBus", () => {
  test("subscribers receive emitted events of matching type", () => {
    const bus = new EventBus();
    const received: { value: { processed: number; total: number } | null } = {
      value: null,
    };
    bus.on("indexer:progress", (event) => {
      received.value = { processed: event.processed, total: event.total };
    });
    bus.emit({ type: "indexer:progress", processed: 5, total: 10 });
    expect(received.value).toEqual({ processed: 5, total: 10 });
  });

  test("unsubscribe stops delivery", () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.on("indexer:complete", () => count++);
    bus.emit({ type: "indexer:complete", total: 1 });
    off();
    bus.emit({ type: "indexer:complete", total: 1 });
    expect(count).toBe(1);
  });

  test("subscribers of other event types do not receive", () => {
    const bus = new EventBus();
    let received = false;
    bus.on("llm:health", () => {
      received = true;
    });
    bus.emit({ type: "indexer:complete", total: 1 });
    expect(received).toBe(false);
  });

  test("handler error does not stop other handlers", () => {
    const bus = new EventBus();
    bus.on("indexer:complete", () => {
      throw new Error("boom");
    });
    let other = false;
    bus.on("indexer:complete", () => {
      other = true;
    });
    bus.emit({ type: "indexer:complete", total: 1 });
    expect(other).toBe(true);
  });
});
