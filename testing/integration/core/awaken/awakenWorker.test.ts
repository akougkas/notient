/**
 * Phase 4 Task 8 awaken worker smoke harness.
 *
 * Skipped by default. Run with `NOTIENT_SMOKE=1 bun test src/core/awaken/`.
 *
 * Boots a real SurrealDB, applies the Phase 1 schema, and exercises the
 * worker run loop end-to-end against a mocked vault facade and a mocked
 * indexer queue. Coverage targets the three transitions the worker is
 * responsible for honoring: pause-mid-flight, resume-from-paused, and
 * cancel-mid-flight, plus the two start-time guards (already-active and
 * no-resumable).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { findCurrent, updateStatus } from "../../../../src/core/awaken/awakenRun";
import {
  type AwakenWorkerIndexerQueue,
  type AwakenWorkerVaultFacade,
  runAwakenWorker,
  waitForNoteIndexed,
} from "../../../../src/core/awaken/awakenWorker";
import { sortByPriorityGlobs } from "../../../../src/core/awaken/priorityGlob";
import { createUuidRecordId } from "../../../../src/core/db/recordId";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../../src/core/db/surreal";
import { EventBus } from "../../../../src/core/events/eventBus";
import { prepareNoteRow } from "../../../../src/core/indexer/tier1";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

interface FetchedRow {
  id: RecordId<"awaken_run">;
  status: string;
  processed: number;
  failed: number;
  cursor: string | null | undefined;
  finished_at: string | Date | null;
}

async function clearAwakenState(connection: SurrealConnection): Promise<void> {
  await connection.db.query("DELETE awaken_run; DELETE note;").collect();
}

async function fetchRow(
  connection: SurrealConnection,
  runId: RecordId<"awaken_run">,
): Promise<FetchedRow | undefined> {
  const [rows] = await connection.db
    .query<[FetchedRow[]]>(
      "SELECT id, status, processed, failed, cursor, finished_at FROM awaken_run WHERE id = $id;",
      { id: runId },
    )
    .collect<[FetchedRow[]]>();
  return rows[0];
}

interface RecordedEnqueue {
  path: string;
  priority: number;
}

type AfterEnqueue = (notePath: string) => void | Promise<void>;

async function persistSuccessfulTierState(
  connection: SurrealConnection,
  notePath: string,
): Promise<void> {
  await prepareNoteRow(connection.db, {
    path: notePath,
    sha: "0".repeat(64),
    wordCount: 0,
  });
  await connection.db
    .query(
      "UPDATE note SET tier1_at = time::now(), tier2_at = time::now(), tier3_at = time::now() WHERE path = $path;",
      { path: notePath },
    )
    .collect();
}

function emitNoteIndexed(bus: EventBus, notePath: string): void {
  bus.emit({
    type: "indexer:note-indexed",
    path: notePath,
    result: {
      chunkCount: 0,
      embedCount: 0,
      durationMs: 1,
      llmCalls: 0,
      extractionWindows: 0,
    },
  });
}

function makeIndexerQueue(
  connection: SurrealConnection,
  records: RecordedEnqueue[],
  bus: EventBus,
  afterEnqueue: AfterEnqueue = () => {},
): AwakenWorkerIndexerQueue {
  return {
    enqueue(path: string, priority?: number): void {
      records.push({ path, priority: priority ?? 2 });
      void persistSuccessfulTierState(connection, path)
        .then(() => afterEnqueue(path))
        .then(
          () => emitNoteIndexed(bus, path),
          (error: unknown) => {
            bus.emit({
              type: "indexer:error",
              path,
              message: error instanceof Error ? error.message : String(error),
              phase: "test-indexer",
            });
          },
        );
    },
  };
}

function makeVaultFacade(paths: string[]): AwakenWorkerVaultFacade {
  return {
    listMarkdownPaths: async () => [...paths],
  };
}

function workerSignal(): AbortSignal {
  return new AbortController().signal;
}

const PROPAGATION_DELAY_MS = 250;

// Wait long enough for the SurrealDB live-query notification to land in
// the worker's status closure. The Task 7 smoke uses 250ms as the upper
// bound for local roundtrip; we mirror it here.
function waitForLiveQueryDelivery(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, PROPAGATION_DELAY_MS));
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] awaken worker run loop", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase4-awaken-worker-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-awaken-worker-smoke-"));
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
    await clearAwakenState(connection);
  });

  test("[smoke] happy path completes all notes and clears the cursor", async () => {
    const paths = ["a.md", "b.md", "c.md", "d.md", "e.md"];
    const enqueued: RecordedEnqueue[] = [];
    const bus = new EventBus();
    const result = await runAwakenWorker({
      db: connection.db,
      vaultFacade: makeVaultFacade(paths),
      indexerQueue: makeIndexerQueue(connection, enqueued, bus),
      bus,
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      resume: false,
      signal: workerSignal(),
    });
    expect(result.status).toBe("completed");
    expect(result.processed).toBe(paths.length);
    expect(result.failed).toBe(0);
    expect(enqueued.map((entry) => entry.path)).toEqual(paths);
    // Awaken-driven indexing uses priority 2 (the indexer queue default).
    for (const entry of enqueued) {
      expect(entry.priority).toBe(2);
    }
    const row = await fetchRow(connection, result.runId);
    expect(row?.status).toBe("completed");
    expect(row?.processed).toBe(paths.length);
    expect(row?.cursor == null).toBe(true);
    expect(row?.finished_at != null).toBe(true);
  });

  test("[smoke] a queued note remains uncounted until its canonical completion event", async () => {
    const bus = new EventBus();
    const enqueued: RecordedEnqueue[] = [];
    const worker = runAwakenWorker({
      db: connection.db,
      vaultFacade: makeVaultFacade(["canonical-wait.md"]),
      indexerQueue: {
        enqueue(notePath: string, priority?: number): void {
          enqueued.push({ path: notePath, priority: priority ?? 2 });
        },
      },
      bus,
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      resume: false,
      signal: workerSignal(),
    });
    let settled = false;
    void worker.finally(() => {
      settled = true;
    });

    const enqueueDeadline = Date.now() + 2_000;
    while (enqueued.length === 0 && Date.now() < enqueueDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(enqueued.map((entry) => entry.path)).toEqual(["canonical-wait.md"]);
    expect(settled).toBe(false);

    // Tier progress is observability, not completion. The run must remain
    // blocked until the orchestrator emits its terminal note event.
    bus.emit({ type: "indexer:tier3-done", path: "canonical-wait.md" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    await persistSuccessfulTierState(connection, "canonical-wait.md");
    emitNoteIndexed(bus, "canonical-wait.md");
    const result = await worker;
    expect(result.status).toBe("completed");
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
  });

  test("[smoke] pause mid-flight breaks the loop and persists counters", async () => {
    const paths = ["a.md", "b.md", "c.md", "d.md", "e.md"];
    const enqueued: RecordedEnqueue[] = [];
    const bus = new EventBus();

    let pauseSignalled = false;
    let runIdRef: RecordId<"awaken_run"> | null = null;

    const result = await runAwakenWorker({
      db: connection.db,
      vaultFacade: makeVaultFacade(paths),
      indexerQueue: makeIndexerQueue(connection, enqueued, bus, async (notePath) => {
        if (notePath === "b.md" && !pauseSignalled) {
          pauseSignalled = true;
          // Read the in-flight run id once so we can flip its status.
          const active = await findCurrent(connection.db);
          if (active === null) throw new Error("expected active run during pause smoke");
          runIdRef = active.id;
          await updateStatus(connection.db, active.id, "paused");
          await waitForLiveQueryDelivery();
        }
      }),
      bus,
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      resume: false,
      signal: workerSignal(),
    });

    expect(result.status).toBe("paused");
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(0);
    // Worker must stop enqueueing once it observes `paused` between notes.
    expect(enqueued.map((entry) => entry.path)).toEqual(["a.md", "b.md"]);
    expect(runIdRef).not.toBeNull();
    if (runIdRef === null) return;
    const row = await fetchRow(connection, runIdRef);
    expect(row?.status).toBe("paused");
    expect(row?.processed).toBe(2);
    expect(row?.cursor).toBe("b.md");
    // Non-terminal status: finished_at must remain null.
    expect(row?.finished_at == null).toBe(true);
  });

  test("[smoke] resume from paused picks up the same run and completes", async () => {
    const paths = ["a.md", "b.md", "c.md", "d.md", "e.md"];

    // First pass: pause after b.md.
    const firstEnqueued: RecordedEnqueue[] = [];
    const firstBus = new EventBus();
    let pauseSignalled = false;
    const firstResult = await runAwakenWorker({
      db: connection.db,
      vaultFacade: makeVaultFacade(paths),
      indexerQueue: makeIndexerQueue(connection, firstEnqueued, firstBus, async (notePath) => {
        if (notePath === "b.md" && !pauseSignalled) {
          pauseSignalled = true;
          const active = await findCurrent(connection.db);
          if (active === null) throw new Error("expected active run during pause-resume smoke");
          await updateStatus(connection.db, active.id, "paused");
          await waitForLiveQueryDelivery();
        }
      }),
      bus: firstBus,
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      resume: false,
      signal: workerSignal(),
    });
    expect(firstResult.status).toBe("paused");
    expect(firstResult.processed).toBe(2);

    // Second pass: resume picks up the same row and finishes the rest.
    const secondEnqueued: RecordedEnqueue[] = [];
    const secondBus = new EventBus();
    const secondResult = await runAwakenWorker({
      db: connection.db,
      vaultFacade: makeVaultFacade(paths),
      indexerQueue: makeIndexerQueue(connection, secondEnqueued, secondBus),
      bus: secondBus,
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      resume: true,
      signal: workerSignal(),
    });

    expect(secondResult.runId.toString()).toBe(firstResult.runId.toString());
    expect(secondResult.status).toBe("completed");
    expect(secondResult.processed).toBe(paths.length);
    expect(secondResult.failed).toBe(0);
    // Resume must NOT re-enqueue paths covered before the pause.
    expect(secondEnqueued.map((entry) => entry.path)).toEqual(["c.md", "d.md", "e.md"]);
    const row = await fetchRow(connection, secondResult.runId);
    expect(row?.status).toBe("completed");
    expect(row?.processed).toBe(paths.length);
    expect(row?.cursor == null).toBe(true);
  });

  test("[smoke] cancel mid-flight breaks the loop and persists cancelled status", async () => {
    const paths = ["a.md", "b.md", "c.md", "d.md", "e.md"];
    const enqueued: RecordedEnqueue[] = [];
    const bus = new EventBus();
    let cancelSignalled = false;
    let runIdRef: RecordId<"awaken_run"> | null = null;

    const result = await runAwakenWorker({
      db: connection.db,
      vaultFacade: makeVaultFacade(paths),
      indexerQueue: makeIndexerQueue(connection, enqueued, bus, async (notePath) => {
        if (notePath === "a.md" && !cancelSignalled) {
          cancelSignalled = true;
          const active = await findCurrent(connection.db);
          if (active === null) throw new Error("expected active run during cancel smoke");
          runIdRef = active.id;
          await updateStatus(connection.db, active.id, "cancelled");
          await waitForLiveQueryDelivery();
        }
      }),
      bus,
      tierFilter: [1, 2, 3],
      priorityGlobs: [],
      resume: false,
      signal: workerSignal(),
    });

    expect(result.status).toBe("cancelled");
    expect(result.processed).toBe(1);
    expect(enqueued.map((entry) => entry.path)).toEqual(["a.md"]);
    expect(runIdRef).not.toBeNull();
    if (runIdRef === null) return;
    const row = await fetchRow(connection, runIdRef);
    expect(row?.status).toBe("cancelled");
    expect(row?.processed).toBe(1);
    expect(row?.cursor).toBe("a.md");
    // Cancelled is terminal: finished_at must be stamped.
    expect(row?.finished_at != null).toBe(true);
  });

  test("[smoke] start-time guard rejects when a run is already active", async () => {
    // Seed a synthetic `running` row directly so the guard fires
    // deterministically without needing to interleave two concurrent
    // worker invocations.
    await connection.db
      .query(
        "CREATE ONLY $id CONTENT { status: 'running', total: 0, processed: 0, failed: 0, tier_filter: [1,2,3], priority_globs: [] };",
        { id: createUuidRecordId("awaken_run") },
      )
      .collect();

    const bus = new EventBus();
    await expect(
      runAwakenWorker({
        db: connection.db,
        vaultFacade: makeVaultFacade(["a.md"]),
        indexerQueue: makeIndexerQueue(connection, [], bus),
        bus,
        tierFilter: [1, 2, 3],
        priorityGlobs: [],
        resume: false,
        signal: workerSignal(),
      }),
    ).rejects.toThrow(/already active/);
  });

  test("[smoke] resume guard rejects when no resumable run exists", async () => {
    const bus = new EventBus();
    await expect(
      runAwakenWorker({
        db: connection.db,
        vaultFacade: makeVaultFacade(["a.md"]),
        indexerQueue: makeIndexerQueue(connection, [], bus),
        bus,
        tierFilter: [1, 2, 3],
        priorityGlobs: [],
        resume: true,
        signal: workerSignal(),
      }),
    ).rejects.toThrow(/no resumable run/);
  });

  test("[smoke] priority globs reorder paths so daily/** notes go first", async () => {
    const paths = ["projects/x.md", "daily/2024-04-29.md", "MOCs/Index.md", "notes/g.md"];
    const enqueued: RecordedEnqueue[] = [];
    const bus = new EventBus();
    const result = await runAwakenWorker({
      db: connection.db,
      vaultFacade: makeVaultFacade(paths),
      indexerQueue: makeIndexerQueue(connection, enqueued, bus),
      bus,
      tierFilter: [1, 2, 3],
      priorityGlobs: ["daily/**", "MOCs/**"],
      resume: false,
      signal: workerSignal(),
    });
    expect(result.status).toBe("completed");
    expect(enqueued.map((entry) => entry.path)).toEqual([
      "daily/2024-04-29.md",
      "MOCs/Index.md",
      "notes/g.md",
      "projects/x.md",
    ]);
  });
});
