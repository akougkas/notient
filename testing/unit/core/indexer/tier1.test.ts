import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { prepareNoteRow } from "../../../../src/core/indexer/tier1";

describe("prepareNoteRow", () => {
  test("clears stale tier timestamps before refreshing an existing note sha", async () => {
    const noteId = new RecordId("note", "existing");
    const calls: Array<{ sql: string; bindings: Record<string, unknown> | undefined }> = [];
    const db = {
      query: (sql: string, bindings?: Record<string, unknown>) => ({
        collect: async () => {
          calls.push({ sql, bindings });
          if (sql.startsWith("SELECT id FROM note")) return [[{ id: noteId }]];
          if (sql.startsWith("SELECT sha FROM note")) return [[{ sha: "old-sha" }]];
          return [[]];
        },
      }),
    } as unknown as Parameters<typeof prepareNoteRow>[0];

    await prepareNoteRow(db, { path: "notes/a.md", sha: "new-sha", wordCount: 10 });

    expect(calls.some((call) => call.sql.includes("tier1_at = NONE"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("tier2_at = NONE"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("tier3_at = NONE"))).toBe(true);
    const clearIndex = calls.findIndex((call) => call.sql.includes("tier1_at = NONE"));
    const updateIndex = calls.findIndex((call) => call.sql.startsWith("UPDATE $id SET sha"));
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeGreaterThan(clearIndex);
  });

  test("does not clear tier timestamps when the existing sha already matches", async () => {
    const noteId = new RecordId("note", "existing");
    const calls: Array<{ sql: string; bindings: Record<string, unknown> | undefined }> = [];
    const db = {
      query: (sql: string, bindings?: Record<string, unknown>) => ({
        collect: async () => {
          calls.push({ sql, bindings });
          if (sql.startsWith("SELECT id FROM note")) return [[{ id: noteId }]];
          if (sql.startsWith("SELECT sha FROM note")) return [[{ sha: "same-sha" }]];
          return [[]];
        },
      }),
    } as unknown as Parameters<typeof prepareNoteRow>[0];

    await prepareNoteRow(db, { path: "notes/a.md", sha: "same-sha", wordCount: 10 });

    expect(calls.some((call) => call.sql.includes("tier1_at = NONE"))).toBe(false);
  });
});
