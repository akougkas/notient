import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import { EventBus } from "../events/eventBus";
import { ApprovalService } from "./approvalService";

async function newDb() {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
  await db.init();
  return db;
}

function seedEdge(db: Database) {
  db.run(
    `INSERT INTO staging_edges (id, type, source_id, target_id, confidence, agent, evidence, rationale, created_at)
     VALUES (?,?,?,?,?,?,?,?,?);`,
    ["e1", "supports", "note:/a.md", "note:/b.md", 0.84, "linker", JSON.stringify(["c1"]), "r", 1],
  );
}

describe("ApprovalService", () => {
  test("accept promotes a staging_edge into graph_edges with approved=1", async () => {
    const db = await newDb();
    seedEdge(db);
    const bus = new EventBus();
    const events: string[] = [];
    bus.on("approval:decided", (e) => events.push(`${e.kind}:${e.id}:${e.decision}`));
    const svc = new ApprovalService({ db, bus });
    await svc.acceptEdge("e1");
    const live = db.query<{ id: string; approved: number; agent: string }>(
      "SELECT id, approved, agent FROM graph_edges;",
    );
    expect(live).toHaveLength(1);
    expect(live[0].approved).toBe(1);
    expect(live[0].agent).toBe("linker");
    const staged = db.query<{ decision: string | null }>(
      "SELECT decision FROM staging_edges WHERE id = ?;",
      ["e1"],
    );
    expect(staged[0].decision).toBe("accepted");
    expect(events).toEqual(["edge:e1:accepted"]);
  });

  test("reject deletes the staging row and emits decided", async () => {
    const db = await newDb();
    seedEdge(db);
    const bus = new EventBus();
    const events: string[] = [];
    bus.on("approval:decided", (e) => events.push(`${e.kind}:${e.id}:${e.decision}`));
    const svc = new ApprovalService({ db, bus });
    await svc.rejectEdge("e1");
    const remaining = db.query<{ id: string }>("SELECT id FROM staging_edges WHERE id = ?;", [
      "e1",
    ]);
    expect(remaining).toHaveLength(0);
    expect(events).toEqual(["edge:e1:rejected"]);
  });

  test("listPending returns only undecided staging rows", async () => {
    const db = await newDb();
    seedEdge(db);
    db.run(
      `INSERT INTO staging_edges (id, type, source_id, target_id, confidence, agent, evidence, rationale, created_at, decided_at, decision)
       VALUES (?,?,?,?,?,?,?,?,?,?,?);`,
      [
        "e2",
        "extends",
        "note:/c.md",
        "note:/d.md",
        0.7,
        "linker",
        JSON.stringify([]),
        null,
        1,
        2,
        "accepted",
      ],
    );
    const svc = new ApprovalService({ db, bus: new EventBus() });
    const pending = svc.listPendingEdges();
    expect(pending.map((p) => p.id)).toEqual(["e1"]);
  });
});
