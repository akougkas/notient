import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import { EventBus } from "../events/eventBus";
import { AgentEventStore } from "./agentEventStore";

async function makeStore(): Promise<{ database: Database; bus: EventBus; store: AgentEventStore }> {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  const database = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
  await database.init();
  const bus = new EventBus();
  const store = new AgentEventStore({ database, bus });
  return { database, bus, store };
}

describe("AgentEventStore", () => {
  test("record persists a row and returns id + ts", async () => {
    const { store } = await makeStore();
    const before = Date.now();
    const result = store.record("swarm:link_proposed", { edgeId: "edge:a", confidence: 0.9 });
    expect(result.id).toBeGreaterThan(0);
    expect(result.ts).toBeGreaterThanOrEqual(before);
    const rows = store.since(0, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(result.id);
    expect(rows[0].type).toBe("swarm:link_proposed");
  });

  test("since returns rows with id strictly greater than cursor", async () => {
    const { store } = await makeStore();
    const a = store.record("swarm:link_proposed", { tag: "a" });
    const b = store.record("swarm:link_proposed", { tag: "b" });
    const c = store.record("swarm:link_proposed", { tag: "c" });
    const after = store.since(a.id, 10);
    expect(after.map((row) => row.id)).toEqual([b.id, c.id]);
    const fromB = store.since(b.id, 10);
    expect(fromB.map((row) => row.id)).toEqual([c.id]);
  });

  test("since respects the limit and returns ascending order", async () => {
    const { store } = await makeStore();
    for (let index = 0; index < 5; index++) {
      store.record("swarm:link_proposed", { index });
    }
    const rows = store.since(0, 3);
    expect(rows).toHaveLength(3);
    for (let index = 1; index < rows.length; index++) {
      expect(rows[index].id).toBeGreaterThan(rows[index - 1].id);
    }
  });

  test("since parses JSON payloads back to structured objects", async () => {
    const { store } = await makeStore();
    const payload = { edgeId: "edge:42", members: ["a", "b"], score: 0.77 };
    store.record("swarm:cluster_emerged", payload);
    const rows = store.since(0, 1);
    expect(rows[0].payload).toEqual(payload);
  });

  test("latestId returns 0 when empty and the max id after rows", async () => {
    const { store } = await makeStore();
    expect(store.latestId()).toBe(0);
    const first = store.record("swarm:link_proposed", {});
    const second = store.record("swarm:link_proposed", {});
    expect(store.latestId()).toBe(second.id);
    expect(store.latestId()).toBeGreaterThan(first.id);
  });

  test("countSince returns the count of rows after the cursor", async () => {
    const { store } = await makeStore();
    expect(store.countSince(0)).toBe(0);
    const a = store.record("swarm:link_proposed", {});
    store.record("swarm:link_proposed", {});
    store.record("swarm:link_proposed", {});
    expect(store.countSince(0)).toBe(3);
    expect(store.countSince(a.id)).toBe(2);
    expect(store.countSince(store.latestId())).toBe(0);
  });

  test("emits a row when swarm:contradiction_discovered fires on the bus", async () => {
    const { bus, store } = await makeStore();
    const payload = {
      type: "swarm:contradiction_discovered" as const,
      pair: ["claim:a", "claim:b"] as [string, string],
      severity: 0.82,
      notePaths: ["/a.md", "/b.md"] as [string, string],
      runId: 7,
    };
    bus.emit(payload);
    const rows = store.since(0, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("swarm:contradiction_discovered");
    expect(rows[0].payload).toEqual({
      pair: ["claim:a", "claim:b"],
      severity: 0.82,
      notePaths: ["/a.md", "/b.md"],
      runId: 7,
    });
  });

  test("subscribes to all four swarm:* event types", async () => {
    const { bus, store } = await makeStore();
    bus.emit({
      type: "swarm:link_proposed",
      edgeId: "e1",
      sourceId: "n1",
      targetId: "n2",
      edgeType: "supports",
      confidence: 0.7,
      runId: 1,
    });
    bus.emit({
      type: "swarm:cluster_emerged",
      clusterId: "c1",
      memberNodeIds: ["n1", "n2"],
      centroidLabel: "Topic",
      runId: 1,
    });
    bus.emit({
      type: "swarm:contradiction_discovered",
      pair: ["a", "b"],
      severity: 0.9,
      notePaths: ["/a", "/b"],
      runId: 1,
    });
    bus.emit({
      type: "swarm:claim_advanced",
      claimId: "claim:1",
      notePath: "/n.md",
      fromMaturity: "raw",
      toMaturity: "adolescent",
      runId: 1,
    });
    const rows = store.since(0, 10);
    expect(rows.map((row) => row.type)).toEqual([
      "swarm:link_proposed",
      "swarm:cluster_emerged",
      "swarm:contradiction_discovered",
      "swarm:claim_advanced",
    ]);
  });

  test("dispose detaches listeners so further events do not produce rows", async () => {
    const { bus, store } = await makeStore();
    bus.emit({
      type: "swarm:link_proposed",
      edgeId: "e1",
      sourceId: "n1",
      targetId: "n2",
      edgeType: "supports",
      confidence: 0.7,
      runId: 1,
    });
    expect(store.countSince(0)).toBe(1);
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
    expect(store.countSince(0)).toBe(1);
  });
});
