import { describe, expect, test } from "bun:test";
import { Database } from "./database";
import { MemoryAdapter, loadWasm } from "./database.test";

describe("migrations v1 -> v2", () => {
  test("fresh install lands on v2", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    expect(db.version()).toBe(2);
    const tables = db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;",
    );
    const names = tables.map((t) => t.name);
    expect(names).toContain("staging_edges");
    expect(names).toContain("staging_nodes");
    expect(names).toContain("agent_runs");
    expect(names).toContain("graph_edges");
  });

  test("v1 -> v2 upgrade preserves existing rows", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db1 = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db1.init();
    db1.run(
      "INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)",
      ["/seed.md", "sha", 1, 1, 1],
    );
    // Force-downgrade the recorded version to simulate a v1 vault opened by v2 code.
    db1.run("UPDATE schema_version SET version = 1;");
    await db1.persist();
    await db1.close();

    const db2 = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db2.init();
    expect(db2.version()).toBe(2);
    const rows = db2.query<{ path: string }>("SELECT path FROM notes;");
    expect(rows).toEqual([{ path: "/seed.md" }]);
    const tables = db2.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'staging_edges';",
    );
    expect(tables).toHaveLength(1);
  });

  test("staging_edges accepts a row with required columns", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run(
      `INSERT INTO staging_edges (id, type, source_id, target_id, confidence, agent, evidence, rationale, created_at)
       VALUES (?,?,?,?,?,?,?,?,?);`,
      [
        "e1",
        "supports",
        "note:/a.md",
        "note:/b.md",
        0.84,
        "linker",
        JSON.stringify(["c1"]),
        "shared idea X",
        1,
      ],
    );
    const rows = db.query<{ id: string; agent: string }>("SELECT id, agent FROM staging_edges;");
    expect(rows).toEqual([{ id: "e1", agent: "linker" }]);
  });

  test("agent_runs accepts a complete run record", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run(
      `INSERT INTO agent_runs (agent, trigger, note_path, started_at, finished_at, ok, error, proposals_count)
       VALUES (?,?,?,?,?,?,?,?);`,
      ["linker", "idle-30s", "/a.md", 1, 5, 1, null, 3],
    );
    const rows = db.query<{ agent: string; proposals_count: number }>(
      "SELECT agent, proposals_count FROM agent_runs;",
    );
    expect(rows).toEqual([{ agent: "linker", proposals_count: 3 }]);
  });
});
