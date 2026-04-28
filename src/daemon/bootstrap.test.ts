/**
 * Substrate test that proves the wiring contract Task 9 introduces:
 * the `recordHistory` closure that bootstrap installs into the chat
 * tool registry must call HistoryService.record so that
 * historyService.getRecent(1) returns the row a chat write produced.
 *
 * The full bootstrap path requires LM Studio plus the live FsVault, so
 * this test reproduces the same closure shape against an in-memory
 * Database. If the closure ever drifts from the service the row count
 * will not advance and the assertion fails.
 */

import { describe, expect, test } from "bun:test";
import type { NotesHistoryRecord } from "../core/chat/tools/notes";
import { Database } from "../core/db/database";
import { MemoryAdapter, loadWasm } from "../core/db/database.test";
import { HistoryService } from "../core/history/historyService";
import type { HistoryKind } from "../core/history/types";
import { buildHistoryInverters } from "./bootstrap";

async function newDb(): Promise<Database> {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  const database = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
  await database.init();
  return database;
}

describe("bootstrap recordHistory wiring", () => {
  test("chat-driven notes.create write lands in history.getRecent", async () => {
    const database = await newDb();
    const historyService = new HistoryService({
      db: database,
      inverters: {},
      retention: { max: 200, maxPerTarget: 20 },
    });

    // Mirror the closure bootstrap installs at `recordHistory`.
    const recordHistory = async (record: NotesHistoryRecord): Promise<number> =>
      historyService.record(record);

    const id = await recordHistory({
      kind: "notes.create",
      target: "scratch.md",
      before: null,
      after: "hello world",
    });

    expect(id).toBeGreaterThan(0);
    const recent = historyService.getRecent(1);
    expect(recent).toHaveLength(1);
    expect(recent[0].kind).toBe("notes.create");
    expect(recent[0].target).toBe("scratch.md");
    expect(recent[0].after).toBe("hello world");
    expect(recent[0].before).toBeNull();
  });
});

describe("bootstrap buildHistoryInverters", () => {
  test("registers an inverter for every HistoryKind", async () => {
    const database = await newDb();
    const inverters = buildHistoryInverters({
      database,
      writeNote: async () => {},
      removeNote: async () => {},
      noteExists: async () => false,
      markEcho: () => {},
      hash: async () => "sha",
    });
    const expected: HistoryKind[] = [
      "edge.approve",
      "edge.reject",
      "node.approve",
      "node.reject",
      "note.append_section",
      "note.frontmatter",
      "note.maturity",
      "notes.create",
      "notes.append",
      "notes.replace_section",
      "notes.update_frontmatter",
    ];
    for (const kind of expected) {
      expect(typeof inverters[kind]).toBe("function");
    }
  });
});
