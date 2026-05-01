/**
 * Unit tests for the SurrealDB DAL helpers that gate the Phase 4 daemon
 * write audit trail. Skipped by default; run with `bun run test:smoke` or
 * `NOTIENT_SMOKE=1 bun test src/core/db/surreal.test.ts`.
 *
 * Boots a real SurrealDB, applies the schema, seeds a couple of notes, then
 * exercises `recordDaemonWrite` and `findRecentDaemonWrite` end-to-end.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DateTime, RecordId } from "surrealdb";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  findRecentDaemonWrite,
  recordDaemonWrite,
  upsertNoteByPath,
} from "../../../../src/core/db/surreal";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

describe.skipIf(!SMOKE_ENABLED)("[smoke] daemon_write DAL", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "daemon-write-smoke-secret";
  let noteIdA: RecordId<"note">;
  let noteIdB: RecordId<"note">;
  let targetNoteId: RecordId<"note">;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-daemon-write-smoke-"));
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

    noteIdA = await upsertNoteByPath(connection.db, {
      path: "notes/a.md",
      sha: "sha-a",
      wordCount: 1,
    });
    noteIdB = await upsertNoteByPath(connection.db, {
      path: "notes/b.md",
      sha: "sha-b",
      wordCount: 1,
    });
    targetNoteId = await upsertNoteByPath(connection.db, {
      path: "notes/target.md",
      sha: "sha-target",
      wordCount: 1,
    });
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

  test("recordDaemonWrite returns a RecordId<'daemon_write'>", async () => {
    const id = await recordDaemonWrite(connection.db, {
      noteId: noteIdA,
      sha: "body-sha-1",
      agent: "linker",
      targets: [targetNoteId],
    });
    expect(id).toBeInstanceOf(RecordId);
    expect(id.table.name).toBe("daemon_write");

    const [rows] = await connection.db
      .query<[Array<{ note: RecordId<"note">; sha: string; agent: string }>]>(
        "SELECT note, sha, agent FROM daemon_write WHERE id = $id;",
        { id },
      )
      .collect<[Array<{ note: RecordId<"note">; sha: string; agent: string }>]>();
    expect(rows.length).toBe(1);
    expect(rows[0].sha).toBe("body-sha-1");
    expect(rows[0].agent).toBe("linker");
    expect(rows[0].note.toString()).toBe(noteIdA.toString());
  });

  test("findRecentDaemonWrite returns the row when noteId+sha match within window", async () => {
    await recordDaemonWrite(connection.db, {
      noteId: noteIdA,
      sha: "body-sha-window",
      agent: "linker",
      targets: [targetNoteId],
    });
    const match = await findRecentDaemonWrite(connection.db, {
      noteId: noteIdA,
      sha: "body-sha-window",
    });
    expect(match).not.toBeNull();
    if (match === null) return;
    expect(match.agent).toBe("linker");
    expect(match.targets.length).toBe(1);
    expect(match.targets[0].toString()).toBe(targetNoteId.toString());
  });

  test("findRecentDaemonWrite returns null when sha matches but noteId differs", async () => {
    await recordDaemonWrite(connection.db, {
      noteId: noteIdA,
      sha: "shared-sha",
      agent: "linker",
      targets: [targetNoteId],
    });
    const match = await findRecentDaemonWrite(connection.db, {
      noteId: noteIdB,
      sha: "shared-sha",
    });
    expect(match).toBeNull();
  });

  test("findRecentDaemonWrite returns null when noteId matches but sha differs", async () => {
    await recordDaemonWrite(connection.db, {
      noteId: noteIdA,
      sha: "sha-mismatch-original",
      agent: "linker",
      targets: [targetNoteId],
    });
    const match = await findRecentDaemonWrite(connection.db, {
      noteId: noteIdA,
      sha: "sha-mismatch-different",
    });
    expect(match).toBeNull();
  });

  test("findRecentDaemonWrite returns null when the row is older than the window", async () => {
    // Insert a row with an explicit `written_at` that is well outside any
    // reasonable lookup window. We use a low-level CREATE here so the test
    // controls the timestamp directly; `recordDaemonWrite` deliberately
    // delegates `written_at` to the schema DEFAULT.
    const stalePast = new DateTime(new Date(Date.now() - 60_000));
    await connection.db
      .query(
        "CREATE daemon_write CONTENT { note: $note, sha: $sha, agent: $agent, targets: $targets, written_at: $writtenAt };",
        {
          note: noteIdA,
          sha: "stale-sha",
          agent: "linker",
          targets: [targetNoteId],
          writtenAt: stalePast,
        },
      )
      .collect();
    const match = await findRecentDaemonWrite(connection.db, {
      noteId: noteIdA,
      sha: "stale-sha",
      withinSeconds: 5,
    });
    expect(match).toBeNull();
  });

  test("findRecentDaemonWrite default window tolerates ~30s lag from watcher debounce + tier 1 reindex", async () => {
    // Backdate the row to 30 seconds ago. Pre-fix the 5s default window
    // would have missed this row and tier 1 would have lost daemon
    // provenance, falling back to source='wikilink' instead of 'linker'.
    // The 60s default covers the realistic watcher debounce (~5s) plus
    // tier 1 transaction duration (up to ~30s) plus clock-skew margin.
    const thirtySecondsAgo = new DateTime(new Date(Date.now() - 30_000));
    await connection.db
      .query(
        "CREATE daemon_write CONTENT { note: $note, sha: $sha, agent: $agent, targets: $targets, written_at: $writtenAt };",
        {
          note: noteIdA,
          sha: "realistic-lag-sha",
          agent: "linker",
          targets: [targetNoteId],
          writtenAt: thirtySecondsAgo,
        },
      )
      .collect();
    const match = await findRecentDaemonWrite(connection.db, {
      noteId: noteIdA,
      sha: "realistic-lag-sha",
    });
    expect(match).not.toBeNull();
    if (match === null) return;
    expect(match.agent).toBe("linker");
  });

  test("findRecentDaemonWrite returns the most recent row when multiple match", async () => {
    // First row: older agent label.
    await recordDaemonWrite(connection.db, {
      noteId: noteIdB,
      sha: "multi-sha",
      agent: "linker",
      targets: [targetNoteId],
    });
    // Brief delay so the second row's `time::now()` strictly exceeds the
    // first. SurrealDB datetime precision easily distinguishes 5ms apart.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await recordDaemonWrite(connection.db, {
      noteId: noteIdB,
      sha: "multi-sha",
      agent: "extractor",
      targets: [targetNoteId],
    });
    const match = await findRecentDaemonWrite(connection.db, {
      noteId: noteIdB,
      sha: "multi-sha",
    });
    expect(match).not.toBeNull();
    if (match === null) return;
    expect(match.agent).toBe("extractor");
  });
});
