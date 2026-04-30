/**
 * Phase 4 Task 12 agent.events handler smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/daemon/handlers/`.
 *
 * Boots a real SurrealDB, applies the Phase 1 schema, and exercises the
 * RPC handler against the SurrealDB-backed AgentEventStore. The wire
 * shape (events / cursor / longPollExpired) is preserved end-to-end; the
 * only behaviour change from the SQLite-era harness is that
 * `store.record` is now async, so test seeders await it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applySchema } from "../../core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../core/db/surreal";
import { EventBus } from "../../core/events/eventBus";
import type { EventHandler, EventType } from "../../core/events/types";
import { AgentEventStore } from "../../core/services/agentEventStore";
import { type SurrealServerHandle, startSurreal } from "../../daemon/surrealServer";
import {
  AGENT_EVENTS_DEFAULT_LIMIT,
  AGENT_EVENTS_DEFAULT_LONG_POLL_MS,
  AGENT_EVENTS_MAX_LIMIT,
  AGENT_EVENTS_MAX_LONG_POLL_MS,
  createAgentEventsHandler,
} from "./agentEvents";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

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

interface TestRig {
  bus: CountingEventBus;
  store: AgentEventStore;
}

async function clearLedger(connection: SurrealConnection): Promise<void> {
  await connection.db.query("DELETE agent_event;").collect();
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function seedClaimAdvanced(store: AgentEventStore, count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    await store.record("swarm:claim_advanced", { claimId: `claim:${index}`, ord: index });
  }
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] agent.events handler", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase4-agentevents-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-agentevents-smoke-"));
    handle = await startSurreal({
      dataDir: path.join(tempDir, "data"),
      secret,
      portFile: path.join(tempDir, "port"),
      pidFile: path.join(tempDir, "pid"),
      logLevel: "warn",
    });
    connection = await connect({
      url: handle.url,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    await applySchema(connection.db, secret);
  });

  afterAll(async () => {
    if (connection !== undefined) {
      await connection.close().catch(() => {});
    }
    if (handle !== undefined) {
      await handle.stop().catch(() => {});
    }
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    await clearLedger(connection);
  });

  function makeRig(): TestRig {
    const bus = new CountingEventBus();
    const store = new AgentEventStore({ db: connection.db, bus });
    return { bus, store };
  }

  test("[smoke] since 0 returns every seeded row and a fresh cursor", async () => {
    const rig = makeRig();
    await seedClaimAdvanced(rig.store, 3);
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
    rig.store.dispose();
  });

  test("[smoke] since <middle> returns only newer rows", async () => {
    const rig = makeRig();
    await seedClaimAdvanced(rig.store, 5);
    const handler = createAgentEventsHandler({
      agentEventStore: rig.store,
      bus: rig.bus,
      flushIntervalMs: 0,
    });
    const all = await rig.store.since(0, 10);
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
    rig.store.dispose();
  });

  test("[smoke] limit clamps the page size and the cursor reflects the highest returned id", async () => {
    const rig = makeRig();
    await seedClaimAdvanced(rig.store, 7);
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
    rig.store.dispose();
  });

  test("[smoke] longPollMs 0 returns immediately with empty events when ledger is empty", async () => {
    const rig = makeRig();
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
    expect(elapsed).toBeLessThan(200);
    rig.store.dispose();
  });

  test("[smoke] indexer:note-indexed fired on the bus lands in the ledger", async () => {
    const rig = makeRig();
    const handler = createAgentEventsHandler({
      agentEventStore: rig.store,
      bus: rig.bus,
      flushIntervalMs: 0,
    });
    rig.bus.emit({
      type: "indexer:note-indexed",
      path: "01-introduction.md",
      result: {
        chunkCount: 3,
        embedCount: 3,
        nodeCount: 1,
        edgeCount: 0,
        durationMs: 12,
      },
    });
    await flush();
    const result = await handler({ since: 0, longPollMs: 0 }, () => {}, "req-idx", "claude-code");
    const events = result.events as Array<{ type: string; payload: { path: string } }>;
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((event) => event.type === "indexer:note-indexed")).toBe(true);
    rig.store.dispose();
  });

  test("[smoke] long-poll resolves when an indexer:note-indexed event fires", async () => {
    const rig = makeRig();
    const handler = createAgentEventsHandler({
      agentEventStore: rig.store,
      bus: rig.bus,
      flushIntervalMs: 100,
    });
    const pending = handler(
      { since: 0, longPollMs: 2000 },
      () => {},
      "req-idx-poll",
      "claude-code",
    );
    setTimeout(() => {
      rig.bus.emit({
        type: "indexer:note-indexed",
        path: "01-introduction.md",
        result: {
          chunkCount: 3,
          embedCount: 3,
          nodeCount: 1,
          edgeCount: 0,
          durationMs: 12,
        },
      });
    }, 25);
    const result = await pending;
    const events = result.events as Array<{ type: string }>;
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].type).toBe("indexer:note-indexed");
    expect(result.longPollExpired).toBe(false);
    rig.store.dispose();
  });

  test("[smoke] long-poll resolves when a swarm event fires before the timeout", async () => {
    const rig = makeRig();
    const handler = createAgentEventsHandler({
      agentEventStore: rig.store,
      bus: rig.bus,
      flushIntervalMs: 100,
    });
    const pending = handler({ since: 0, longPollMs: 2000 }, () => {}, "req-5", "claude-code");
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
    rig.store.dispose();
  });

  test("[smoke] long-poll expires with empty events and unchanged cursor on timeout", async () => {
    const rig = makeRig();
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
    rig.store.dispose();
  });

  test("[smoke] listener cleanup: bus listener counts return to baseline after each call", async () => {
    const rig = makeRig();
    const handler = createAgentEventsHandler({
      agentEventStore: rig.store,
      bus: rig.bus,
      flushIntervalMs: 100,
    });
    const baselinePerType = rig.bus.listenerCount("swarm:link_proposed");
    expect(baselinePerType).toBe(1);
    for (let attempt = 0; attempt < 3; attempt++) {
      const pending = handler(
        { since: 0, longPollMs: 500 },
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
      await flush();
      await clearLedger(connection);
    }
    rig.store.dispose();
  });

  test("[smoke] listener cleanup: timed-out long-poll also detaches every listener", async () => {
    const rig = makeRig();
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
    rig.store.dispose();
  });

  test("[smoke] longPollMs above the ceiling clamps to the documented maximum", async () => {
    const rig = makeRig();
    await seedClaimAdvanced(rig.store, 1);
    const handler = createAgentEventsHandler({
      agentEventStore: rig.store,
      bus: rig.bus,
      flushIntervalMs: 0,
    });
    const result = await handler(
      { since: 0, longPollMs: 99_999_999 },
      () => {},
      "req-clamp",
      "claude-code",
    );
    expect((result.events as unknown[]).length).toBe(1);
    rig.store.dispose();
  });

  test("[smoke] rejects negative since", async () => {
    const rig = makeRig();
    const handler = createAgentEventsHandler({ agentEventStore: rig.store, bus: rig.bus });
    let thrown: unknown = null;
    try {
      await handler({ since: -1 }, () => {}, "req-neg", "claude-code");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("since");
    rig.store.dispose();
  });

  test("[smoke] rejects non-integer since", async () => {
    const rig = makeRig();
    const handler = createAgentEventsHandler({ agentEventStore: rig.store, bus: rig.bus });
    let thrown: unknown = null;
    try {
      await handler({ since: 3.5 }, () => {}, "req-frac", "claude-code");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("since");
    rig.store.dispose();
  });

  test("[smoke] rejects missing since", async () => {
    const rig = makeRig();
    const handler = createAgentEventsHandler({ agentEventStore: rig.store, bus: rig.bus });
    let thrown: unknown = null;
    try {
      await handler({}, () => {}, "req-none", "claude-code");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("since");
    rig.store.dispose();
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

/**
 * Unit-only regression tests for the indexer-event extension. These do not
 * require SurrealDB so they run on every `bun test` invocation. The store is
 * stubbed because the handler only depends on `since(cursor, limit)`; the
 * end-to-end persistence path is exercised by the smoke suite above.
 */
