import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import { buildVoiceContext } from "./voiceContext";

describe("buildVoiceContext", () => {
  test("returns up to 3 short snippets from mature notes ordered by recency", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    const seed = (path: string, maturity: string, wc: number, updated: number) => {
      db.run(
        "INSERT INTO notes (path, sha, word_count, maturity, indexed_at, updated_at) VALUES (?,?,?,?,?,?);",
        [path, "s", wc, maturity, updated, updated],
      );
      db.run("INSERT INTO chunks (id, note_path, ord, text, sha) VALUES (?,?,?,?,?);", [
        `c:${path}`,
        path,
        0,
        `Voice from ${path}.`,
        "s",
      ]);
    };
    seed("/m1.md", "mature", 500, 5);
    seed("/m2.md", "mature", 600, 10);
    seed("/m3.md", "mature", 700, 7);
    seed("/raw.md", "raw", 50, 8);
    const context = buildVoiceContext(db, { excludePath: null, max: 3, snippetChars: 60 });
    expect(context.snippets.map((s) => s.path)).toEqual(["/m2.md", "/m3.md", "/m1.md"]);
    for (const s of context.snippets) {
      expect(s.text.length).toBeLessThanOrEqual(60);
    }
  });

  test("excludes the active note from the picked snippets", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run(
      "INSERT INTO notes (path, sha, word_count, maturity, indexed_at, updated_at) VALUES (?,?,?,?,?,?);",
      ["/active.md", "s", 1000, "mature", 99, 99],
    );
    db.run("INSERT INTO chunks (id, note_path, ord, text, sha) VALUES (?,?,?,?,?);", [
      "c:/active.md",
      "/active.md",
      0,
      "active voice",
      "s",
    ]);
    const context = buildVoiceContext(db, { excludePath: "/active.md", max: 3, snippetChars: 100 });
    expect(context.snippets).toEqual([]);
  });
});
