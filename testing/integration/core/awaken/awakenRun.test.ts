/** Real-SurrealDB integrity coverage for the awaken run control plane. */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DateTime, type RecordId } from "surrealdb";
import {
  type AwakenStatus,
  createRun,
  findCurrent,
  findLatestResumable,
  subscribeToStatus,
  updateStatus,
} from "../../../../src/core/awaken/awakenRun";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../../src/core/db/surreal";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

function makeRunPaths(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `note-${index}.md`);
}

async function clearAwakenRuns(connection: SurrealConnection): Promise<void> {
  await connection.db.query("DELETE awaken_run;").collect();
}

interface AwakenRow {
  id: RecordId<"awaken_run">;
  status: string;
  finished_at: string | Date | null;
  processed: number;
  failed: number;
  cursor: string | null | undefined;
  error: string | null | undefined;
}

async function fetchRow(
  connection: SurrealConnection,
  runId: RecordId<"awaken_run">,
): Promise<AwakenRow | undefined> {
  const [rows] = await connection.db
    .query<[AwakenRow[]]>(
      "SELECT id, status, finished_at, processed, failed, cursor, error FROM awaken_run WHERE id = $id;",
      { id: runId },
    )
    .collect<[AwakenRow[]]>();
  return rows[0];
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] awaken_run DAL", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase4-awaken-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-awaken-smoke-"));
    handle = await startSurreal({
      dataDir: path.join(tempDir, "data"),
      secret,
      portFile: path.join(tempDir, "port"),
      pidFile: path.join(tempDir, "pid"),
      logLevel: "warn",
      hnswCacheMib: 64,
    });
    connection = await connect({
      url: handle.url,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    await applySchema(connection.db, secret, { embedDim: 768, embedModel: "fixture-embedding" });
  }, 30_000);

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
  }, 30_000);

  afterEach(async () => {
    await clearAwakenRuns(connection);
  });

  test("[smoke] createRun returns a typed id with running status and stamped started_at", async () => {
    const runId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: ["projects/**/*.md"],
      paths: makeRunPaths(42),
    });
    expect(runId.toString().startsWith("awaken_run:")).toBe(true);

    const [rows] = await connection.db
      .query<
        [
          Array<{
            status: string;
            started_at: DateTime;
            total: number;
            processed: number;
            failed: number;
            tier_filter: number[];
            priority_globs: string[];
            cursor: string | null | undefined;
            error: string | null | undefined;
          }>,
        ]
      >(
        "SELECT status, started_at, total, processed, failed, tier_filter, priority_globs, cursor, error FROM awaken_run WHERE id = $id;",
        { id: runId },
      )
      .collect();
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.status).toBe("running");
    expect(row.total).toBe(42);
    expect(row.processed).toBe(0);
    expect(row.failed).toBe(0);
    expect(row.tier_filter).toEqual([1, 2, 3]);
    expect(row.priority_globs).toEqual(["projects/**/*.md"]);
    // SurrealDB 3.0.5 decodes datetime natively and omits NONE option fields.
    expect(row.started_at).toBeInstanceOf(DateTime);
    expect(row.cursor).toBeUndefined();
    expect(row.error).toBeUndefined();
    // `started_at` defaults to time::now(); a freshly-stamped value is
    // within a few seconds of "now".
    const startedMs = row.started_at.toDate().getTime();
    expect(Number.isFinite(startedMs)).toBe(true);
    expect(Math.abs(Date.now() - startedMs)).toBeLessThan(5000);
  });

  test("[smoke] findCurrent returns null when the table is empty", async () => {
    const result = await findCurrent(connection.db);
    expect(result).toBeNull();
  });

  test("[smoke] findCurrent returns the row when a run is active", async () => {
    const runId = await createRun(connection.db, {
      tierFilter: [1, 2],
      priorityGlobs: [],
      paths: makeRunPaths(7),
    });
    const result = await findCurrent(connection.db);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.id.toString()).toBe(runId.toString());
    expect(result.status).toBe("running");
    expect(result.total).toBe(7);
    expect(result.tier_filter).toEqual([1, 2]);
    expect(result.priority_globs).toEqual([]);
    expect(result.cursor).toBeNull();
    expect(result.error).toBeNull();
    expect(result.finished_at).toBeNull();
  });

  test("[smoke] findCurrent returns null when only terminal rows exist", async () => {
    const cancelledId = await createRun(connection.db, {
      tierFilter: [1],
      priorityGlobs: [],
      paths: makeRunPaths(1),
    });
    await updateStatus(connection.db, cancelledId, "cancelled");
    const completedId = await createRun(connection.db, {
      tierFilter: [1],
      priorityGlobs: [],
      paths: makeRunPaths(1),
    });
    await updateStatus(connection.db, completedId, "completed", {
      processed: 1,
      attempted: 1,
    });
    const failedId = await createRun(connection.db, {
      tierFilter: [1],
      priorityGlobs: [],
      paths: makeRunPaths(1),
    });
    await updateStatus(connection.db, failedId, "failed", { error: "boom" });

    const result = await findCurrent(connection.db);
    expect(result).toBeNull();
  });

  test("[smoke] findLatestResumable returns the most recent paused row", async () => {
    // The `awaken_run_active_unique` index forbids two coexisting rows in
    // `status INSIDE ['running','paused']`, so the older row must be
    // released to a terminal status before the second `createRun` can
    // land. Drive the older row to `failed` first; the test still
    // exercises the "latest paused or failed" sort because
    // `findLatestResumable`'s status filter accepts both.
    const olderId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      paths: makeRunPaths(3),
    });
    await updateStatus(connection.db, olderId, "paused", { processed: 1, attempted: 1 });
    await updateStatus(connection.db, olderId, "failed", { error: "synthetic-older" });
    // Sleep 25ms to ensure server-side started_at on the second row sorts
    // strictly after the first; SurrealDB's millisecond clock can collide
    // on rapid back-to-back creates inside the same Bun event loop tick.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const newerId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      paths: makeRunPaths(5),
    });
    await updateStatus(connection.db, newerId, "paused", { processed: 2, attempted: 2 });

    const result = await findLatestResumable(connection.db);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.id.toString()).toBe(newerId.toString());
    expect(result.status).toBe("paused");
    expect(result.processed).toBe(2);
  });

  test("[smoke] findLatestResumable returns the latest paused or failed row", async () => {
    const pausedId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      paths: makeRunPaths(4),
    });
    await updateStatus(connection.db, pausedId, "paused");
    // Release the active slot before the next `createRun`; the unique
    // index over `active_marker` rejects a second row while the paused
    // row still occupies the active set. Flip to `failed` so the row is
    // still surfaced by `findLatestResumable` (which selects `paused` or
    // `failed`) but no longer holds the active marker.
    await updateStatus(connection.db, pausedId, "failed", { error: "synthetic-older" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const failedId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      paths: makeRunPaths(4),
    });
    await updateStatus(connection.db, failedId, "failed", { error: "synthetic" });

    const result = await findLatestResumable(connection.db);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.id.toString()).toBe(failedId.toString());
    expect(result.status).toBe("failed");
    expect(result.error).toBe("synthetic");
  });

  test("[smoke] findLatestResumable returns null when no resumable row exists", async () => {
    const completedId = await createRun(connection.db, {
      tierFilter: [1],
      priorityGlobs: [],
      paths: makeRunPaths(1),
    });
    await updateStatus(connection.db, completedId, "completed", {
      processed: 1,
      attempted: 1,
    });
    const result = await findLatestResumable(connection.db);
    expect(result).toBeNull();
  });

  test("[smoke] updateStatus completed stamps finished_at", async () => {
    const runId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      paths: makeRunPaths(1),
    });
    await updateStatus(connection.db, runId, "completed", { processed: 1, attempted: 1 });
    const row = await fetchRow(connection, runId);
    expect(row?.status).toBe("completed");
    expect(row?.finished_at != null).toBe(true);
  });

  test("[smoke] terminal timestamps stay monotonic across a regressive server clock", async () => {
    const runId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      paths: makeRunPaths(1),
    });
    const futureStart = new DateTime("2099-01-01T00:00:00.000Z");
    await connection.db
      .query("UPDATE $id SET started_at = $startedAt;", { id: runId, startedAt: futureStart })
      .collect();

    await expect(
      connection.db
        .query("UPDATE $id SET finished_at = d'2000-01-01T00:00:00Z';", { id: runId })
        .collect(),
    ).rejects.toThrow("field must conform");

    await updateStatus(connection.db, runId, "completed", {
      processed: 1,
      attempted: 1,
      cursor: null,
    });
    const [rows] = await connection.db
      .query<[Array<{ started_at: DateTime; finished_at: DateTime }>]>(
        "SELECT started_at, finished_at FROM awaken_run WHERE id = $id;",
        { id: runId },
      )
      .collect<[Array<{ started_at: DateTime; finished_at: DateTime }>]>();
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.started_at).toBeInstanceOf(DateTime);
    expect(row?.finished_at).toBeInstanceOf(DateTime);
    expect(row?.finished_at.toDate().getTime()).toBe(row?.started_at.toDate().getTime());
  });

  test("[smoke] updateStatus paused with processed updates counter without stamping finished_at", async () => {
    const runId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      paths: makeRunPaths(20),
    });
    await updateStatus(connection.db, runId, "paused", { processed: 10, attempted: 10 });
    const row = await fetchRow(connection, runId);
    expect(row?.status).toBe("paused");
    expect(row?.processed).toBe(10);
    // Non-terminal transition must NOT stamp finished_at.
    expect(row?.finished_at == null).toBe(true);
  });

  test("[smoke] updateStatus cancelled stamps finished_at", async () => {
    const runId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      paths: makeRunPaths(5),
    });
    await updateStatus(connection.db, runId, "cancelled");
    const row = await fetchRow(connection, runId);
    expect(row?.status).toBe("cancelled");
    expect(row?.finished_at != null).toBe(true);
  });

  test("[smoke] updateStatus failed stamps finished_at and persists error", async () => {
    const runId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      paths: makeRunPaths(5),
    });
    await updateStatus(connection.db, runId, "failed", {
      processed: 3,
      failed: 1,
      attempted: 4,
      error: "embedding model unreachable",
    });
    const row = await fetchRow(connection, runId);
    expect(row?.status).toBe("failed");
    expect(row?.finished_at != null).toBe(true);
    expect(row?.processed).toBe(3);
    expect(row?.failed).toBe(1);
    expect(row?.error).toBe("embedding model unreachable");
  });

  test("[smoke] updateStatus cursor=null clears the cursor field", async () => {
    const runId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      paths: makeRunPaths(5),
    });
    await updateStatus(connection.db, runId, "paused", { cursor: "note-1.md" });
    const afterSet = await fetchRow(connection, runId);
    expect(afterSet?.cursor).toBe("note-1.md");
    await updateStatus(connection.db, runId, "paused", { cursor: null });
    const afterClear = await fetchRow(connection, runId);
    expect(afterClear?.cursor == null).toBe(true);
  });

  test("[smoke] invalid merged counters fail before storage is mutated", async () => {
    const runId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      paths: makeRunPaths(2),
    });

    await expect(
      updateStatus(connection.db, runId, "running", { processed: 2, attempted: 1 }),
    ).rejects.toThrow("processed cannot exceed attempted");

    const current = await findCurrent(connection.db);
    expect(current?.id.toString()).toBe(runId.toString());
    expect(current?.processed).toBe(0);
    expect(current?.failed).toBe(0);
    expect(current?.attempted).toBe(0);
  });

  test("[smoke] failure diagnostics are exclusive and resume clears terminal state", async () => {
    const runId = await createRun(connection.db, {
      tierFilter: [2, 3],
      priorityGlobs: ["note-*.md"],
      paths: makeRunPaths(2),
    });
    await updateStatus(connection.db, runId, "failed", {
      processed: 1,
      failed: 1,
      attempted: 2,
      cursor: "note-1.md",
      error: "one note could not be embedded",
      failurePaths: ["note-1.md"],
    });

    const failed = await findLatestResumable(connection.db);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("one note could not be embedded");
    expect(failed?.failure_reason).toBeNull();
    expect(failed?.failures).toEqual(["note-1.md"]);
    expect(failed?.finished_at).toBeInstanceOf(Date);

    await updateStatus(connection.db, runId, "running");
    const resumed = await findCurrent(connection.db);
    expect(resumed?.status).toBe("running");
    expect(resumed?.finished_at).toBeNull();
    expect(resumed?.error).toBeNull();
    expect(resumed?.failure_reason).toBeNull();
    expect(resumed?.failures).toEqual(["note-1.md"]);
  });

  test("[smoke] subscribeToStatus fires for the target run and ignores other rows", async () => {
    // The `awaken_run_active_unique` index allows only one row in the
    // active set at a time. Land the "other" row first and freeze it to
    // `failed` before creating the target row so both rows can coexist
    // for the duration of the live-query check. The test only cares that
    // the live-query callback ignores updates to non-target rows.
    const otherId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      paths: makeRunPaths(3),
    });
    await updateStatus(connection.db, otherId, "failed", { error: "synthetic-other" });
    const targetId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      paths: makeRunPaths(3),
    });

    const seen: AwakenStatus[] = [];
    const subscription = await subscribeToStatus(connection.db, targetId, (status) => {
      seen.push(status);
    });

    try {
      // Re-touch the other row so SurrealDB emits an UPDATE notification.
      // The handler under test must ignore this event because its record
      // id does not match `targetId`.
      await updateStatus(connection.db, otherId, "failed", { error: "synthetic-touch" });
      await updateStatus(connection.db, targetId, "paused", { processed: 1, attempted: 1 });
      await updateStatus(connection.db, targetId, "running");
      await updateStatus(connection.db, targetId, "completed", {
        processed: 3,
        attempted: 3,
        cursor: null,
      });
      // Allow live-query notifications to settle. The SDK delivers via the
      // websocket on the same connection; 250ms is the tested upper bound
      // on local SurrealDB roundtrip in the existing smoke harness.
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      await subscription.close();
    }

    // The target's two updates must both be observed; the other run's
    // pause must NOT appear. We assert containment instead of strict
    // equality because SurrealDB may emit extra UPDATE notifications
    // (e.g., a single status flip can land as one or two messages
    // depending on how the field-level delta is batched on the wire).
    expect(seen).toContain("paused");
    expect(seen).toContain("running");
    expect(seen).toContain("completed");
    expect(
      seen.every((status) => status === "paused" || status === "running" || status === "completed"),
    ).toBe(true);
  });
});
