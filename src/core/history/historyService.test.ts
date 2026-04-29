import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import { HistoryService } from "./historyService";
import type { Inverter } from "./types";

async function newDb(): Promise<Database> {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  const database = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
  await database.init();
  return database;
}

describe("HistoryService", () => {
  test("record inserts a row with JSON-serialized before/after", async () => {
    const database = await newDb();
    const service = new HistoryService({
      db: database,
      inverters: {},
      retention: { max: 100, maxPerTarget: 50 },
      now: () => 1700000000000,
    });
    const id = await service.record({
      kind: "notes.create",
      target: "/example.md",
      before: null,
      after: "hello world",
    });
    expect(id).toBeGreaterThan(0);
    const rows = database.query<{
      kind: string;
      target: string;
      before: string | null;
      after: string | null;
      created_at: number;
    }>("SELECT kind, target, before, after, created_at FROM history WHERE id = ?;", [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("notes.create");
    expect(rows[0].target).toBe("/example.md");
    expect(rows[0].before).toBeNull();
    expect(rows[0].after).toBe(JSON.stringify("hello world"));
    expect(rows[0].created_at).toBe(1700000000000);
  });

  test("record stamps the supplied clientIdentity on the row", async () => {
    const database = await newDb();
    const service = new HistoryService({
      db: database,
      inverters: {},
      retention: { max: 100, maxPerTarget: 50 },
    });
    const claudeId = await service.record({
      kind: "notes.create",
      target: "/from-claude.md",
      before: null,
      after: "body",
      clientIdentity: "claude-code",
    });
    const humanId = await service.record({
      kind: "notes.create",
      target: "/from-human.md",
      before: null,
      after: "body",
    });
    const rows = database.query<{ id: number; client_identity: string | null }>(
      "SELECT id, client_identity FROM history ORDER BY id ASC;",
    );
    const claudeRow = rows.find((row) => row.id === claudeId);
    const humanRow = rows.find((row) => row.id === humanId);
    expect(claudeRow?.client_identity).toBe("claude-code");
    expect(humanRow?.client_identity).toBe("human");

    const recent = service.getRecent(10);
    expect(recent.find((row) => row.id === claudeId)?.clientIdentity).toBe("claude-code");
    expect(recent.find((row) => row.id === humanId)?.clientIdentity).toBe("human");
  });

  test("getRecent returns rows in descending id order with parsed payloads", async () => {
    const database = await newDb();
    const service = new HistoryService({
      db: database,
      inverters: {},
      retention: { max: 100, maxPerTarget: 50 },
    });
    await service.record({
      kind: "notes.create",
      target: "/a.md",
      before: null,
      after: "first",
    });
    await service.record({
      kind: "notes.append",
      target: "/a.md",
      before: "first",
      after: "first second",
    });
    const recent = service.getRecent(10);
    expect(recent).toHaveLength(2);
    expect(recent[0].kind).toBe("notes.append");
    expect(recent[0].before).toBe("first");
    expect(recent[0].after).toBe("first second");
    expect(recent[1].kind).toBe("notes.create");
    expect(recent[1].before).toBeNull();
    expect(recent[1].after).toBe("first");
  });

  test("getRecent tolerates legacy raw-string payloads", async () => {
    const database = await newDb();
    database.run(
      "INSERT INTO history (kind, target, before, after, created_at) VALUES (?, ?, ?, ?, ?);",
      ["notes.append", "/a.md", "before", "after", 1],
    );
    const service = new HistoryService({
      db: database,
      inverters: {},
      retention: { max: 100, maxPerTarget: 50 },
    });
    const recent = service.getRecent(1);
    expect(recent[0].before).toBe("before");
    expect(recent[0].after).toBe("after");
  });

  test("undo dispatches to the inverter for the matching kind and deletes the row", async () => {
    const database = await newDb();
    const calls: Array<{ target: string; before: unknown; after: unknown }> = [];
    const fakeInverter: Inverter = async (target, before, after) => {
      calls.push({ target, before, after });
    };
    const service = new HistoryService({
      db: database,
      inverters: { "notes.append": fakeInverter },
      retention: { max: 100, maxPerTarget: 50 },
    });
    const id = await service.record({
      kind: "notes.append",
      target: "/a.md",
      before: "before-body",
      after: "after-body",
    });
    const result = await service.undo(id);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      target: "/a.md",
      before: "before-body",
      after: "after-body",
    });
    const rows = database.query<{ id: number }>("SELECT id FROM history WHERE id = ?;", [id]);
    expect(rows).toHaveLength(0);
  });

  test("undo of a missing row returns not found", async () => {
    const database = await newDb();
    const service = new HistoryService({
      db: database,
      inverters: {},
      retention: { max: 100, maxPerTarget: 50 },
    });
    const result = await service.undo(999);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("history row not found");
  });

  test("undo with no registered inverter returns an error and keeps the row", async () => {
    const database = await newDb();
    const service = new HistoryService({
      db: database,
      inverters: {},
      retention: { max: 100, maxPerTarget: 50 },
    });
    const id = await service.record({
      kind: "edge.approve",
      target: "edge:abc",
      before: { id: "x" },
      after: { id: "y" },
    });
    const result = await service.undo(id);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no inverter for edge.approve");
    const rows = database.query<{ id: number }>("SELECT id FROM history WHERE id = ?;", [id]);
    expect(rows).toHaveLength(1);
  });

  test("undo returns the inverter error when the inverter throws and keeps the row", async () => {
    const database = await newDb();
    const failing: Inverter = async () => {
      throw new Error("inverter blew up");
    };
    const service = new HistoryService({
      db: database,
      inverters: { "notes.create": failing },
      retention: { max: 100, maxPerTarget: 50 },
    });
    const id = await service.record({
      kind: "notes.create",
      target: "/x.md",
      before: null,
      after: "body",
    });
    const result = await service.undo(id);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("inverter blew up");
    const rows = database.query<{ id: number }>("SELECT id FROM history WHERE id = ?;", [id]);
    expect(rows).toHaveLength(1);
  });

  test("undoLast targets the most recent row", async () => {
    const database = await newDb();
    const captured: string[] = [];
    const inverter: Inverter = async (target) => {
      captured.push(target);
    };
    const service = new HistoryService({
      db: database,
      inverters: { "notes.create": inverter, "notes.append": inverter },
      retention: { max: 100, maxPerTarget: 50 },
    });
    await service.record({
      kind: "notes.create",
      target: "/first.md",
      before: null,
      after: "x",
    });
    await service.record({
      kind: "notes.append",
      target: "/second.md",
      before: "x",
      after: "x y",
    });
    const result = await service.undoLast();
    expect(result.ok).toBe(true);
    expect(captured).toEqual(["/second.md"]);
    const remaining = service.getRecent(10);
    expect(remaining.map((row) => row.target)).toEqual(["/first.md"]);
  });

  test("undoLast on empty history returns an error", async () => {
    const database = await newDb();
    const service = new HistoryService({
      db: database,
      inverters: {},
      retention: { max: 100, maxPerTarget: 50 },
    });
    const result = await service.undoLast();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no history");
  });

  test("prune trims to global retention cap, keeping the newest rows", async () => {
    const database = await newDb();
    const service = new HistoryService({
      db: database,
      inverters: {},
      retention: { max: 3, maxPerTarget: 100 },
    });
    for (let index = 0; index < 5; index++) {
      await service.record({
        kind: "notes.append",
        target: `/note-${index}.md`,
        before: "a",
        after: "b",
      });
    }
    await service.prune();
    const rows = service.getRecent(50);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.target)).toEqual(["/note-4.md", "/note-3.md", "/note-2.md"]);
  });

  test("prune trims per-target rows, keeping the newest per target", async () => {
    const database = await newDb();
    const service = new HistoryService({
      db: database,
      inverters: {},
      retention: { max: 1000, maxPerTarget: 2 },
    });
    for (let index = 0; index < 4; index++) {
      await service.record({
        kind: "notes.append",
        target: "/repeated.md",
        before: `before-${index}`,
        after: `after-${index}`,
      });
    }
    await service.record({
      kind: "notes.append",
      target: "/other.md",
      before: "a",
      after: "b",
    });
    await service.prune();
    const repeated = database.query<{ before: string }>(
      "SELECT before FROM history WHERE target = ? ORDER BY id DESC;",
      ["/repeated.md"],
    );
    expect(repeated).toHaveLength(2);
    expect(repeated.map((row) => JSON.parse(row.before))).toEqual(["before-3", "before-2"]);
    const other = database.query<{ id: number }>("SELECT id FROM history WHERE target = ?;", [
      "/other.md",
    ]);
    expect(other).toHaveLength(1);
  });
});
