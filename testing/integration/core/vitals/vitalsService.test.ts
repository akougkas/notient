/**
 * Phase 5 Task 5 VitalsService smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/core/vitals/`.
 *
 * Boots a real SurrealDB, applies the Phase 1 schema (which now includes the
 * `note.health` and `note.freshness` fields added in Phase 5 Task 5), and
 * exercises VitalsService end-to-end against the live database. Each test
 * truncates the entity tables in `afterEach` so seeded rows do not leak
 * between cases.
 *
 * Migrated from the SQLite-backed in-memory fixture: `notes`, `chunks`, and
 * `graph_edges` reads are now SurrealDB queries against `note`, `chunk`, and
 * `wikilink`. Edge counts filter on `approved AND applied` per the Phase 4
 * PENDING-STATE contract.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DateTime, type RecordId } from "surrealdb";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect, relateWikilink, upsertNoteByPath } from "../../../../src/core/db/surreal";
import { VitalsService } from "../../../../src/core/vitals/vitalsService";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

const settings = {
  freshnessHalfLifeDays: 14,
  healthWeights: { wordBand: 1, chunkCoverage: 1, hasApprovedEdges: 1 },
  connectivityThresholds: { sparse: 1, connected: 4, hub: 12 },
  writeToFrontmatter: false,
};

interface SeedNoteInput {
  path: string;
  words: number;
  maturity?: string;
  lastUserEditAtMs?: number;
}

async function seedNote(
  connection: SurrealConnection,
  input: SeedNoteInput,
): Promise<RecordId<"note">> {
  const id = await upsertNoteByPath(connection.db, {
    path: input.path,
    sha: "sha",
    wordCount: input.words,
  });
  const setClauses: string[] = [];
  const bindings: Record<string, unknown> = { id };
  if (input.maturity !== undefined) {
    setClauses.push("maturity = $maturity");
    bindings.maturity = input.maturity;
  }
  if (input.lastUserEditAtMs !== undefined) {
    setClauses.push("last_user_edit_at = $when");
    bindings.when = new DateTime(new Date(input.lastUserEditAtMs));
  }
  if (setClauses.length > 0) {
    await connection.db.query(`UPDATE $id SET ${setClauses.join(", ")};`, bindings).collect();
  }
  return id;
}

async function seedChunk(
  connection: SurrealConnection,
  noteId: RecordId<"note">,
  ord: number,
): Promise<void> {
  await connection.db
    .query("CREATE chunk CONTENT { note: $note, ord: $ord, text: $text, token_estimate: 1 };", {
      note: noteId,
      ord,
      text: "body",
    })
    .collect();
}

// Monotonic suffix so successive seedWikilinkOutbound calls within a single
// test produce distinct target notes. Without this, two calls with the same
// `count` would collide on `other-<fromId>-<index>.md` and the second
// UPDATE would overwrite the first call's approval flags.
let wikilinkSeedCounter = 0;

async function seedWikilinkOutbound(
  connection: SurrealConnection,
  fromNoteId: RecordId<"note">,
  count: number,
  options: { approved?: boolean; applied?: boolean } = {},
): Promise<void> {
  const approved = options.approved !== false;
  const applied = options.applied !== false;
  for (let index = 0; index < count; index += 1) {
    wikilinkSeedCounter += 1;
    const targetId = await upsertNoteByPath(connection.db, {
      path: `other-${fromNoteId.id.toString()}-${wikilinkSeedCounter}.md`,
      sha: "sha",
      wordCount: 1,
    });
    await relateWikilink(connection.db, {
      from: fromNoteId,
      to: targetId,
      source: "wikilink",
      confidenceClass: "EXTRACTED",
      confidence: 1,
      agent: "linker",
    });
    await connection.db
      .query(
        "UPDATE wikilink SET approved = $approved, applied = $applied WHERE in = $from AND out = $to;",
        { approved, applied, from: fromNoteId, to: targetId },
      )
      .collect();
  }
}

function stubFacade(): {
  frontmatterUpdates: { path: string; patch: Record<string, unknown> }[];
  updateFrontmatter: (path: string, patch: Record<string, unknown>) => Promise<void>;
} {
  const updates: { path: string; patch: Record<string, unknown> }[] = [];
  return {
    frontmatterUpdates: updates,
    updateFrontmatter: async (notePath: string, patch: Record<string, unknown>) => {
      updates.push({ path: notePath, patch });
    },
  };
}

async function clearVault(connection: SurrealConnection): Promise<void> {
  await connection.db.query("DELETE wikilink;").collect();
  await connection.db.query("DELETE chunk;").collect();
  await connection.db.query("DELETE block;").collect();
  await connection.db.query("DELETE note;").collect();
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] VitalsService", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase5-vitals-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-vitals-smoke-"));
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
    await clearVault(connection);
  });

  test("[smoke] computeSnapshot reflects word count, chunks, and approved edges", async () => {
    const noteId = await seedNote(connection, {
      path: "a.md",
      words: 600,
      maturity: "draft",
    });
    await seedChunk(connection, noteId, 0);
    await seedWikilinkOutbound(connection, noteId, 3);
    const service = new VitalsService({
      db: connection.db,
      now: () => 1,
      settings: () => settings,
      facade: stubFacade(),
    });
    const snapshot = await service.computeSnapshot("a.md");
    if (snapshot === null) throw new Error("expected snapshot for /a.md");
    expect(snapshot.maturity).toBe("draft");
    expect(snapshot.wordCount).toBe(600);
    expect(snapshot.connectivityCount).toBe(3);
    expect(snapshot.connectivityTier).toBe("sparse");
    expect(snapshot.health).toBeGreaterThan(0.6);
  });

  test("[smoke] returns null when the note is not indexed", async () => {
    const service = new VitalsService({
      db: connection.db,
      now: () => 1,
      settings: () => settings,
      facade: stubFacade(),
    });
    expect(await service.computeSnapshot("missing.md")).toBeNull();
  });

  test("[smoke] freshness reflects time since last_user_edit_at", async () => {
    await seedNote(connection, { path: "a.md", words: 100, lastUserEditAtMs: 0 });
    const fourteenDaysMs = 14 * 86_400_000;
    const service = new VitalsService({
      db: connection.db,
      now: () => fourteenDaysMs,
      settings: () => settings,
      facade: stubFacade(),
    });
    const snapshot = await service.computeSnapshot("a.md");
    if (snapshot === null) throw new Error("expected snapshot for /a.md");
    expect(snapshot.freshness).toBeCloseTo(Math.exp(-1), 4);
  });

  test("[smoke] connectivity tier maps thresholds correctly", async () => {
    const noteId = await seedNote(connection, { path: "a.md", words: 100 });
    await seedWikilinkOutbound(connection, noteId, 12);
    const service = new VitalsService({
      db: connection.db,
      now: () => 1,
      settings: () => settings,
      facade: stubFacade(),
    });
    const snapshot = await service.computeSnapshot("a.md");
    if (snapshot === null) throw new Error("expected snapshot for /a.md");
    expect(snapshot.connectivityTier).toBe("hub");
  });

  test("[smoke] persistSnapshot writes back to note row", async () => {
    await seedNote(connection, { path: "a.md", words: 100 });
    const service = new VitalsService({
      db: connection.db,
      now: () => 1,
      settings: () => settings,
      facade: stubFacade(),
    });
    await service.persistSnapshot("a.md");
    interface VitalsRow {
      health: number | null;
      freshness: number | null;
    }
    const [rows] = await connection.db
      .query<[VitalsRow[]]>("SELECT health, freshness FROM note WHERE path = $path LIMIT 1;", {
        path: "a.md",
      })
      .collect<[VitalsRow[]]>();
    expect(rows[0].freshness).not.toBeNull();
    expect(rows[0].freshness ?? 0).toBeGreaterThan(0);
    expect(rows[0].health).not.toBeNull();
  });

  test("[smoke] persistSnapshot also writes frontmatter when setting is enabled", async () => {
    await seedNote(connection, { path: "a.md", words: 100 });
    const facade = stubFacade();
    const service = new VitalsService({
      db: connection.db,
      now: () => 1,
      settings: () => ({ ...settings, writeToFrontmatter: true }),
      facade,
    });
    await service.persistSnapshot("a.md");
    expect(facade.frontmatterUpdates).toHaveLength(1);
    expect(facade.frontmatterUpdates[0].path).toBe("a.md");
    expect(facade.frontmatterUpdates[0].patch).toMatchObject({ notient: expect.any(Object) });
  });

  test("[smoke] edge count excludes pending-state writeback (approved=true, applied=false)", async () => {
    const noteId = await seedNote(connection, { path: "a.md", words: 100 });
    await seedWikilinkOutbound(connection, noteId, 2, { approved: true, applied: true });
    await seedWikilinkOutbound(connection, noteId, 3, { approved: true, applied: false });
    const service = new VitalsService({
      db: connection.db,
      now: () => 1,
      settings: () => settings,
      facade: stubFacade(),
    });
    const snapshot = await service.computeSnapshot("a.md");
    if (snapshot === null) throw new Error("expected snapshot for /a.md");
    expect(snapshot.connectivityCount).toBe(2);
  });
});