interface StubRow {
  id: number;
  ts: number;
  type: string;
  payload: unknown;
}

class StubAgentEventStore {
  private rows: StubRow[] = [];

  enqueue(row: StubRow): void {
    this.rows.push(row);
  }

  async since(cursor: number, limit: number): Promise<StubRow[]> {
    return this.rows.filter((row) => row.id > cursor).slice(0, limit);
  }
}

describe("agent.events watches indexer events", () => {
  test("long-poll wakes when an indexer:note-indexed event fires", async () => {
    const bus = new EventBus();
    const stub = new StubAgentEventStore();
    const handler = createAgentEventsHandler({
      // Cast: handler only uses `since`, which the stub implements.
      agentEventStore: stub as unknown as AgentEventStore,
      bus,
      flushIntervalMs: 5,
    });
    const pending = handler({ since: 0, longPollMs: 1000 }, () => {}, "req-idx", "claude-code");
    setTimeout(() => {
      // The store stub does not subscribe to the bus, so the handler's read
      // would otherwise return nothing. Seed the row in the same tick the
      // event fires so the post-flush re-read finds it.
      stub.enqueue({
        id: 1,
        ts: Date.now(),
        type: "indexer:note-indexed",
        payload: {
          path: "01-introduction.md",
          result: {
            chunkCount: 3,
            embedCount: 3,
            nodeCount: 1,
            edgeCount: 0,
            durationMs: 12,
          },
        },
      });
      bus.emit({
        type: "indexer:note-indexed",
        path: "01-introduction.md",
        result: {
          chunkCount: 3,
          embedCount: 3,
          nodeCount: 1,
          edgeCount: 0,
          durationMs: 12,
        },
      });
    }, 25);
    const result = await pending;
    const events = result.events as Array<{ type: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("indexer:note-indexed");
    expect(result.longPollExpired).toBe(false);
    expect(result.cursor).toBe(1);
  });

  test("long-poll also wakes on indexer:error and indexer:warn", async () => {
    for (const eventType of ["indexer:error", "indexer:warn"] as const) {
      const bus = new EventBus();
      const stub = new StubAgentEventStore();
      const handler = createAgentEventsHandler({
        agentEventStore: stub as unknown as AgentEventStore,
        bus,
        flushIntervalMs: 5,
      });
      const pending = handler(
        { since: 0, longPollMs: 1000 },
        () => {},
        `req-${eventType}`,
        "claude-code",
      );
      setTimeout(() => {
        stub.enqueue({
          id: 1,
          ts: Date.now(),
          type: eventType,
          payload: { message: "test", phase: "tier1" },
        });
        if (eventType === "indexer:error") {
          bus.emit({ type: eventType, path: "x.md", message: "test", phase: "tier1" });
        } else {
          bus.emit({ type: eventType, message: "test", phase: "tier1" });
        }
      }, 25);
      const result = await pending;
      const events = result.events as Array<{ type: string }>;
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(eventType);
      expect(result.longPollExpired).toBe(false);
    }
  });

  test("long-poll expires cleanly when no watched event fires", async () => {
    const bus = new EventBus();
    const stub = new StubAgentEventStore();
    const handler = createAgentEventsHandler({
      agentEventStore: stub as unknown as AgentEventStore,
      bus,
      flushIntervalMs: 0,
    });
    const result = await handler(
      { since: 0, longPollMs: 60 },
      () => {},
      "req-expire",
      "claude-code",
    );
    expect(result.events).toEqual([]);
    expect(result.longPollExpired).toBe(true);
    expect(result.cursor).toBe(0);
  });

  test("ignored indexer events (progress, tier1-done, tier2-done, tier3-done) do not wake the poll", async () => {
    const bus = new EventBus();
    const stub = new StubAgentEventStore();
    const handler = createAgentEventsHandler({
      agentEventStore: stub as unknown as AgentEventStore,
      bus,
      flushIntervalMs: 0,
    });
    const pending = handler({ since: 0, longPollMs: 80 }, () => {}, "req-noise", "claude-code");
    setTimeout(() => {
      bus.emit({ type: "indexer:progress", processed: 1, total: 10 });
      bus.emit({ type: "indexer:tier1-done", path: "x.md", bodySha: "deadbeef" });
      bus.emit({ type: "indexer:tier2-done", path: "x.md", chunkCount: 2 });
      bus.emit({ type: "indexer:tier3-done", path: "x.md" });
    }, 10);
    const result = await pending;
    expect(result.events).toEqual([]);
    expect(result.longPollExpired).toBe(true);
  });
});
