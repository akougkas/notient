import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import { makeEdgeApproveInverter } from "./inverters/edgeApprove";
import { makeEdgeRejectInverter } from "./inverters/edgeReject";
import { makeNodeApproveInverter } from "./inverters/nodeApprove";
import { makeNodeRejectInverter } from "./inverters/nodeReject";
import { makeNoteAppendSectionInverter } from "./inverters/noteAppendSection";
import { makeNoteCreateInverter } from "./inverters/noteCreate";
import { makeNoteFrontmatterInverter } from "./inverters/noteFrontmatter";
import { makeNoteMaturityInverter } from "./inverters/noteMaturity";

async function newDb(): Promise<Database> {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  const database = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
  await database.init();
  return database;
}

class FakeFacade {
  files = new Map<string, string>();
  removed: string[] = [];
  async writeNote(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.removed.push(path);
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
}

class FakeEchoGuard {
  marks: Array<{ path: string; sha: string }> = [];
  mark(path: string, sha: string): void {
    this.marks.push({ path, sha });
  }
}

async function fakeHash(input: string): Promise<string> {
  return `sha-${input.length}`;
}

describe("inverters", () => {
  test("edgeApprove restores staging row and removes live edge", async () => {
    const database = await newDb();
    database.run(
      `INSERT INTO graph_edges
        (id, type, source_id, target_id, confidence, agent, evidence, approved, created_at)
       VALUES (?,?,?,?,?,?,?,?,?);`,
      ["edge:live", "supports", "note:/a.md", "note:/b.md", 0.9, "linker", "[]", 1, 100],
    );
    const inverter = makeEdgeApproveInverter({ db: database });
    await inverter(
      "staging:edge",
      {
        id: "staging:edge",
        type: "supports",
        source_id: "note:/a.md",
        target_id: "note:/b.md",
        confidence: 0.9,
        agent: "linker",
        evidence: JSON.stringify(["c1"]),
        rationale: "rationale",
        created_at: 50,
      },
      { id: "edge:live" },
    );
    const live = database.query<{ id: string }>("SELECT id FROM graph_edges;");
    expect(live).toHaveLength(0);
    const staged = database.query<{ id: string; decision: string | null }>(
      "SELECT id, decision FROM staging_edges;",
    );
    expect(staged).toHaveLength(1);
    expect(staged[0].id).toBe("staging:edge");
    expect(staged[0].decision).toBeNull();
  });

  test("edgeReject re-inserts the staging row", async () => {
    const database = await newDb();
    const inverter = makeEdgeRejectInverter({ db: database });
    await inverter(
      "staging:edge",
      {
        id: "staging:edge",
        type: "extends",
        source_id: "note:/a.md",
        target_id: "note:/b.md",
        confidence: 0.7,
        agent: "linker",
        evidence: "[]",
        rationale: null,
        created_at: 10,
      },
      null,
    );
    const rows = database.query<{ id: string; decision: string | null }>(
      "SELECT id, decision FROM staging_edges;",
    );
    expect(rows).toEqual([{ id: "staging:edge", decision: null }]);
  });

  test("nodeApprove restores staging node, removes live node, and deletes the created note", async () => {
    const database = await newDb();
    database.run(
      `INSERT INTO graph_nodes (id, type, label, note_path, payload, created_at)
       VALUES (?,?,?,?,?,?);`,
      ["node:live", "concept", "Cohesion", "/synth/cohesion.md", null, 200],
    );
    const facade = new FakeFacade();
    facade.files.set("/synth/cohesion.md", "# Cohesion\n");
    const echoGuard = new FakeEchoGuard();
    const inverter = makeNodeApproveInverter({
      db: database,
      facade,
      echoGuard,
      hash: fakeHash,
    });
    await inverter(
      "staging:node",
      {
        id: "staging:node",
        type: "concept",
        label: "Cohesion",
        note_path: null,
        payload: null,
        agent: "synthesizer",
        confidence: 0.8,
        created_at: 100,
      },
      { id: "node:live", createdNotePath: "/synth/cohesion.md" },
    );
    expect(database.query<{ id: string }>("SELECT id FROM graph_nodes;")).toHaveLength(0);
    const staged = database.query<{ id: string; decision: string | null }>(
      "SELECT id, decision FROM staging_nodes;",
    );
    expect(staged).toEqual([{ id: "staging:node", decision: null }]);
    expect(facade.removed).toEqual(["/synth/cohesion.md"]);
    expect(echoGuard.marks).toHaveLength(1);
    expect(echoGuard.marks[0].path).toBe("/synth/cohesion.md");
  });

  test("nodeApprove without a created note path leaves vault untouched", async () => {
    const database = await newDb();
    database.run(
      `INSERT INTO graph_nodes (id, type, label, note_path, payload, created_at)
       VALUES (?,?,?,?,?,?);`,
      ["node:live", "concept", "X", null, null, 1],
    );
    const facade = new FakeFacade();
    const echoGuard = new FakeEchoGuard();
    const inverter = makeNodeApproveInverter({
      db: database,
      facade,
      echoGuard,
      hash: fakeHash,
    });
    await inverter(
      "staging:node",
      {
        id: "staging:node",
        type: "concept",
        label: "X",
        note_path: null,
        payload: null,
        agent: "synthesizer",
        confidence: 0.5,
        created_at: 1,
      },
      { id: "node:live" },
    );
    expect(facade.removed).toEqual([]);
    expect(echoGuard.marks).toHaveLength(0);
  });

  test("nodeReject re-inserts the staging row", async () => {
    const database = await newDb();
    const inverter = makeNodeRejectInverter({ db: database });
    await inverter(
      "staging:node",
      {
        id: "staging:node",
        type: "claim",
        label: "Claim text",
        note_path: null,
        payload: JSON.stringify({ confidence: 0.6 }),
        agent: "contradictionHunter",
        confidence: 0.6,
        created_at: 1,
      },
      null,
    );
    const rows = database.query<{ id: string; label: string }>(
      "SELECT id, label FROM staging_nodes;",
    );
    expect(rows).toEqual([{ id: "staging:node", label: "Claim text" }]);
  });

  test("noteAppendSection writes prior body and marks EchoGuard", async () => {
    const facade = new FakeFacade();
    facade.files.set("/note.md", "# After\nappended line\n");
    const echoGuard = new FakeEchoGuard();
    const inverter = makeNoteAppendSectionInverter({
      facade,
      echoGuard,
      hash: fakeHash,
    });
    await inverter("/note.md", "# Before\n", "# After\nappended line\n");
    expect(facade.files.get("/note.md")).toBe("# Before\n");
    expect(echoGuard.marks).toEqual([{ path: "/note.md", sha: "sha-9" }]);
  });

  test("noteFrontmatter restores the prior body verbatim", async () => {
    const facade = new FakeFacade();
    facade.files.set("/n.md", "---\nfoo: bar\n---\nbody\n");
    const echoGuard = new FakeEchoGuard();
    const inverter = makeNoteFrontmatterInverter({
      facade,
      echoGuard,
      hash: fakeHash,
    });
    const priorBody = "---\n---\nbody\n";
    await inverter("/n.md", priorBody, "---\nfoo: bar\n---\nbody\n");
    expect(facade.files.get("/n.md")).toBe(priorBody);
    expect(echoGuard.marks).toHaveLength(1);
    expect(echoGuard.marks[0].path).toBe("/n.md");
  });

  test("noteCreate deletes the created note and marks EchoGuard", async () => {
    const facade = new FakeFacade();
    facade.files.set("/created.md", "# Created\n");
    const echoGuard = new FakeEchoGuard();
    const inverter = makeNoteCreateInverter({
      facade,
      echoGuard,
      hash: fakeHash,
    });
    await inverter("/created.md", null, "# Created\n");
    expect(facade.files.has("/created.md")).toBe(false);
    expect(facade.removed).toEqual(["/created.md"]);
    expect(echoGuard.marks).toHaveLength(1);
    expect(echoGuard.marks[0].path).toBe("/created.md");
  });

  test("noteCreate is a no-op when the note no longer exists", async () => {
    const facade = new FakeFacade();
    const echoGuard = new FakeEchoGuard();
    const inverter = makeNoteCreateInverter({
      facade,
      echoGuard,
      hash: fakeHash,
    });
    await inverter("/missing.md", null, "body");
    expect(facade.removed).toEqual([]);
    expect(echoGuard.marks).toEqual([]);
  });

  test("noteMaturity restores the prior maturity column and body", async () => {
    const database = await newDb();
    const now = Date.now();
    database.run(
      "INSERT INTO notes (path, sha, word_count, maturity, indexed_at, updated_at) VALUES (?,?,?,?,?,?);",
      ["/n.md", "sha", 100, "mature", now, now],
    );
    const facade = new FakeFacade();
    facade.files.set("/n.md", "after-body");
    const echoGuard = new FakeEchoGuard();
    const inverter = makeNoteMaturityInverter({
      db: database,
      facade,
      echoGuard,
      hash: fakeHash,
    });
    await inverter(
      "/n.md",
      { maturity: "adolescent", body: "before-body" },
      { maturity: "mature", body: "after-body" },
    );
    expect(facade.files.get("/n.md")).toBe("before-body");
    const row = database.query<{ maturity: string }>("SELECT maturity FROM notes WHERE path = ?;", [
      "/n.md",
    ])[0];
    expect(row.maturity).toBe("adolescent");
    expect(echoGuard.marks).toHaveLength(1);
    expect(echoGuard.marks[0].path).toBe("/n.md");
  });

  test("inverters validate payload shape and throw on garbage", async () => {
    const database = await newDb();
    const facade = new FakeFacade();
    const echoGuard = new FakeEchoGuard();
    const edgeApprove = makeEdgeApproveInverter({ db: database });
    await expect(edgeApprove("t", { bogus: true }, { id: "x" })).rejects.toThrow();
    const noteAppend = makeNoteAppendSectionInverter({
      facade,
      echoGuard,
      hash: fakeHash,
    });
    await expect(noteAppend("/n.md", 42, null)).rejects.toThrow();
    const noteMaturity = makeNoteMaturityInverter({
      db: database,
      facade,
      echoGuard,
      hash: fakeHash,
    });
    await expect(noteMaturity("/n.md", "wrong-shape", null)).rejects.toThrow();
  });
});
