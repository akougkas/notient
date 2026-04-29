import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
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
