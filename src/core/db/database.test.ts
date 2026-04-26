import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Database, type DatabaseAdapter } from "./database";

// biome-ignore lint/suspicious/noExportsInTest: shared test helper imported by migrations.test.ts
export class MemoryAdapter implements DatabaseAdapter {
  files = new Map<string, ArrayBuffer>();
  constructor(initial: Record<string, ArrayBuffer> = {}) {
    for (const [k, v] of Object.entries(initial)) this.files.set(k, v);
  }
  async readBinary(path: string): Promise<ArrayBuffer | null> {
    return this.files.get(path) ?? null;
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, data);
  }
}

// biome-ignore lint/suspicious/noExportsInTest: shared test helper imported by migrations.test.ts
export function loadWasm(): ArrayBuffer {
  const wasmPath = resolve(import.meta.dir, "../../../node_modules/sql.js/dist/sql-wasm.wasm");
  const buf = readFileSync(wasmPath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

describe("Database", () => {
  test("init creates schema and sets version", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    expect(db.version()).toBe(Database.currentSchemaVersion);
    expect(adapter.files.has("/db")).toBe(true);
  });

  test("notes table accepts inserts", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run("INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)", [
      "/n.md",
      "abc",
      10,
      1,
      1,
    ]);
    const rows = db.query<{ path: string; sha: string }>("SELECT path, sha FROM notes;");
    expect(rows).toEqual([{ path: "/n.md", sha: "abc" }]);
  });

  test("re-init from persisted DB preserves data", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db1 = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db1.init();
    db1.run(
      "INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)",
      ["/x.md", "sha", 1, 1, 1],
    );
    await db1.persist();
    await db1.close();

    const db2 = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db2.init();
    const rows = db2.query<{ path: string }>("SELECT path FROM notes;");
    expect(rows).toEqual([{ path: "/x.md" }]);
  });

  test("transaction commits on success", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.transaction(() => {
      db.run(
        "INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)",
        ["/a.md", "sha", 1, 1, 1],
      );
      db.run(
        "INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)",
        ["/b.md", "sha", 1, 1, 1],
      );
    });
    const rows = db.query<{ path: string }>("SELECT path FROM notes ORDER BY path;");
    expect(rows).toEqual([{ path: "/a.md" }, { path: "/b.md" }]);
  });

  test("transaction rolls back on throw and re-raises", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run("INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)", [
      "/seed.md",
      "sha",
      1,
      1,
      1,
    ]);
    expect(() =>
      db.transaction(() => {
        db.run(
          "INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)",
          ["/inside.md", "sha", 1, 1, 1],
        );
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const rows = db.query<{ path: string }>("SELECT path FROM notes ORDER BY path;");
    expect(rows).toEqual([{ path: "/seed.md" }]);
  });

  test("transaction supports a return value", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    const result = db.transaction(() => {
      db.run(
        "INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)",
        ["/x.md", "sha", 1, 1, 1],
      );
      return 42;
    });
    expect(result).toBe(42);
  });
});
