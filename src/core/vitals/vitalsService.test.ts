import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import { VitalsService } from "./vitalsService";

async function freshDb(): Promise<Database> {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
  await db.init();
  return db;
}

const settings = {
  freshnessHalfLifeDays: 14,
  healthWeights: { wordBand: 1, chunkCoverage: 1, hasApprovedEdges: 1 },
  connectivityThresholds: { sparse: 1, connected: 4, hub: 12 },
  writeToFrontmatter: false,
};

function seedNote(
  db: Database,
  options: { path: string; words: number; maturity?: string; updatedAt?: number },
): void {
  db.run(
    `INSERT INTO notes (path, sha, word_count, maturity, health, freshness, indexed_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?);`,
    [
      options.path,
      "sha",
      options.words,
      options.maturity ?? "raw",
      0,
      1,
      1,
      options.updatedAt ?? 1,
    ],
  );
}

function seedChunk(db: Database, path: string, ord: number): void {
  db.run("INSERT INTO chunks (id, note_path, ord, text, sha) VALUES (?,?,?,?,?);", [
    `${path}#${ord}`,
    path,
    ord,
    "body",
    "sha",
  ]);
}

function seedNodeAndEdges(db: Database, path: string, edgeCount: number): void {
  const nodeId = `note:${path}`;
  db.run(
    "INSERT INTO graph_nodes (id, type, label, note_path, payload, created_at) VALUES (?,?,?,?,?,?);",
    [nodeId, "note", path, path, null, 1],
  );
  for (let index = 0; index < edgeCount; index++) {
    db.run(
      `INSERT INTO graph_edges (id, type, source_id, target_id, confidence, agent, evidence, approved, created_at)
       VALUES (?,?,?,?,?,?,?,?,?);`,
      [
        `edge:${path}:${index}`,
        "supports",
        nodeId,
        `note:other-${index}.md`,
        0.9,
        "linker",
        null,
        1,
        1,
      ],
    );
  }
}

function stubFacade(): {
  frontmatterUpdates: { path: string; patch: Record<string, unknown> }[];
  updateFrontmatter: (path: string, patch: Record<string, unknown>) => Promise<void>;
} {
  const updates: { path: string; patch: Record<string, unknown> }[] = [];
  return {
    frontmatterUpdates: updates,
    updateFrontmatter: async (path: string, patch: Record<string, unknown>) => {
      updates.push({ path, patch });
    },
  };
}

describe("VitalsService", () => {
  test("computeSnapshot reflects word count, chunks, and approved edges", async () => {
    const db = await freshDb();
    seedNote(db, { path: "/a.md", words: 600, maturity: "draft" });
    seedChunk(db, "/a.md", 0);
    seedNodeAndEdges(db, "/a.md", 3);
    const service = new VitalsService({
      db,
      now: () => 1,
      settings: () => settings,
      facade: stubFacade(),
    });
    const snapshot = service.computeSnapshot("/a.md");
    if (!snapshot) throw new Error("expected snapshot for /a.md");
    expect(snapshot.maturity).toBe("draft");
    expect(snapshot.wordCount).toBe(600);
    expect(snapshot.connectivityCount).toBe(3);
    expect(snapshot.connectivityTier).toBe("sparse");
    expect(snapshot.health).toBeGreaterThan(0.6);
  });

  test("returns null when the note is not indexed", async () => {
    const db = await freshDb();
    const service = new VitalsService({
      db,
      now: () => 1,
      settings: () => settings,
      facade: stubFacade(),
    });
    expect(service.computeSnapshot("/missing.md")).toBeNull();
  });

  test("freshness reflects time since updatedAt", async () => {
    const db = await freshDb();
    seedNote(db, { path: "/a.md", words: 100, updatedAt: 0 });
    const fourteenDaysMs = 14 * 86_400_000;
    const service = new VitalsService({
      db,
      now: () => fourteenDaysMs,
      settings: () => settings,
      facade: stubFacade(),
    });
    const snapshot = service.computeSnapshot("/a.md");
    if (!snapshot) throw new Error("expected snapshot for /a.md");
    expect(snapshot.freshness).toBeCloseTo(Math.exp(-1), 4);
  });

  test("connectivity tier maps thresholds correctly", async () => {
    const db = await freshDb();
    seedNote(db, { path: "/a.md", words: 100 });
    seedNodeAndEdges(db, "/a.md", 12);
    const service = new VitalsService({
      db,
      now: () => 1,
      settings: () => settings,
      facade: stubFacade(),
    });
    const snapshot = service.computeSnapshot("/a.md");
    if (!snapshot) throw new Error("expected snapshot for /a.md");
    expect(snapshot.connectivityTier).toBe("hub");
  });

  test("persistSnapshot writes back to notes table", async () => {
    const db = await freshDb();
    seedNote(db, { path: "/a.md", words: 100 });
    const service = new VitalsService({
      db,
      now: () => 1,
      settings: () => settings,
      facade: stubFacade(),
    });
    await service.persistSnapshot("/a.md");
    const rows = db.query<{ health: number; freshness: number }>(
      "SELECT health, freshness FROM notes WHERE path = ?;",
      ["/a.md"],
    );
    expect(rows[0].freshness).toBeGreaterThan(0);
  });

  test("persistSnapshot also writes frontmatter when setting is enabled", async () => {
    const db = await freshDb();
    seedNote(db, { path: "/a.md", words: 100 });
    const facade = stubFacade();
    const service = new VitalsService({
      db,
      now: () => 1,
      settings: () => ({ ...settings, writeToFrontmatter: true }),
      facade,
    });
    await service.persistSnapshot("/a.md");
    expect(facade.frontmatterUpdates).toHaveLength(1);
    expect(facade.frontmatterUpdates[0].path).toBe("/a.md");
    expect(facade.frontmatterUpdates[0].patch).toMatchObject({ notient: expect.any(Object) });
  });
});
