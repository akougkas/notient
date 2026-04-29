import { describe, expect, test } from "bun:test";
import initSqlJs from "sql.js";
import { Database } from "./database";
import { MemoryAdapter, loadWasm } from "./database.test";
import { applySchema } from "./migrations";

const EXPECTED_TABLES = [
  "agent_events",
  "agent_runs",
  "chunks",
  "embeddings",
  "graph_edges",
  "graph_nodes",
  "history",
  "notes",
  "staging_edges",
  "staging_nodes",
];

describe("applySchema", () => {
  test("creates every expected table on a fresh database", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const database = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await database.init();
    const tables = database.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
    );
    expect(tables.map((t) => t.name)).toEqual(EXPECTED_TABLES);
  });

  test("is idempotent when invoked twice on the same database", async () => {
    const SQL = await initSqlJs({ wasmBinary: loadWasm() });
    const sqlDb = new SQL.Database();
    applySchema(sqlDb);
    expect(() => applySchema(sqlDb)).not.toThrow();
    sqlDb.close();
  });

  test("staging_edges accepts a row with the full column set", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const database = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await database.init();
    database.run(
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
    const rows = database.query<{ id: string; agent: string }>(
      "SELECT id, agent FROM staging_edges;",
    );
    expect(rows).toEqual([{ id: "e1", agent: "linker" }]);
  });

  test("agent_runs accepts a complete run record", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const database = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await database.init();
    database.run(
      `INSERT INTO agent_runs (agent, trigger, note_path, started_at, finished_at, ok, error, proposals_count)
       VALUES (?,?,?,?,?,?,?,?);`,
      ["linker", "idle-30s", "/a.md", 1, 5, 1, null, 3],
    );
    const rows = database.query<{ agent: string; proposals_count: number }>(
      "SELECT agent, proposals_count FROM agent_runs;",
    );
    expect(rows).toEqual([{ agent: "linker", proposals_count: 3 }]);
  });
});
