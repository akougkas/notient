import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import { EventBus } from "../events/eventBus";
import { StreamService } from "./streamService";

async function freshDb() {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
  await db.init();
  return db;
}

function seedEdge(
  db: Database,
  options: {
    id: string;
    source: string;
    target: string;
    confidence: number;
    agent: string;
    evidence: string[];
    createdAt: number;
  },
): void {
  db.run(
    `INSERT INTO staging_edges (id, type, source_id, target_id, confidence, agent, evidence, rationale, created_at)
     VALUES (?,?,?,?,?,?,?,?,?);`,
    [
      options.id,
      "supports",
      options.source,
      options.target,
      options.confidence,
      options.agent,
      JSON.stringify(options.evidence),
      null,
      options.createdAt,
    ],
  );
}

function seedNode(db: Database, id: string): void {
  db.run(
    "INSERT INTO graph_nodes (id, type, label, note_path, payload, created_at) VALUES (?,?,?,?,?,?);",
    [id, "note", id.replace(/^note:/, ""), id.replace(/^note:/, ""), null, 1],
  );
}

describe("StreamService", () => {
  test("ranks pending edges by confidence x recency x relevance", async () => {
    const db = await freshDb();
    seedNode(db, "note:/active.md");
    seedNode(db, "note:/other.md");
    const now = 100_000_000;
    seedEdge(db, {
      id: "e1",
      source: "note:/active.md",
      target: "note:/other.md",
      confidence: 0.9,
      agent: "linker",
      evidence: ["c1"],
      createdAt: now,
    });
    seedEdge(db, {
      id: "e2",
      source: "note:/x.md",
      target: "note:/y.md",
      confidence: 0.95,
      agent: "synthesizer",
      evidence: ["c2"],
      createdAt: now,
    });
    const bus = new EventBus();
    const service = new StreamService({
      db,
      bus,
      now: () => now,
      getActivePath: () => "/active.md",
      settings: () => ({ recencyHalfLifeHours: 12, offNoteRelevanceFloor: 0.3, maxItems: 50 }),
    });
    service.refresh();
    const items = service.items.value;
    expect(items[0].id).toBe("e1");
    expect(items[1].id).toBe("e2");
    expect(items[0].score).toBeGreaterThan(items[1].score);
  });

  test("skips items whose decision is set", async () => {
    const db = await freshDb();
    seedNode(db, "note:/a.md");
    seedNode(db, "note:/b.md");
    seedEdge(db, {
      id: "e1",
      source: "note:/a.md",
      target: "note:/b.md",
      confidence: 0.9,
      agent: "linker",
      evidence: ["c1"],
      createdAt: 1,
    });
    db.run("UPDATE staging_edges SET decision = 'rejected', decided_at = ? WHERE id = ?;", [
      2,
      "e1",
    ]);
    const bus = new EventBus();
    const service = new StreamService({
      db,
      bus,
      now: () => 2,
      getActivePath: () => null,
      settings: () => ({ recencyHalfLifeHours: 12, offNoteRelevanceFloor: 0.3, maxItems: 50 }),
    });
    service.refresh();
    expect(service.items.value).toEqual([]);
  });

  test("includes pending staging_nodes alongside edges", async () => {
    const db = await freshDb();
    db.run(
      "INSERT INTO staging_nodes (id, type, label, note_path, payload, agent, confidence, created_at) VALUES (?,?,?,?,?,?,?,?);",
      ["n1", "claim", "Big idea", "/active.md", null, "synthesizer", 0.85, 1],
    );
    const bus = new EventBus();
    const service = new StreamService({
      db,
      bus,
      now: () => 1,
      getActivePath: () => "/active.md",
      settings: () => ({ recencyHalfLifeHours: 12, offNoteRelevanceFloor: 0.3, maxItems: 50 }),
    });
    service.refresh();
    expect(service.items.value).toHaveLength(1);
    expect(service.items.value[0].kind).toBe("node");
  });

  test("refresh fires on agent:run-finished events", async () => {
    const db = await freshDb();
    const bus = new EventBus();
    const service = new StreamService({
      db,
      bus,
      now: () => 1,
      getActivePath: () => null,
      settings: () => ({ recencyHalfLifeHours: 12, offNoteRelevanceFloor: 0.3, maxItems: 50 }),
    });
    service.start();
    expect(service.items.value).toEqual([]);
    seedNode(db, "note:/a.md");
    seedNode(db, "note:/b.md");
    seedEdge(db, {
      id: "e1",
      source: "note:/a.md",
      target: "note:/b.md",
      confidence: 0.7,
      agent: "linker",
      evidence: [],
      createdAt: 1,
    });
    bus.emit({
      type: "agent:run-finished",
      agent: "linker",
      ok: true,
      proposals: 1,
      durationMs: 10,
      runId: 1,
    });
    expect(service.items.value).toHaveLength(1);
    service.stop();
  });

  test("refresh fires on active-leaf-change and re-evaluates relevance", async () => {
    const db = await freshDb();
    seedNode(db, "note:/a.md");
    seedNode(db, "note:/b.md");
    seedEdge(db, {
      id: "e1",
      source: "note:/a.md",
      target: "note:/b.md",
      confidence: 0.7,
      agent: "linker",
      evidence: [],
      createdAt: 1,
    });
    const bus = new EventBus();
    let active: string | null = null;
    const service = new StreamService({
      db,
      bus,
      now: () => 1,
      getActivePath: () => active,
      settings: () => ({ recencyHalfLifeHours: 12, offNoteRelevanceFloor: 0.3, maxItems: 50 }),
    });
    service.start();
    service.refresh();
    const offNoteScore = service.items.value[0].score;
    active = "/a.md";
    bus.emit({ type: "active-leaf-change", notePath: "/a.md", wordCount: 100 });
    const onNoteScore = service.items.value[0].score;
    expect(onNoteScore).toBeGreaterThan(offNoteScore);
    service.stop();
  });

  test("max-items cap limits results to settings.maxItems", async () => {
    const db = await freshDb();
    for (let index = 0; index < 10; index++) {
      seedNode(db, `note:/n${index}.md`);
    }
    for (let index = 0; index < 8; index++) {
      seedEdge(db, {
        id: `e${index}`,
        source: `note:/n${index}.md`,
        target: `note:/n${(index + 1) % 10}.md`,
        confidence: 0.5 + index * 0.05,
        agent: "linker",
        evidence: [],
        createdAt: 1,
      });
    }
    const bus = new EventBus();
    const service = new StreamService({
      db,
      bus,
      now: () => 1,
      getActivePath: () => null,
      settings: () => ({ recencyHalfLifeHours: 12, offNoteRelevanceFloor: 0.3, maxItems: 3 }),
    });
    service.refresh();
    expect(service.items.value).toHaveLength(3);
  });
});
