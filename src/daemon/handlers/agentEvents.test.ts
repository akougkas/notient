import { describe, expect, test } from "bun:test";
import { Database } from "../../core/db/database";
import { MemoryAdapter, loadWasm } from "../../core/db/database.test";
import { EventBus } from "../../core/events/eventBus";
import type { EventHandler, EventType } from "../../core/events/types";
import { AgentEventStore } from "../../core/services/agentEventStore";
import {
  AGENT_EVENTS_DEFAULT_LIMIT,
  AGENT_EVENTS_DEFAULT_LONG_POLL_MS,
  AGENT_EVENTS_MAX_LIMIT,
  AGENT_EVENTS_MAX_LONG_POLL_MS,
  createAgentEventsHandler,
} from "./agentEvents";

interface TestRig {
  database: Database;
  bus: CountingEventBus;
  store: AgentEventStore;
}

/**
 * EventBus subclass that exposes a per-type listener count. The handler under
 * test attaches four listeners on the long-poll path; the leak assertion
 * verifies the count returns to its baseline (the store's own four listeners)
 * after the call resolves.
 */
class CountingEventBus extends EventBus {
  listenerCount(type: EventType): number {
    const handlers = (this as unknown as { handlers: Map<EventType, Set<unknown>> }).handlers;
    const set = handlers.get(type);
    return set ? set.size : 0;
  }
  on<T extends EventType>(type: T, handler: EventHandler<T>): () => void {
    return super.on(type, handler);
  }
}

async function makeRig(): Promise<TestRig> {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  const database = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
  await database.init();
  const bus = new CountingEventBus();
  const store = new AgentEventStore({ database, bus });
  return { database, bus, store };
}

function seedClaimAdvanced(store: AgentEventStore, count: number): void {
  for (let index = 0; index < count; index++) {
    store.record("swarm:claim_advanced", { claimId: `claim:${index}`, ord: index });
  }
}

