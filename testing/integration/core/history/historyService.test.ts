/**
 * Phase 4 Task 4 HistoryService smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/core/history/`.
 *
 * Boots a real SurrealDB, applies the Phase 1 schema (which now includes
 * the `history` table added by Task 3), and exercises the SurrealDB-backed
 * record/getRecent/undo/prune surface end-to-end. The injected `now`
 * clock guarantees deterministic ordering when the schema's
 * `time::now()` default would otherwise tie consecutive inserts.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../../src/core/db/surreal";
import { HistoryService } from "../../../../src/core/history/historyService";
import type { Inverter } from "../../../../src/core/history/types";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

interface HistoryRecordRow {
  id: RecordId<"history">;
  kind: string;
  target: string;
  before: string | null;
  after: string | null;
  client_identity: string | null;
}

async function clearHistory(connection: SurrealConnection): Promise<void> {
  await connection.db.query("DELETE history;").collect();
}

function monotonicClock(start: number): () => number {
  let counter = 0;
  return () => start + counter++;
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] HistoryService", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase4-history-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-history-smoke-"));
    handle = await startSurreal({
      dataDir: path.join(tempDir, "data"),
      secret,
      portFile: path.join(tempDir, "port"),
      pidFile: path.join(tempDir, "pid"),
      logLevel: "warn",
    });
    connection = await connect({
      url: handle.url,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    await applySchema(connection.db, secret);
  });

  afterAll(async () => {
    if (connection !== undefined) {
      await connection.close().catch(() => {});
    }
    if (handle !== undefined) {
      await handle.stop().catch(() => {});
    }
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    await clearHistory(connection);
  });

  test("[smoke] record inserts a row with JSON-serialized before/after", async () => {
    const service = new HistoryService({
      db: connection.db,
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
    expect(id.startsWith("history:")).toBe(true);

    const [rows] = await connection.db
      .query<[HistoryRecordRow[]]>(
        "SELECT id, kind, target, before, after, client_identity FROM history;",
      )
      .collect<[HistoryRecordRow[]]>();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("notes.create");
    expect(rows[0].target).toBe("/example.md");
    // SurrealDB returns NONE-valued option<string> fields as undefined.
    // HistoryService.getRecent normalises to null; the raw-row assertion
    // checks the absence sentinel against either shape.
    expect(rows[0].before == null).toBe(true);
    expect(rows[0].after).toBe(JSON.stringify("hello world"));

    const recent = await service.getRecent(1);
    expect(recent[0].before).toBeNull();
    expect(recent[0].after).toBe("hello world");
  });

  test("[smoke] record stamps the supplied clientIdentity on the row", async () => {
    const service = new HistoryService({
      db: connection.db,
      inverters: {},
      retention: { max: 100, maxPerTarget: 50 },
      now: monotonicClock(1700000000000),
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

    const [rows] = await connection.db
      .query<[HistoryRecordRow[]]>("SELECT id, client_identity FROM history;")
      .collect<[HistoryRecordRow[]]>();
    const claudeRow = rows.find((row) => row.id.toString() === claudeId);
    const humanRow = rows.find((row) => row.id.toString() === humanId);
    expect(claudeRow?.client_identity).toBe("claude-code");
    expect(humanRow?.client_identity).toBe("human");

    const recent = await service.getRecent(10);
    expect(recent.find((row) => row.id === claudeId)?.clientIdentity).toBe("claude-code");
    expect(recent.find((row) => row.id === humanId)?.clientIdentity).toBe("human");
  });

  test("[smoke] getRecent returns rows in descending created_at order with parsed payloads", async () => {
    const service = new HistoryService({
      db: connection.db,
      inverters: {},
      retention: { max: 100, maxPerTarget: 50 },
      now: monotonicClock(1700000000000),
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
    const recent = await service.getRecent(10);
    expect(recent).toHaveLength(2);
    expect(recent[0].kind).toBe("notes.append");
    expect(recent[0].before).toBe("first");
    expect(recent[0].after).toBe("first second");
    expect(recent[1].kind).toBe("notes.create");
    expect(recent[1].before).toBeNull();
    expect(recent[1].after).toBe("first");
  });

  test("[smoke] undo dispatches to the inverter for the matching kind and deletes the row", async () => {
    const calls: Array<{ target: string; before: unknown; after: unknown }> = [];
    const fakeInverter: Inverter = async (target, before, after) => {
      calls.push({ target, before, after });
    };
    const service = new HistoryService({
      db: connection.db,
      inverters: { "notes.append": fakeInverter },
      retention: { max: 100, maxPerTarget: 50 },
      now: () => 1700000000000,
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
    const [rows] = await connection.db
      .query<[Array<{ id: RecordId<"history"> }>]>("SELECT id FROM history;")
      .collect<[Array<{ id: RecordId<"history"> }>]>();
    expect(rows).toHaveLength(0);
  });

  test("[smoke] undo of a missing row returns not found", async () => {
    const service = new HistoryService({
      db: connection.db,
      inverters: {},
      retention: { max: 100, maxPerTarget: 50 },
    });
    const result = await service.undo("history:does_not_exist");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("history row not found");
  });

  test("[smoke] undo with no registered inverter returns an error and keeps the row", async () => {
    const service = new HistoryService({
      db: connection.db,
      inverters: {},
      retention: { max: 100, maxPerTarget: 50 },
      now: () => 1700000000000,
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
    const [rows] = await connection.db
      .query<[Array<{ id: RecordId<"history"> }>]>("SELECT id FROM history;")
      .collect<[Array<{ id: RecordId<"history"> }>]>();
    expect(rows).toHaveLength(1);
  });

  test("[smoke] undo returns the inverter error when the inverter throws and keeps the row", async () => {
    const failing: Inverter = async () => {
      throw new Error("inverter blew up");
    };
    const service = new HistoryService({
      db: connection.db,
      inverters: { "notes.create": failing },
      retention: { max: 100, maxPerTarget: 50 },
      now: () => 1700000000000,
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
    const [rows] = await connection.db
      .query<[Array<{ id: RecordId<"history"> }>]>("SELECT id FROM history;")
      .collect<[Array<{ id: RecordId<"history"> }>]>();
    expect(rows).toHaveLength(1);
  });

  test("[smoke] undoLast targets the most recent row", async () => {
    const captured: string[] = [];
    const inverter: Inverter = async (target) => {
      captured.push(target);
    };
    const service = new HistoryService({
      db: connection.db,
      inverters: { "notes.create": inverter, "notes.append": inverter },
      retention: { max: 100, maxPerTarget: 50 },
      now: monotonicClock(1700000000000),
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
    const remaining = await service.getRecent(10);
    expect(remaining.map((row) => row.target)).toEqual(["/first.md"]);
  });

  test("[smoke] undoLast on empty history returns an error", async () => {
    const service = new HistoryService({
      db: connection.db,
      inverters: {},
      retention: { max: 100, maxPerTarget: 50 },
    });
    const result = await service.undoLast();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no history");
  });

  test("[smoke] prune trims to global retention cap, keeping the newest rows", async () => {
    const service = new HistoryService({
      db: connection.db,
      inverters: {},
      retention: { max: 3, maxPerTarget: 100 },
      now: monotonicClock(1700000000000),
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
    const rows = await service.getRecent(50);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.target)).toEqual(["/note-4.md", "/note-3.md", "/note-2.md"]);
  });

  test("[smoke] prune trims per-target rows, keeping the newest per target", async () => {
    const service = new HistoryService({
      db: connection.db,
      inverters: {},
      retention: { max: 1000, maxPerTarget: 2 },
      now: monotonicClock(1700000000000),
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
    const [repeated] = await connection.db
      .query<[Array<{ before: string; created_at: string; id: RecordId<"history"> }>]>(
        "SELECT before, created_at, id FROM history WHERE target = $target ORDER BY created_at DESC, id DESC;",
        { target: "/repeated.md" },
      )
      .collect<[Array<{ before: string; created_at: string; id: RecordId<"history"> }>]>();
    expect(repeated).toHaveLength(2);
    expect(repeated.map((row) => JSON.parse(row.before))).toEqual(["before-3", "before-2"]);
    const [other] = await connection.db
      .query<[Array<{ id: RecordId<"history"> }>]>(
        "SELECT id FROM history WHERE target = $target;",
        { target: "/other.md" },
      )
      .collect<[Array<{ id: RecordId<"history"> }>]>();
    expect(other).toHaveLength(1);
  });
});
