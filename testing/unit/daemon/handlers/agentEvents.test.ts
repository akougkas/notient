import { describe, expect, test } from "bun:test";
import { createUuidRecordId } from "../../../../src/core/db/recordId";
import { EventBus } from "../../../../src/core/events/eventBus";
import type { AgentEventStore } from "../../../../src/core/services/agentEventStore";
import { createAgentEventsHandler } from "../../../../src/daemon/handlers/agentEvents";
import { agentPrincipal, rpcRequest } from "../../../rpcRequest";

/**
 * Unit-only regression tests for the indexer-event extension. These do not
 * require SurrealDB so they run on every `bun test` invocation. The store is
 * stubbed because these cases only depend on `since(cursor, limit)`.
 */
interface StubRow {
  id: string;
  ts: number;
  type: string;
  payload: unknown;
}

class StubAgentEventStore {
  private rows: StubRow[] = [];

  enqueue(row: StubRow): void {
    this.rows.push(row);
  }

  async since(cursor: string | null, limit: number): Promise<StubRow[]> {
    return this.rows
      .filter((row) => cursor === null || row.id.localeCompare(cursor) > 0)
      .slice(0, limit);
  }

  async snapshot(sinceTs: number, types: readonly string[], limit: number) {
    const events = this.rows
      .filter((row) => row.ts >= sinceTs && types.includes(row.type))
      .slice(-limit);
    return { cursor: this.rows.at(-1)?.id ?? null, events };
  }
}

function eventId(value: number): string {
  return createUuidRecordId(
    "agent_event",
    `018f05cd-3f7b-7000-8000-${value.toString().padStart(12, "0")}`,
  ).toString();
}

describe("agent.events watches indexer events", () => {
  test("returns a filtered recent snapshot with a global continuation cursor", async () => {
    const bus = new EventBus();
    const stub = new StubAgentEventStore();
    stub.enqueue({
      id: eventId(1),
      ts: 1_000,
      type: "swarm:link_proposed",
      payload: { edgeId: "old" },
    });
    stub.enqueue({
      id: eventId(2),
      ts: 2_100,
      type: "swarm:link_proposed",
      payload: { edgeId: "recent" },
    });
    stub.enqueue({
      id: eventId(3),
      ts: 2_200,
      type: "indexer:note-indexed",
      payload: { path: "x.md" },
    });
    const handler = createAgentEventsHandler({
      agentEventStore: stub as unknown as AgentEventStore,
      bus,
    });

    const result = await handler(
      rpcRequest(
        { snapshotSinceMs: 2_000, types: ["swarm:link_proposed"], limit: 20 },
        { requestId: "req-snapshot", principal: agentPrincipal("tui") },
      ),
    );

    expect(result.events).toEqual([
      {
        id: eventId(2),
        ts: 2_100,
        type: "swarm:link_proposed",
        payload: { edgeId: "recent" },
      },
    ]);
    expect(result.cursor).toBe(eventId(3));
    expect(result.longPollExpired).toBe(false);
  });

  test("rejects cursor polling fields in snapshot mode", async () => {
    const handler = createAgentEventsHandler({
      agentEventStore: new StubAgentEventStore() as unknown as AgentEventStore,
      bus: new EventBus(),
    });
    await expect(
      handler(
        rpcRequest(
          { snapshotSinceMs: 2_000, types: ["swarm:link_proposed"], since: eventId(0) },
          { requestId: "req-invalid-snapshot", principal: agentPrincipal("tui") },
        ),
      ),
    ).rejects.toThrow("snapshotSinceMs cannot be combined");
  });

  test("long-poll wakes when an indexer:note-indexed event fires", async () => {
    const bus = new EventBus();
    const stub = new StubAgentEventStore();
    const handler = createAgentEventsHandler({
      // Cast: handler only uses `since`, which the stub implements.
      agentEventStore: stub as unknown as AgentEventStore,
      bus,
      flushIntervalMs: 5,
    });
    const pending = handler(
      rpcRequest(
        { since: null, longPollMs: 1000 },
        { requestId: "req-idx", principal: agentPrincipal() },
      ),
    );
    setTimeout(() => {
      // The store stub does not subscribe to the bus, so the handler's read
      // would otherwise return nothing. Seed the row in the same tick the
      // event fires so the post-flush re-read finds it.
      stub.enqueue({
        id: eventId(1),
        ts: Date.now(),
        type: "indexer:note-indexed",
        payload: {
          path: "01-introduction.md",
          result: {
            chunkCount: 3,
            embedCount: 3,
            durationMs: 12,
            llmCalls: 1,
            extractionWindows: 1,
          },
        },
      });
      bus.emit({
        type: "indexer:note-indexed",
        path: "01-introduction.md",
        result: {
          chunkCount: 3,
          embedCount: 3,
          durationMs: 12,
          llmCalls: 1,
          extractionWindows: 1,
        },
      });
    }, 25);
    const result = await pending;
    const events = result.events as Array<{ type: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("indexer:note-indexed");
    expect(result.longPollExpired).toBe(false);
    expect(result.cursor).toBe(eventId(1));
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
        rpcRequest(
          { since: null, longPollMs: 1000 },
          { requestId: `req-${eventType}`, principal: agentPrincipal() },
        ),
      );
      setTimeout(() => {
        stub.enqueue({
          id: eventId(1),
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

  test("long-poll wakes on indexer:tombstoned and returns its path payload", async () => {
    const bus = new EventBus();
    const stub = new StubAgentEventStore();
    const handler = createAgentEventsHandler({
      agentEventStore: stub as unknown as AgentEventStore,
      bus,
      flushIntervalMs: 0,
    });
    const pending = handler(
      rpcRequest(
        { since: eventId(4), longPollMs: 1000 },
        { requestId: "req-tombstone", principal: agentPrincipal() },
      ),
    );
    setTimeout(() => {
      stub.enqueue({
        id: eventId(5),
        ts: 1_700_000_000_000,
        type: "indexer:tombstoned",
        payload: { path: "Archive/deleted.md" },
      });
      bus.emit({ type: "indexer:tombstoned", path: "Archive/deleted.md" });
    }, 10);

    const result = await pending;

    expect(result.events).toEqual([
      {
        id: eventId(5),
        ts: 1_700_000_000_000,
        type: "indexer:tombstoned",
        payload: { path: "Archive/deleted.md" },
      },
    ]);
    expect(result.cursor).toBe(eventId(5));
    expect(result.longPollExpired).toBe(false);
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
      rpcRequest(
        { since: null, longPollMs: 60 },
        { requestId: "req-expire", principal: agentPrincipal() },
      ),
    );
    expect(result.events).toEqual([]);
    expect(result.longPollExpired).toBe(true);
    expect(result.cursor).toBeNull();
  });

  test("ignored indexer events (progress, tier1-done, tier2-done, tier3-done) do not wake the poll", async () => {
    const bus = new EventBus();
    const stub = new StubAgentEventStore();
    const handler = createAgentEventsHandler({
      agentEventStore: stub as unknown as AgentEventStore,
      bus,
      flushIntervalMs: 0,
    });
    const pending = handler(
      rpcRequest(
        { since: null, longPollMs: 80 },
        { requestId: "req-noise", principal: agentPrincipal() },
      ),
    );
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