describe("agent.events handler", () => {
  test("since 0 returns every seeded row and a fresh cursor", async () => {
    const rig = await makeRig();
    seedClaimAdvanced(rig.store, 3);
    const handler = createAgentEventsHandler({
      agentEventStore: rig.store,
      bus: rig.bus,
      flushIntervalMs: 0,
    });
    const result = await handler({ since: 0, longPollMs: 0 }, () => {}, "req-1", "claude-code");
    const events = result.events as Array<{ id: number; type: string }>;
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.type)).toEqual([
      "swarm:claim_advanced",
      "swarm:claim_advanced",
      "swarm:claim_advanced",
    ]);
    expect(result.cursor).toBe(events[2].id);
    expect(result.longPollExpired).toBe(false);
    expect(result.ok).toBe(true);
  });

  test("since <middle> returns only newer rows", async () => {
    const rig = await makeRig();
    seedClaimAdvanced(rig.store, 5);
    const handler = createAgentEventsHandler({
      agentEventStore: rig.store,
      bus: rig.bus,
      flushIntervalMs: 0,
    });
    const all = rig.store.since(0, 10);
    const middleId = all[2].id;
    const result = await handler(
      { since: middleId, longPollMs: 0 },
      () => {},
      "req-2",
      "claude-code",
    );
    const events = result.events as Array<{ id: number }>;
    expect(events.map((event) => event.id)).toEqual([all[3].id, all[4].id]);
    expect(result.cursor).toBe(all[4].id);
    expect(result.longPollExpired).toBe(false);
  });

  test("limit clamps the page size and the cursor reflects the highest returned id", async () => {
    const rig = await makeRig();
    seedClaimAdvanced(rig.store, 7);
    const handler = createAgentEventsHandler({
      agentEventStore: rig.store,
      bus: rig.bus,
      flushIntervalMs: 0,
    });
    const result = await handler(
      { since: 0, limit: 3, longPollMs: 0 },
      () => {},
      "req-3",
      "claude-code",
    );
    const events = result.events as Array<{ id: number }>;
    expect(events).toHaveLength(3);
    expect(result.cursor).toBe(events[2].id);
  });

  test("longPollMs 0 returns immediately with empty events when ledger is empty", async () => {
    const rig = await makeRig();
    const handler = createAgentEventsHandler({
      agentEventStore: rig.store,
      bus: rig.bus,
      flushIntervalMs: 0,
    });
    const startedAt = Date.now();
    const result = await handler({ since: 0, longPollMs: 0 }, () => {}, "req-4", "claude-code");
    const elapsed = Date.now() - startedAt;
    expect(result.events).toEqual([]);
    expect(result.cursor).toBe(0);
    expect(result.longPollExpired).toBe(false);
    expect(elapsed).toBeLessThan(50);
  });

  test("long-poll resolves when a swarm event fires before the timeout", async () => {
    const rig = await makeRig();
    const handler = createAgentEventsHandler({
      agentEventStore: rig.store,
      bus: rig.bus,
      flushIntervalMs: 0,
    });
    const pending = handler({ since: 0, longPollMs: 1000 }, () => {}, "req-5", "claude-code");
    setTimeout(() => {
      rig.bus.emit({
        type: "swarm:link_proposed",
        edgeId: "edge:1",
        sourceId: "n1",
        targetId: "n2",
        edgeType: "supports",
        confidence: 0.9,
        runId: 1,
      });
    }, 25);
    const result = await pending;
    const events = result.events as Array<{ type: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("swarm:link_proposed");
    expect(result.longPollExpired).toBe(false);
    expect(typeof result.cursor).toBe("number");
    expect(result.cursor).toBeGreaterThan(0);
  });

  test("long-poll expires with empty events and unchanged cursor on timeout", async () => {
    const rig = await makeRig();
    const handler = createAgentEventsHandler({
      agentEventStore: rig.store,
      bus: rig.bus,
      flushIntervalMs: 0,
    });
    const startedAt = Date.now();
    const result = await handler({ since: 7, longPollMs: 80 }, () => {}, "req-6", "claude-code");
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(result.events).toEqual([]);
    expect(result.cursor).toBe(7);
    expect(result.longPollExpired).toBe(true);
  });

  test("listener cleanup: bus listener counts return to baseline after each call", async () => {
    const rig = await makeRig();
    const handler = createAgentEventsHandler({
      agentEventStore: rig.store,
      bus: rig.bus,
      flushIntervalMs: 0,
    });
    const baselinePerType = rig.bus.listenerCount("swarm:link_proposed");
    expect(baselinePerType).toBe(1);
    for (let attempt = 0; attempt < 3; attempt++) {
      const pending = handler(
        { since: 0, longPollMs: 200 },
        () => {},
        `req-${attempt}`,
        "claude-code",
      );
      setTimeout(() => {
        rig.bus.emit({
          type: "swarm:cluster_emerged",
          clusterId: `c-${attempt}`,
          memberNodeIds: ["n1"],
          centroidLabel: "topic",
          runId: attempt,
        });
      }, 10);
      await pending;
      expect(rig.bus.listenerCount("swarm:link_proposed")).toBe(baselinePerType);
      expect(rig.bus.listenerCount("swarm:cluster_emerged")).toBe(baselinePerType);
      expect(rig.bus.listenerCount("swarm:claim_advanced")).toBe(baselinePerType);
      expect(rig.bus.listenerCount("swarm:contradiction_discovered")).toBe(baselinePerType);
    }
  });

  test("listener cleanup: timed-out long-poll also detaches every listener", async () => {
    const rig = await makeRig();
    const handler = createAgentEventsHandler({
      agentEventStore: rig.store,
      bus: rig.bus,
      flushIntervalMs: 0,
    });
    const baseline = rig.bus.listenerCount("swarm:link_proposed");
    await handler({ since: 0, longPollMs: 50 }, () => {}, "req-timeout", "claude-code");
    expect(rig.bus.listenerCount("swarm:link_proposed")).toBe(baseline);
    expect(rig.bus.listenerCount("swarm:cluster_emerged")).toBe(baseline);
    expect(rig.bus.listenerCount("swarm:claim_advanced")).toBe(baseline);
    expect(rig.bus.listenerCount("swarm:contradiction_discovered")).toBe(baseline);
  });

  test("longPollMs above the ceiling clamps to the documented maximum", async () => {
    const rig = await makeRig();
    seedClaimAdvanced(rig.store, 1);
    const handler = createAgentEventsHandler({
      agentEventStore: rig.store,
      bus: rig.bus,
      flushIntervalMs: 0,
    });
    // First read returns rows so we never enter the long-poll path; we only
    // exercise the parser here to assert the clamp does not throw.
    const result = await handler(
      { since: 0, longPollMs: 99_999_999 },
      () => {},
      "req-clamp",
      "claude-code",
    );
    expect((result.events as unknown[]).length).toBe(1);
  });

  test("rejects negative since", async () => {
    const rig = await makeRig();
    const handler = createAgentEventsHandler({ agentEventStore: rig.store, bus: rig.bus });
    let thrown: unknown = null;
    try {
      await handler({ since: -1 }, () => {}, "req-neg", "claude-code");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("since");
  });

  test("rejects non-integer since", async () => {
    const rig = await makeRig();
    const handler = createAgentEventsHandler({ agentEventStore: rig.store, bus: rig.bus });
    let thrown: unknown = null;
    try {
      await handler({ since: 3.5 }, () => {}, "req-frac", "claude-code");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("since");
  });

  test("rejects missing since", async () => {
    const rig = await makeRig();
    const handler = createAgentEventsHandler({ agentEventStore: rig.store, bus: rig.bus });
    let thrown: unknown = null;
    try {
      await handler({}, () => {}, "req-none", "claude-code");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("since");
  });
});

describe("agent.events defaults", () => {
  test("constants stay aligned with the RPC contract", () => {
    expect(AGENT_EVENTS_DEFAULT_LIMIT).toBe(100);
    expect(AGENT_EVENTS_MAX_LIMIT).toBe(1000);
    expect(AGENT_EVENTS_DEFAULT_LONG_POLL_MS).toBe(30_000);
    expect(AGENT_EVENTS_MAX_LONG_POLL_MS).toBe(60_000);
  });
});
