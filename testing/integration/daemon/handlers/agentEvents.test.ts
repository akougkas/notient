/**
 * agent.events handler smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/daemon/handlers/`.
 *
 * Boots a real SurrealDB, applies the Phase 1 schema, and exercises the
 * RPC handler against the SurrealDB-backed AgentEventStore.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../../src/core/db/surreal";
import { EventBus } from "../../../../src/core/events/eventBus";
import type { EventHandler, EventType } from "../../../../src/core/events/types";
import {
  type AgentEventCursor,
  AgentEventStore,
} from "../../../../src/core/services/agentEventStore";
import {
  AGENT_EVENTS_DEFAULT_LIMIT,
  AGENT_EVENTS_DEFAULT_LONG_POLL_MS,
  AGENT_EVENTS_MAX_LIMIT,
  AGENT_EVENTS_MAX_LONG_POLL_MS,
  createAgentEventsHandler,
} from "../../../../src/daemon/handlers/agentEvents";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";
import { agentPrincipal, rpcRequest } from "../../../rpcRequest";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";
const AGENT_RUN_ID = 'agent_run:u"00000000-0000-4000-8000-000000000001"';

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

async function waitForEvent(
  store: AgentEventStore,
  cursor: AgentEventCursor,
  type: string,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await store.since(cursor, 100);
    if (rows.some((row) => row.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${type}`);
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
      hnswCacheMib: 64,
    });
    connection = await connect({
      url: handle.url,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    await applySchema(connection.db, secret, { embedDim: 768, embedModel: "fixture-embedding" });
  }, 30_000);

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
  }, 30_000);

  afterEach(async () => {
    await clearLedger(connection);
  });

  function makeRig(): TestRig {
    const bus = new CountingEventBus();
    const store = new AgentEventStore({ db: connection.db, bus, maxRows: 50_000 });
    return { bus, store };
  }

  test("[smoke] a null cursor returns every retained row and a fresh cursor", async () => {
    const rig = makeRig();
    await seedClaimAdvanced(rig.store, 3);
    const handler = createAgentEventsHandler({
      agentEventStore: rig.store,
      bus: rig.bus,
      flushIntervalMs: 0,
    });
    const result = await handler(
      rpcRequest({ since: null, longPollMs: 0 }, { principal: agentPrincipal() }),
    );
    const events = result.events as Array<{ id: string; type: string }>;
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
    const all = await rig.store.since(null, 10);
    const middleId = all[2].id;
    const result = await handler(
      rpcRequest(
        { since: middleId, longPollMs: 0 },
        { requestId: "req-2", principal: agentPrincipal() },
      ),
    );
    const events = result.events as Array<{ id: string }>;
    expect(events.map((event) => event.id)).toEqual([all[3].id, all[4].id]);
    expect(result.cursor).toBe(all[4].id);
    expect(result.longPollExpired).toBe(false);
    rig.store.dispose();
  });

  test("[smoke] limit bounds the page and the cursor reflects its newest id", async () => {
    const rig = makeRig();
    await seedClaimAdvanced(rig.store, 7);
    const handler = createAgentEventsHandler({
      agentEventStore: rig.store,
      bus: rig.bus,
      flushIntervalMs: 0,
    });
    const result = await handler(
      rpcRequest(
        { since: null, limit: 3, longPollMs: 0 },
        { requestId: "req-3", principal: agentPrincipal() },
      ),
    );
    const events = result.events as Array<{ id: string }>;
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
    const result = await handler(
      rpcRequest(
        { since: null, longPollMs: 0 },
        { requestId: "req-4", principal: agentPrincipal() },
      ),
    );
    const elapsed = Date.now() - startedAt;
    expect(result.events).toEqual([]);
    expect(result.cursor).toBeNull();
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
        durationMs: 12,
        llmCalls: 1,
        extractionWindows: 1,
      },
    });
    await flush();
    const result = await handler(
      rpcRequest(
        { since: null, longPollMs: 0 },
        { requestId: "req-idx", principal: agentPrincipal() },
      ),
    );
    const events = result.events as Array<{ type: string; payload: { path: string } }>;
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((event) => event.type === "indexer:note-indexed")).toBe(true);
    rig.store.dispose();
  });

  test("[smoke] emitted tombstone is returned with its path in cursor order", async () => {
    const rig = makeRig();
    const before = await rig.store.record("swarm:claim_advanced", {
      claimId: "claim:before-delete",
    });
    rig.bus.emit({ type: "indexer:tombstoned", path: "Archive/deleted.md" });
    await waitForEvent(rig.store, before.id, "indexer:tombstoned");
    const after = await rig.store.record("swarm:claim_advanced", {
      claimId: "claim:after-delete",
    });
    const handler = createAgentEventsHandler({
      agentEventStore: rig.store,
      bus: rig.bus,
      flushIntervalMs: 0,
    });

    const result = await handler(
      rpcRequest(
        { since: before.id, longPollMs: 0 },
        { requestId: "req-tombstone", principal: agentPrincipal() },
      ),
    );
    const events = result.events as Array<{
      id: string;
      type: string;
      payload: Record<string, unknown>;
    }>;

    expect(events.map((event) => event.type)).toEqual([
      "indexer:tombstoned",
      "swarm:claim_advanced",
    ]);
    expect(events[0].payload).toEqual({ path: "Archive/deleted.md" });
    expect(events[0].id.localeCompare(before.id)).toBeGreaterThan(0);
    expect(events[1].id.localeCompare(events[0].id)).toBeGreaterThan(0);
    expect(result.cursor).toBe(after.id);
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
      rpcRequest(
        { since: null, longPollMs: 2000 },
        { requestId: "req-idx-poll", principal: agentPrincipal() },
      ),
    );
    setTimeout(() => {
      rig.bus.emit({
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
    const pending = handler(
      rpcRequest(
        { since: null, longPollMs: 2000 },
        { requestId: "req-5", principal: agentPrincipal() },
      ),
    );
    setTimeout(() => {
      rig.bus.emit({
        type: "swarm:link_proposed",
        edgeId: "edge:1",
        sourceId: "n1",
        targetId: "n2",
        edgeType: "supports",
        confidence: 0.9,
        runId: AGENT_RUN_ID,
      });
    }, 25);
    const result = await pending;
    const events = result.events as Array<{ type: string; payload: { runId?: unknown } }>;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("swarm:link_proposed");
    expect(events[0].payload.runId).toBe(AGENT_RUN_ID);
    expect(result.longPollExpired).toBe(false);
    expect(typeof result.cursor).toBe("string");
    expect(result.cursor).toStartWith("agent_event:");
    rig.store.dispose();
  });

  test("[smoke] long-poll expires with empty events and unchanged cursor on timeout", async () => {
    const rig = makeRig();
    const handler = createAgentEventsHandler({
      agentEventStore: rig.store,
      bus: rig.bus,
      flushIntervalMs: 0,
    });
    const cursor = (await rig.store.record("swarm:claim_advanced", { claimId: "prior" })).id;
    const startedAt = Date.now();
    const result = await handler(
      rpcRequest(
        { since: cursor, longPollMs: 80 },
        { requestId: "req-6", principal: agentPrincipal() },
      ),
    );
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(result.events).toEqual([]);
    expect(result.cursor).toBe(cursor);
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
        rpcRequest(
          { since: null, longPollMs: 500 },
          { requestId: `req-${attempt}`, principal: agentPrincipal() },
        ),
      );
      setTimeout(() => {
        rig.bus.emit({
          type: "swarm:claim_advanced",
          claimId: `claim-${attempt}`,
          notePath: "note.md",
          fromMaturity: "raw",
          toMaturity: "adolescent",
          runId: AGENT_RUN_ID,
        });
      }, 10);
      await pending;
      expect(rig.bus.listenerCount("swarm:link_proposed")).toBe(baselinePerType);
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
    await handler(
      rpcRequest(
        { since: null, longPollMs: 50 },
        { requestId: "req-timeout", principal: agentPrincipal() },
      ),
    );
    expect(rig.bus.listenerCount("swarm:link_proposed")).toBe(baseline);
    expect(rig.bus.listenerCount("swarm:claim_advanced")).toBe(baseline);
    expect(rig.bus.listenerCount("swarm:contradiction_discovered")).toBe(baseline);
    rig.store.dispose();
  });

  test("[smoke] longPollMs above the ceiling is rejected", async () => {
    const rig = makeRig();
    await seedClaimAdvanced(rig.store, 1);
    const handler = createAgentEventsHandler({
      agentEventStore: rig.store,
      bus: rig.bus,
      flushIntervalMs: 0,
    });
    await expect(
      handler(
        rpcRequest(
          { since: null, longPollMs: 99_999_999 },
          { requestId: "req-ceiling", principal: agentPrincipal() },
        ),
      ),
    ).rejects.toThrow(/longPollMs/);
    rig.store.dispose();
  });

  test("[smoke] rejects a numeric cursor", async () => {
    const rig = makeRig();
    const handler = createAgentEventsHandler({ agentEventStore: rig.store, bus: rig.bus });
    let thrown: unknown = null;
    try {
      await handler(rpcRequest({ since: -1 }, { principal: agentPrincipal() }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("since");
    rig.store.dispose();
  });

  test("[smoke] rejects a record id from another table", async () => {
    const rig = makeRig();
    const handler = createAgentEventsHandler({ agentEventStore: rig.store, bus: rig.bus });
    let thrown: unknown = null;
    try {
      await handler(rpcRequest({ since: "note:wrong" }, { principal: agentPrincipal() }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("since");
    rig.store.dispose();
  });

  test("[smoke] missing since means the retained beginning", async () => {
    const rig = makeRig();
    const handler = createAgentEventsHandler({ agentEventStore: rig.store, bus: rig.bus });
    await seedClaimAdvanced(rig.store, 1);
    const result = await handler(rpcRequest({ longPollMs: 0 }, { principal: agentPrincipal() }));
    expect(result.events as unknown[]).toHaveLength(1);
    rig.store.dispose();
  });
});
