import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RecordId } from "surrealdb";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  lookupNoteByPath,
  recordDaemonWrite,
  upsertNoteByPath,
} from "../../../../src/core/db/surreal";
import { EventBus } from "../../../../src/core/events/eventBus";
import { prepareNoteRow, runTier1 } from "../../../../src/core/indexer/tier1";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

const fixtureNote = `---
title: Active Note
related: "[[other]]"
---

# H1

A paragraph with [[other]] and [[also#section]] and [[non-existent-target]]. ^para-1

Tagged content #topic/sub here.
`;

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
