/**
 * Awaken_run unique-active-row smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via
 * `NOTIENT_SMOKE=1 bun test src/daemon/__smoke__/awakenRun.unique.smoke.test.ts`.
 *
 * Boots a real SurrealDB, applies the Phase 1 schema, and exercises the
 * `awaken_run_active_unique` index that the schema defines over the
 * computed `active_marker` field. The marker is `'active'` while the
 * status is in the active set (`'running'` or `'paused'`) and `NONE`
 * otherwise; SurrealDB's unique constraint over a NONE-valued field
 * skips the row, which gives partial-uniqueness semantics. The DAL
 * translates the resulting unique-violation error into the typed
 * `AwakenRunAlreadyActiveError` so callers can surface a stable
 * `INVALID_PARAMS` reply.
 *
 * Three scenarios:
 *   A. Two `createRun` calls fired concurrently via `Promise.all`:
 *      exactly one resolves, the other rejects with the typed error.
 *   B. Sequential calls when a `running` row already exists: the second
 *      `createRun` rejects with the typed error and the existing
 *      `findCurrent` lookup returns the original row.
 *   C. A `paused` row also blocks new `running` rows; flipping the
 *      original to `cancelled` releases the active marker so a fresh
 *      `createRun` succeeds.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import {
  AwakenRunAlreadyActiveError,
  createRun,
  findCurrent,
  updateStatus,
} from "../../../../src/core/awaken/awakenRun";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../../src/core/db/surreal";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

async function clearAwakenRuns(connection: SurrealConnection): Promise<void> {
  await connection.db.query("DELETE awaken_run;").collect();
}

interface SettledOutcome {
  successes: Array<RecordId<"awaken_run">>;
  failures: unknown[];
}

function partitionSettled(
  results: Array<PromiseSettledResult<RecordId<"awaken_run">>>,
): SettledOutcome {
  const successes: Array<RecordId<"awaken_run">> = [];
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      successes.push(result.value);
    } else {
      failures.push(result.reason);
    }
  }
  return { successes, failures };
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] awaken_run unique active index", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "awaken-unique-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-awaken-unique-smoke-"));
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

  afterEach(async () => {
    await clearAwakenRuns(connection);
  });

  test("[smoke] concurrent createRun calls collapse to a single active row", async () => {
    // Fire both inserts before either resolves so neither sees the other's
    // committed row. The unique index serializes them; whichever lands
    // first wins, and the loser surfaces `AwakenRunAlreadyActiveError`.
    const inputs = {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      total: 1,
    };
    const results = await Promise.allSettled([
      createRun(connection.db, inputs),
      createRun(connection.db, inputs),
    ]);

    const { successes, failures } = partitionSettled(results);
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    const failure = failures[0];
    expect(failure).toBeInstanceOf(AwakenRunAlreadyActiveError);
    if (failure instanceof AwakenRunAlreadyActiveError) {
      expect(failure.name).toBe("AwakenRunAlreadyActiveError");
    }

    // The surviving row is the only entry in the active set.
    const active = await findCurrent(connection.db);
    expect(active).not.toBeNull();
    if (active !== null) {
      expect(active.id.toString()).toBe(successes[0]?.toString());
      expect(active.status).toBe("running");
    }
  });

  test("[smoke] sequential createRun rejects after findCurrent observes the running row", async () => {
    const firstId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      total: 1,
    });

    // The pre-existing fast-path guard. Callers consult `findCurrent`
    // before attempting a fresh `createRun`; the unique index is the
    // backstop for the race the spec test verifies in scenario A.
    const observed = await findCurrent(connection.db);
    expect(observed).not.toBeNull();
    if (observed === null) return;
    expect(observed.id.toString()).toBe(firstId.toString());

    let caught: unknown;
    try {
      await createRun(connection.db, {
        tierFilter: [1, 2, 3],
        priorityGlobs: [],
        total: 1,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AwakenRunAlreadyActiveError);
  });

  test("[smoke] paused row blocks createRun; cancelling releases the active slot", async () => {
    const firstId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      total: 2,
    });
    await updateStatus(connection.db, firstId, "paused", { processed: 1 });

    // A paused row still occupies the active marker.
    let caughtPaused: unknown;
    try {
      await createRun(connection.db, {
        tierFilter: [1, 2, 3],
        priorityGlobs: [],
        total: 2,
      });
    } catch (error) {
      caughtPaused = error;
    }
    expect(caughtPaused).toBeInstanceOf(AwakenRunAlreadyActiveError);

    // Cancelling the paused row clears the active marker because the
    // computed `active_marker` field evaluates to NONE for terminal
    // statuses, and SurrealDB's unique index treats NONE as the row
    // being absent from the index.
    await updateStatus(connection.db, firstId, "cancelled");

    const secondId = await createRun(connection.db, {
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      total: 3,
    });
    expect(secondId.toString()).not.toBe(firstId.toString());

    const active = await findCurrent(connection.db);
    expect(active).not.toBeNull();
    if (active !== null) {
      expect(active.id.toString()).toBe(secondId.toString());
      expect(active.status).toBe("running");
    }
  });
});
