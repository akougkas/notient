/**
 * Phase 4 Task 12 AgentEventStore smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/core/services/`.
 *
 * Boots a real SurrealDB, applies the Phase 1 schema (which now includes
 * the `agent_event` table added by Task 12), and exercises the
 * record/since/latestId/countSince/dispose surface end-to-end. Each test
 * truncates the table in `afterEach` so ordering assertions stay
 * independent.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type SurrealServerHandle, startSurreal } from "../../daemon/surrealServer";
import { applySchema } from "../db/schemaApplier";
import { type SurrealConnection, connect } from "../db/surreal";
import { EventBus } from "../events/eventBus";
import { AgentEventStore } from "./agentEventStore";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

async function clearLedger(connection: SurrealConnection): Promise<void> {
  await connection.db.query("DELETE agent_event;").collect();
}

async function flush(): Promise<void> {
  // Bus subscribers fire-and-forget the SurrealDB write because EventBus.emit
  // is synchronous; tests that observe the resulting row through `since`
  // need to yield twice (once to drain microtasks for the Surreal SDK
  // promise, once to absorb the trailing post-resolution work).
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] AgentEventStore", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase4-agentevent-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-agentevent-smoke-"));
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

  test("[smoke] record persists a row and returns id + ts", async () => {
    const bus = new EventBus();
    const store = new AgentEventStore({ db: connection.db, bus });
    const before = Date.now();
    const result = await store.record("swarm:link_proposed", {
      edgeId: "edge:a",
      confidence: 0.9,
    });
    expect(result.id).toBeGreaterThan(0);
    expect(result.ts).toBeGreaterThanOrEqual(before);
    const rows = await store.since(0, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(result.id);
    expect(rows[0].type).toBe("swarm:link_proposed");
    store.dispose();
  });

  test("[smoke] since returns rows with id strictly greater than cursor", async () => {
    const bus = new EventBus();
    const store = new AgentEventStore({ db: connection.db, bus });
    const a = await store.record("swarm:link_proposed", { tag: "a" });
    const b = await store.record("swarm:link_proposed", { tag: "b" });
    const c = await store.record("swarm:link_proposed", { tag: "c" });
    const after = await store.since(a.id, 10);
    expect(after.map((row) => row.id)).toEqual([b.id, c.id]);
    const fromB = await store.since(b.id, 10);
    expect(fromB.map((row) => row.id)).toEqual([c.id]);
    store.dispose();
  });

  test("[smoke] since respects the limit and returns ascending order", async () => {
    const bus = new EventBus();
    const store = new AgentEventStore({ db: connection.db, bus });
    for (let index = 0; index < 5; index++) {
      await store.record("swarm:link_proposed", { index });
    }
    const rows = await store.since(0, 3);
    expect(rows).toHaveLength(3);
    for (let index = 1; index < rows.length; index++) {
      expect(rows[index].id).toBeGreaterThan(rows[index - 1].id);
    }
    store.dispose();
  });

  test("[smoke] since parses JSON payloads back to structured objects", async () => {
    const bus = new EventBus();
    const store = new AgentEventStore({ db: connection.db, bus });
    const payload = { edgeId: "edge:42", members: ["a", "b"], score: 0.77 };
    await store.record("swarm:cluster_emerged", payload);
    const rows = await store.since(0, 1);
    expect(rows[0].payload).toEqual(payload);
    store.dispose();
  });

  test("[smoke] latestId returns 0 when empty and the max id after rows", async () => {
    const bus = new EventBus();
    const store = new AgentEventStore({ db: connection.db, bus });
    expect(await store.latestId()).toBe(0);
    const first = await store.record("swarm:link_proposed", {});
    const second = await store.record("swarm:link_proposed", {});
    expect(await store.latestId()).toBe(second.id);
    expect(await store.latestId()).toBeGreaterThan(first.id);
    store.dispose();
  });

  test("[smoke] countSince returns the count of rows after the cursor", async () => {
    const bus = new EventBus();
    const store = new AgentEventStore({ db: connection.db, bus });
    expect(await store.countSince(0)).toBe(0);
    const a = await store.record("swarm:link_proposed", {});
    await store.record("swarm:link_proposed", {});
    await store.record("swarm:link_proposed", {});
    expect(await store.countSince(0)).toBe(3);
    expect(await store.countSince(a.id)).toBe(2);
    expect(await store.countSince(await store.latestId())).toBe(0);
    store.dispose();
  });

  test("[smoke] emits a row when swarm:contradiction_discovered fires on the bus", async () => {
    const bus = new EventBus();
    const store = new AgentEventStore({ db: connection.db, bus });
    const payload = {
      type: "swarm:contradiction_discovered" as const,
      pair: ["claim:a", "claim:b"] as [string, string],
      severity: 0.82,
      notePaths: ["/a.md", "/b.md"] as [string, string],
      runId: 7,
    };
    bus.emit(payload);
    await flush();
    const rows = await store.since(0, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("swarm:contradiction_discovered");
    expect(rows[0].payload).toEqual({
      pair: ["claim:a", "claim:b"],
      severity: 0.82,
      notePaths: ["/a.md", "/b.md"],
      runId: 7,
    });
    store.dispose();
  });

  test("[smoke] subscribes to all four swarm:* event types", async () => {
    const bus = new EventBus();
    const store = new AgentEventStore({ db: connection.db, bus });
    bus.emit({
      type: "swarm:link_proposed",
      edgeId: "e1",
      sourceId: "n1",
      targetId: "n2",
      edgeType: "supports",
      confidence: 0.7,
      runId: 1,
    });
    await flush();
    bus.emit({
      type: "swarm:cluster_emerged",
      clusterId: "c1",
      memberNodeIds: ["n1", "n2"],
      centroidLabel: "Topic",
      runId: 1,
    });
    await flush();
    bus.emit({
      type: "swarm:contradiction_discovered",
      pair: ["a", "b"],
      severity: 0.9,
      notePaths: ["/a", "/b"],
      runId: 1,
    });
    await flush();
    bus.emit({
      type: "swarm:claim_advanced",
      claimId: "claim:1",
      notePath: "/n.md",
      fromMaturity: "raw",
      toMaturity: "adolescent",
      runId: 1,
    });
    await flush();
    const rows = await store.since(0, 10);
    expect(rows.map((row) => row.type)).toEqual([
      "swarm:link_proposed",
      "swarm:cluster_emerged",
      "swarm:contradiction_discovered",
      "swarm:claim_advanced",
    ]);
    store.dispose();
  });

  test("[smoke] dispose detaches listeners so further events do not produce rows", async () => {
    const bus = new EventBus();
    const store = new AgentEventStore({ db: connection.db, bus });
    bus.emit({
      type: "swarm:link_proposed",
      edgeId: "e1",
      sourceId: "n1",
      targetId: "n2",
      edgeType: "supports",
      confidence: 0.7,
      runId: 1,
    });
    await flush();
    expect(await store.countSince(0)).toBe(1);
    store.dispose();
    bus.emit({
      type: "swarm:link_proposed",
      edgeId: "e2",
      sourceId: "n1",
      targetId: "n3",
      edgeType: "supports",
      confidence: 0.7,
      runId: 1,
    });
    await flush();
    expect(await store.countSince(0)).toBe(1);
  });
});
