import { describe, expect, test } from "bun:test";
import { Database } from "../../db/database";
import { MemoryAdapter, loadWasm } from "../../db/database.test";
import { defaultFuzzyScore, quickSearch } from "./quick";

async function makeDb(): Promise<Database> {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
  await db.init();
  return db;
}

function seedNote(
  db: Database,
  path: string,
  chunks: { id: string; text: string; ord?: number }[],
  updatedAt = 1,
): void {
  db.run("INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)", [
    path,
    "sha",
    100,
    1,
    updatedAt,
  ]);
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    db.run("INSERT INTO chunks (id, note_path, ord, text, sha) VALUES (?,?,?,?,?);", [
      chunk.id,
      path,
      chunk.ord ?? index,
      chunk.text,
      `sha-${chunk.id}`,
    ]);
  }
}

describe("quickSearch", () => {
  test("returns [] when there are no documents", async () => {
    const db = await makeDb();
    const hits = quickSearch({ db, query: "anything", limit: 5 });
    expect(hits).toEqual([]);
  });

  test("returns [] for an empty query", async () => {
    const db = await makeDb();
    seedNote(db, "/n.md", [{ id: "c1", text: "graph reasoning" }]);
    const hits = quickSearch({ db, query: "   ", limit: 5 });
    expect(hits).toEqual([]);
  });

  test("title hit beats body-only hit", async () => {
    const db = await makeDb();
    seedNote(db, "/notes/Graph Reasoning.md", [{ id: "c1", text: "An overview about reasoning." }]);
    seedNote(db, "/notes/other.md", [
      { id: "c2", text: "Graph reasoning is mentioned only here in body." },
    ]);
    const hits = quickSearch({ db, query: "graph reasoning", limit: 5 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].notePath).toBe("/notes/Graph Reasoning.md");
  });

  test("fuzzy-tolerant match still surfaces a result", async () => {
    const db = await makeDb();
    seedNote(db, "/notes/synthesis.md", [
      { id: "c1", text: "Synthesizing knowledge across many notes is the goal." },
    ]);
    const hits = quickSearch({
      db,
      query: "synth",
      limit: 5,
      scorer: (text, query) => defaultFuzzyScore(text, query),
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].notePath).toBe("/notes/synthesis.md");
    expect(hits[0].snippet.toLowerCase()).toContain("synth");
  });

  test("respects limit", async () => {
    const db = await makeDb();
    for (let i = 0; i < 5; i += 1) {
      seedNote(
        db,
        `/notes/hit-${i}.md`,
        [{ id: `c${i}`, text: "graph reasoning is everywhere" }],
        100 - i,
      );
    }
    const hits = quickSearch({ db, query: "graph", limit: 2 });
    expect(hits).toHaveLength(2);
  });

  test("dedupes by note path so each note appears at most once", async () => {
    const db = await makeDb();
    seedNote(db, "/notes/dup.md", [
      { id: "c1", text: "graph reasoning intro" },
      { id: "c2", text: "graph reasoning continues" },
    ]);
    const hits = quickSearch({ db, query: "graph", limit: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0].notePath).toBe("/notes/dup.md");
  });
});

describe("defaultFuzzyScore", () => {
  test("substring match scores highest", () => {
    const score = defaultFuzzyScore("Graph Reasoning", "graph");
    expect(score).toBeGreaterThan(0.5);
  });

  test("non-matching characters return 0", () => {
    expect(defaultFuzzyScore("graph", "zzz")).toBe(0);
  });

  test("subsequence match returns a positive score", () => {
    const score = defaultFuzzyScore("synthesizing", "synth");
    expect(score).toBeGreaterThan(0);
  });
});
