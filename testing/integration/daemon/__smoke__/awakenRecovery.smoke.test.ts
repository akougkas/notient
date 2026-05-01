/**
 * Awaken boot-recovery smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` or directly via
 * `NOTIENT_SMOKE=1 bun test src/daemon/__smoke__/awakenRecovery.smoke.test.ts`.
 *
 * The smoke leaves a running `awaken_run` row in the same database state
 * a SIGKILL would leave behind, then runs the boot reconciler. Running
 * orphans release the active unique slot so the next awaken run can start;
 * paused rows are intentional operator checkpoints and remain resumable.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createRun,
  findById,
  findCurrent,
  updateStatus,
} from "../../../../src/core/awaken/awakenRun";
import {
  DAEMON_RESTART_ORPHAN_REASON,
  reconcileAwakenOrphans,
} from "../../../../src/core/awaken/reconcileAwakenOrphans";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../../src/core/db/surreal";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

async function clearAwakenRuns(connection: SurrealConnection): Promise<void> {
  await connection.db.query("DELETE awaken_run;").collect();
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] awaken SIGKILL recovery", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "awaken-recovery-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-awaken-recovery-smoke-"));
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
  }, 30_000);

  afterEach(async () => {
    await clearAwakenRuns(connection);
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

  test("[smoke] boot reconciliation releases a running orphan so a fresh awaken can start", async () => {
    const orphanId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      total: 1,
    });

    const result = await reconcileAwakenOrphans(connection.db);

    expect(result.reconciled).toBe(1);
    const orphan = await findById(connection.db, orphanId);
    expect(orphan?.status).toBe("failed");
    expect(orphan?.failure_reason).toBe(DAEMON_RESTART_ORPHAN_REASON);
    expect(orphan?.finished_at).not.toBeNull();
    expect(await findCurrent(connection.db)).toBeNull();

    const nextId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      total: 1,
    });
    expect(nextId.toString().startsWith("awaken_run:")).toBe(true);
  });

  test("[smoke] boot reconciliation preserves a paused checkpoint", async () => {
    const runId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      total: 1,
    });
    await updateStatus(connection.db, runId, "paused", { cursor: "a.md" });

    const result = await reconcileAwakenOrphans(connection.db);

    expect(result.reconciled).toBe(0);
    const paused = await findById(connection.db, runId);
    expect(paused?.status).toBe("paused");
    expect(paused?.cursor).toBe("a.md");
    expect(paused?.failure_reason).toBeNull();
    expect((await findCurrent(connection.db))?.id.toString()).toBe(runId.toString());
  });
});
