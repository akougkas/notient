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
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../../src/core/db/surreal";
import { EventBus } from "../../../../src/core/events/eventBus";
import type { EventHandler, EventType } from "../../../../src/core/events/types";
import type { AgentEventStore } from "../../../../src/core/services/agentEventStore";
import {
  AGENT_EVENTS_DEFAULT_LIMIT,
  AGENT_EVENTS_DEFAULT_LONG_POLL_MS,
  AGENT_EVENTS_MAX_LIMIT,
  AGENT_EVENTS_MAX_LONG_POLL_MS,
  createAgentEventsHandler,
} from "../../../../src/daemon/handlers/agentEvents";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

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
