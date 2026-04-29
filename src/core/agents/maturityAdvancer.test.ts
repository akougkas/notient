import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import { EventBus } from "../events/eventBus";
import { MaturityAdvancer } from "./maturityAdvancer";

class FakeFacade {
  files = new Map<string, string>();
  marks: string[] = [];
  async read(path: string): Promise<string> {
    return this.files.get(path) ?? "";
  }
  async write(path: string, body: string): Promise<void> {
    this.files.set(path, body);
    this.marks.push(`wrote:${path}`);
  }
}

describe("MaturityAdvancer", () => {
  test("promotes raw -> adolescent on first edit", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    const facade = new FakeFacade();
    const ma = new MaturityAdvancer({ db, facade });
    const now = Date.now();
    db.run(
      "INSERT INTO notes (path, sha, word_count, maturity, indexed_at, updated_at) VALUES (?,?,?,?,?,?)",
      ["/a.md", "x", 50, "raw", now, now],
    );
    facade.files.set("/a.md", "# A\nSome content.\n");
    const result = await ma.run({
      trigger: "idle-30m",
      notePath: null,
      signal: new AbortController().signal,
      runId: 1,
      bus: new EventBus(),
    });
    expect(result.proposals).toBe(1);
    const row = db.query<{ maturity: string }>("SELECT maturity FROM notes WHERE path = ?;", [
      "/a.md",
    ])[0];
    expect(row.maturity).toBe("adolescent");
    expect(facade.files.get("/a.md")).toContain("notient:");
    expect(facade.files.get("/a.md")).toContain("maturity: adolescent");
  });

  test("does not promote a note that does not meet criteria", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    const facade = new FakeFacade();
    const ma = new MaturityAdvancer({ db, facade });
    const now = Date.now();
    db.run(
      "INSERT INTO notes (path, sha, word_count, maturity, indexed_at, updated_at) VALUES (?,?,?,?,?,?)",
      ["/a.md", "x", 5, "adolescent", now, now],
    );
    facade.files.set("/a.md", "# A\n");
    const result = await ma.run({
      trigger: "idle-30m",
      notePath: null,
      signal: new AbortController().signal,
      runId: 1,
      bus: new EventBus(),
    });
    expect(result.proposals).toBe(0);
  });
});
