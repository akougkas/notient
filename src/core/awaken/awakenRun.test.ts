/**
 * Phase 4 Task 7 awaken_run DAL smoke harness.
 *
 * Skipped by default. Run with `NOTIENT_SMOKE=1 bun test src/core/awaken/`
 * or via `bun run test:smoke` (the latter scopes to `src/daemon/__smoke__`,
 * so prefer the directly-targeted invocation for this suite).
 *
 * Boots a real SurrealDB, applies the Phase 1 schema (which already
 * contains the `awaken_run` table), and exercises the create / lookup /
 * status-transition surface end-to-end. Includes a small live-query
 * smoke covering `subscribeToStatus`; Task 8 layers a worker-level smoke
 * on top of the same primitive.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { type SurrealServerHandle, startSurreal } from "../../daemon/surrealServer";
import { applySchema } from "../db/schemaApplier";
import { type SurrealConnection, connect } from "../db/surreal";
import {
  AwakenRunAlreadyActiveError,
  type AwakenStatus,
  createRun,
  findCurrent,
  findLatestResumable,
  subscribeToStatus,
  updateStatus,
} from "./awakenRun";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

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
    await clearAwakenRuns(connection);
  });

  test("[smoke] createRun returns a typed id with running status and stamped started_at", async () => {
    const runId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: ["projects/**/*.md"],
      total: 42,
    });
    expect(runId.toString().startsWith("awaken_run:")).toBe(true);

    const [rows] = await connection.db
      .query<
        [
          Array<{
            status: string;
            started_at: string | Date;
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
    // option<> fields must be absent when not supplied. SurrealDB returns
    // NONE-valued option<string> as undefined; legacy mirrors emit null.
    // Either shape is acceptable here.
    expect(row.cursor == null).toBe(true);
    expect(row.error == null).toBe(true);
    // `started_at` defaults to time::now(); a freshly-stamped value is
    // within a few seconds of "now".
    const startedMs =
      row.started_at instanceof Date ? row.started_at.getTime() : Date.parse(row.started_at);
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
      total: 7,
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
      total: 1,
    });
    await updateStatus(connection.db, cancelledId, "cancelled");
    const completedId = await createRun(connection.db, {
      tierFilter: [1],
      priorityGlobs: [],
      total: 1,
    });
    await updateStatus(connection.db, completedId, "completed");
    const failedId = await createRun(connection.db, {
      tierFilter: [1],
      priorityGlobs: [],
      total: 1,
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
      total: 3,
    });
    await updateStatus(connection.db, olderId, "paused", { processed: 1 });
    await updateStatus(connection.db, olderId, "failed", { error: "synthetic-older" });
    // Sleep 25ms to ensure server-side started_at on the second row sorts
    // strictly after the first; SurrealDB's millisecond clock can collide
    // on rapid back-to-back creates inside the same Bun event loop tick.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const newerId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      total: 5,
    });
    await updateStatus(connection.db, newerId, "paused", { processed: 2 });

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
      total: 4,
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
      total: 4,
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
      total: 1,
    });
    await updateStatus(connection.db, completedId, "completed");
    const result = await findLatestResumable(connection.db);
    expect(result).toBeNull();
  });

  test("[smoke] updateStatus completed stamps finished_at", async () => {
    const runId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      total: 1,
    });
    await updateStatus(connection.db, runId, "completed");
    const row = await fetchRow(connection, runId);
    expect(row?.status).toBe("completed");
    expect(row?.finished_at != null).toBe(true);
  });

  test("[smoke] updateStatus paused with processed updates counter without stamping finished_at", async () => {
    const runId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      total: 20,
    });
    await updateStatus(connection.db, runId, "paused", { processed: 10 });
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
      total: 5,
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
      total: 5,
    });
    await updateStatus(connection.db, runId, "failed", {
      processed: 3,
      failed: 1,
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
      total: 5,
    });
    await updateStatus(connection.db, runId, "paused", { cursor: "notes/foo.md" });
    const afterSet = await fetchRow(connection, runId);
    expect(afterSet?.cursor).toBe("notes/foo.md");
    await updateStatus(connection.db, runId, "paused", { cursor: null });
    const afterClear = await fetchRow(connection, runId);
    expect(afterClear?.cursor == null).toBe(true);
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
      total: 3,
    });
    await updateStatus(connection.db, otherId, "failed", { error: "synthetic-other" });
    const targetId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      total: 3,
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
      await updateStatus(connection.db, targetId, "paused", { processed: 1 });
      await updateStatus(connection.db, targetId, "completed");
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
    expect(seen).toContain("completed");
    expect(seen.every((status) => status === "paused" || status === "completed")).toBe(true);
  });
});

// Required-export placeholder. Without an in-suite test the file would be
// flagged as empty when SMOKE is disabled; this no-op assertion keeps the
// runner happy under the default skip path.
describe("awaken_run module shape", () => {
  test("module exports the public DAL surface", () => {
    expect(typeof createRun).toBe("function");
    expect(typeof findCurrent).toBe("function");
    expect(typeof findLatestResumable).toBe("function");
    expect(typeof updateStatus).toBe("function");
    expect(typeof subscribeToStatus).toBe("function");
  });

  test("AwakenRunAlreadyActiveError is exported and inherits from Error", () => {
    const instance = new AwakenRunAlreadyActiveError();
    expect(instance).toBeInstanceOf(Error);
    expect(instance).toBeInstanceOf(AwakenRunAlreadyActiveError);
    expect(instance.name).toBe("AwakenRunAlreadyActiveError");
    expect(instance.message.length).toBeGreaterThan(0);
  });
});
