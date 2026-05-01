/**
 * Awaken shutdown fence smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via
 * `NOTIENT_SMOKE=1 bun test src/daemon/__smoke__/awaken.shutdown.smoke.test.ts`.
 *
 * Boots a real SurrealDB, applies the Phase 1 schema, registers a fresh
 * `AwakenBackgroundRegistry`, and exercises the daemon shutdown fence
 * end-to-end:
 *
 *   1. Within-grace path: a tiny vault drains naturally before the
 *      grace window expires. The worker's row reaches `completed` and
 *      the registry empties without the orphan-flip UPDATE matching
 *      anything.
 *   2. Grace-exceeded path: a wedged vault facade keeps the worker
 *      stuck on its first per-note wait. The shutdown fence runs with a
 *      short grace window override, observes the timeout, and flips
 *      the row to `failed` with `failure_reason='daemon_shutdown'` and
 *      a stamped `finished_at`.
 *
 * The harness drives `awaitBackgroundWorkers` directly rather than
 * spinning up the full daemon process; the helper is the single
 * shutdown step the bug-fix exposed and exercising it in isolation
 * keeps the smoke fast and deterministic.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { findById } from "../../../../src/core/awaken/awakenRun";
import {
  type AwakenWorkerIndexerQueue,
  type AwakenWorkerVaultFacade,
  runAwakenWorker,
} from "../../../../src/core/awaken/awakenWorker";
import { AwakenBackgroundRegistry } from "../../../../src/core/awaken/backgroundRegistry";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../../src/core/db/surreal";
import { awaitBackgroundWorkers } from "../../../../src/daemon/awaitBackgroundWorkers";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

async function clearAwakenRuns(connection: SurrealConnection): Promise<void> {
  await connection.db.query("DELETE awaken_run;").collect();
}

function makeIndexerQueue(records: string[]): AwakenWorkerIndexerQueue {
  return {
    enqueue(filePath: string): void {
      records.push(filePath);
    },
  };
}

function makeVaultFacade(paths: ReadonlyArray<string>): AwakenWorkerVaultFacade {
  return {
    listMarkdownPaths: async () => [...paths],
  };
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] awaken shutdown fence", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "awaken-shutdown-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-awaken-shutdown-smoke-"));
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

  test("[smoke] within-grace path: the worker drains and the row reaches completed", async () => {
    await clearAwakenRuns(connection);
    const registry = new AwakenBackgroundRegistry();
    const paths = ["a.md", "b.md", "c.md"];
    const enqueued: string[] = [];

    // A simple `onNoteIndexed` stub mirrors the production fast drain
    // for unit tests: the worker's per-note wait resolves immediately
    // so the run finishes well within the grace window.
    const workerPromise = runAwakenWorker({
      db: connection.db,
      vaultFacade: makeVaultFacade(paths),
      indexerQueue: makeIndexerQueue(enqueued),
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      resume: false,
      onNoteIndexed: async () => {
        // Resolve immediately so the worker drains in a single tick.
      },
    });
    registry.track(workerPromise);

    const result = await awaitBackgroundWorkers({
      registry,
      db: connection.db,
      graceMs: 5_000,
    });
    expect(result.completed).toBe(1);
    expect(result.orphaned).toBe(0);
    expect(registry.size()).toBe(0);

    // The worker promise resolved; surface its result so we can inspect
    // the run row by id.
    const workerResult = await workerPromise;
    expect(workerResult.status).toBe("completed");
    expect(workerResult.processed).toBe(paths.length);

    const finalRow = await findById(connection.db, workerResult.runId);
    expect(finalRow).not.toBeNull();
    if (finalRow === null) return;
    expect(finalRow.status).toBe("completed");
    expect(finalRow.failure_reason).toBeNull();
    expect(enqueued).toEqual(paths);
  });

  test("[smoke] grace-exceeded path: a wedged worker has its row flipped to failed with failure_reason=daemon_shutdown", async () => {
    await clearAwakenRuns(connection);
    const registry = new AwakenBackgroundRegistry();
    const paths = ["wedged.md"];
    const enqueued: string[] = [];

    // The vault facade returns one path; the worker enqueues it and
    // then awaits `onNoteIndexed`, which here resolves only after a
    // never-firing promise. This wedges the worker on its first per-
    // note wait so the shutdown fence's grace window must time out.
    let wedgeResolve: (() => void) | null = null;
    const wedgePromise = new Promise<void>((resolve) => {
      wedgeResolve = resolve;
    });

    const workerPromise = runAwakenWorker({
      db: connection.db,
      vaultFacade: makeVaultFacade(paths),
      indexerQueue: makeIndexerQueue(enqueued),
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      resume: false,
      onNoteIndexed: async () => {
        await wedgePromise;
      },
    });
    // Attach a no-op catch so the eventual rejection from `await
    // wedgePromise` (when we resolve it during teardown) does not flag
    // the test under Bun's unhandled-rejection guard.
    workerPromise.catch(() => {});
    registry.track(workerPromise);

    // Give the worker a tick to enqueue and reach the wedge.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const startedAt = Date.now();
    const result = await awaitBackgroundWorkers({
      registry,
      db: connection.db,
      graceMs: 200,
    });
    const elapsed = Date.now() - startedAt;
    // The grace must have actually elapsed; we used a 200ms window so
    // the helper cannot be returning early via a registry empty path.
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(2_000);
    expect(result.completed).toBe(0);
    expect(result.orphaned).toBeGreaterThanOrEqual(1);

    // The flipped row carries the daemon shutdown signature.
    const [rows] = await connection.db
      .query<
        [
          Array<{
            id: RecordId<"awaken_run">;
            status: string;
            failure_reason: string | null;
            finished_at: unknown;
            started_at: unknown;
          }>,
        ]
      >(
        "SELECT id, status, failure_reason, finished_at, started_at FROM awaken_run WHERE status = 'failed' ORDER BY started_at DESC LIMIT 1;",
      )
      .collect<
        [
          Array<{
            id: RecordId<"awaken_run">;
            status: string;
            failure_reason: string | null;
            finished_at: unknown;
            started_at: unknown;
          }>,
        ]
      >();
    expect(rows.length).toBe(1);
    const flipped = rows[0];
    expect(flipped?.status).toBe("failed");
    expect(flipped?.failure_reason).toBe("daemon_shutdown");
    expect(flipped?.finished_at == null).toBe(false);

    // The DAL returns the same field through `findById` so callers can
    // surface it without touching SurrealDB directly.
    if (flipped !== undefined) {
      const dalRow = await findById(connection.db, flipped.id);
      expect(dalRow?.failure_reason).toBe("daemon_shutdown");
    }

    // Release the wedge so the worker promise unblocks and Bun's test
    // teardown does not see a leaked listener.
    if (wedgeResolve !== null) (wedgeResolve as () => void)();
    await workerPromise.catch(() => {});
  });
});
