import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DateTime, RecordId, type Surreal, Table } from "surrealdb";
import type { VaultAdapter } from "../../../../src/adapters/vaultAdapter";
import { AwakenBackgroundRegistry } from "../../../../src/core/awaken/backgroundRegistry";
import { createUuidRecordId } from "../../../../src/core/db/recordId";
import type { SurrealConnection } from "../../../../src/core/db/surreal";
import { EventBus } from "../../../../src/core/events/eventBus";
import type { IndexerQueue } from "../../../../src/core/indexer/indexerQueue";
import {
  type AwakenHandlerDeps,
  makeAwakenCancelHandler,
  makeAwakenHandler,
  makeAwakenPauseHandler,
  makeAwakenResumeHandler,
  makeAwakenStatusHandler,
  makeReindexHandler,
} from "../../../../src/daemon/handlers/awaken";
import { rpcRequest } from "../../../rpcRequest";

const INCLUDE_ALL = (): boolean => false;
const NO_APPROVAL_INTENTS = {
  cancelForNoteDeletion: async () => ({ cancelled: 0, failed: 0 }),
};

function awakenRunId(value: number): RecordId<"awaken_run"> {
  return createUuidRecordId(
    "awaken_run",
    `018f05cd-3f7b-7000-8000-${value.toString().padStart(12, "0")}`,
  );
}

interface RecordedEnqueue {
  path: string;
  priority: number | undefined;
  tierFilter: ReadonlyArray<number> | undefined;
}

interface FakeQueue {
  records: RecordedEnqueue[];
  enqueued: string[];
  enqueue: (path: string, priority?: number, tierFilter?: ReadonlyArray<number>) => void;
  drain: () => Promise<void>;
}

/**
 * Build a queue stub that tees every `enqueue(path)` into an
 * `indexer:note-indexed` event on the bus. The awaken handler now drives
 * `runAwakenWorker`, which awaits per-note completion via that event;
 * without this tee the worker would block on `findCurrent` -> `enqueue`
 * forever in unit tests.
 */
function emitNoteIndexed(bus: EventBus, path: string): void {
  bus.emit({
    type: "indexer:note-indexed",
    path,
    result: {
      chunkCount: 0,
      embedCount: 0,
      durationMs: 1,
      llmCalls: 0,
      extractionWindows: 0,
    },
  });
}

function makeQueue(bus: EventBus): FakeQueue {
  const queue: FakeQueue = {
    records: [],
    enqueued: [],
    enqueue: (path, priority, tierFilter) => {
      queue.records.push({ path, priority, tierFilter });
      queue.enqueued.push(path);
      // Emit on a microtask boundary so the worker has a chance to
      // register its `indexer:note-indexed` listener before the event
      // fires.
      queueMicrotask(() => {
        emitNoteIndexed(bus, path);
      });
    },
    drain: async () => {},
  };
  return queue;
}

function shaOf(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function makeVault(
  files: { path: string; mtime: number }[],
): Pick<VaultAdapter, "listMarkdown" | "read"> {
  return {
    listMarkdown: async () => files,
    read: async (path: string) => `# ${path}\n`,
  };
}

/**
 * `makeVault` variant whose `read` throws. Reindex unit tests use this
 * shape so the `preCreateNoteRows` pass inside `makeReindexHandler` is
 * skipped (the per-path try/catch swallows the read error and
 * continues). The reindex tests assert exact `surreal.queries` lengths
 * against the `clearTierAtByPath` step alone; a working `read` would
 * interleave `prepareNoteRow` queries and break those assertions.
 */
function makeVaultWithoutRead(
  files: { path: string; mtime: number }[],
): Pick<VaultAdapter, "listMarkdown" | "read"> {
  return {
    listMarkdown: async () => files,
    read: async () => {
      throw new Error("vault.read not implemented in this test fixture");
    },
  };
}

interface RecordedQuery {
  sql: string;
  bindings: Record<string, unknown> | undefined;
}

interface FakeSurrealConnection extends SurrealConnection {
  queries: RecordedQuery[];
  awakenRows: Map<string, AwakenRowState>;
  tierStates: Map<string, StoredTierState>;
  /** Paths (with their stored sha) the fake reports as stamped at a tier. */
  stampedAtTier: Map<number, Map<string, string>>;
}

interface AwakenRowState {
  id: RecordId<"awaken_run">;
  status: string;
  started_at: DateTime;
  finished_at?: DateTime | undefined;
  total: number;
  processed: number;
  failed: number;
  attempted: number;
  tier_filter: number[];
  priority_globs: string[];
  paths: string[];
  cursor?: string | undefined;
  error?: string | undefined;
  failure_reason?: string | undefined;
  failures: string[];
}

interface StoredTierState {
  tier1_at: DateTime;
  tier2_at: DateTime;
  tier3_at: DateTime;
}

function createAwakenRowState(
  id: RecordId<"awaken_run">,
  input: Record<string, unknown>,
): AwakenRowState {
  return {
    id,
    status: typeof input.status === "string" ? input.status : "running",
    started_at: new DateTime(new Date()),
    total: typeof input.total === "number" ? input.total : 0,
    processed: 0,
    failed: 0,
    attempted: 0,
    tier_filter: Array.isArray(input.tier_filter) ? (input.tier_filter as number[]) : [],
    priority_globs: Array.isArray(input.priority_globs) ? (input.priority_globs as string[]) : [],
    paths: Array.isArray(input.paths) ? (input.paths as string[]) : [],
    failures: [],
  };
}

function selectAwakenRows(
  awakenRows: ReadonlyMap<string, AwakenRowState>,
  filter: (row: AwakenRowState) => boolean,
): AwakenRowState[] {
  return Array.from(awakenRows.values())
    .filter(filter)
    .sort((a, b) => b.started_at.toDate().getTime() - a.started_at.toDate().getTime());
}

function newestAwakenRowSlice(rows: AwakenRowState[]): unknown[] {
  return [rows.length === 0 ? [] : [rows[0]]];
}

function stampedNoteQueryResult(
  sql: string,
  stampedAtTier: ReadonlyMap<number, Map<string, string>>,
): unknown[] | null {
  const stampMatch = /^SELECT path, sha FROM note WHERE tier(\d)_at != NONE/.exec(sql);
  if (stampMatch?.[1] === undefined) return null;
  const stamped = stampedAtTier.get(Number(stampMatch[1])) ?? new Map<string, string>();
  return [Array.from(stamped, ([path, sha]) => ({ path, sha }))];
}

function tierStateQueryResult(
  sql: string,
  bindings: Record<string, unknown> | undefined,
  tierStates: ReadonlyMap<string, StoredTierState>,
): unknown[] | null {
  if (!sql.startsWith("SELECT path, tier1_at, tier2_at, tier3_at FROM note")) return null;
  if (!Array.isArray(bindings?.paths)) return [[]];
  const rows = bindings.paths.flatMap((path) => {
    if (typeof path !== "string") return [];
    const state = tierStates.get(path);
    return state === undefined ? [] : [{ path, ...state }];
  });
  return [rows];
}

function boundAwakenRow(
  bindings: Record<string, unknown> | undefined,
  awakenRows: ReadonlyMap<string, AwakenRowState>,
): AwakenRowState | undefined {
  const idCandidate = bindings?.id;
  if (!(idCandidate instanceof RecordId)) return undefined;
  return awakenRows.get(idCandidate.id.toString());
}

function awakenSelectQueryResult(
  sql: string,
  bindings: Record<string, unknown> | undefined,
  awakenRows: ReadonlyMap<string, AwakenRowState>,
): unknown[] | null {
  if (!sql.startsWith("SELECT") || !sql.includes("FROM awaken_run")) return null;
  if (sql.includes("WHERE id = $id")) {
    const row = boundAwakenRow(bindings, awakenRows);
    return [row === undefined ? [] : [row]];
  }
  if (sql.includes("status INSIDE ['running','paused']")) {
    return newestAwakenRowSlice(
      selectAwakenRows(awakenRows, (row) => row.status === "running" || row.status === "paused"),
    );
  }
  if (sql.includes("status INSIDE ['paused','failed']")) {
    return newestAwakenRowSlice(
      selectAwakenRows(awakenRows, (row) => row.status === "paused" || row.status === "failed"),
    );
  }
  if (sql.includes("ORDER BY started_at DESC LIMIT 1")) {
    return newestAwakenRowSlice(selectAwakenRows(awakenRows, () => true));
  }
  return [[]];
}

function applyAwakenUpdate(
  row: AwakenRowState,
  sql: string,
  bindings: Record<string, unknown> | undefined,
): void {
  if (typeof bindings?.status === "string") row.status = bindings.status;
  if (typeof bindings?.processed === "number") row.processed = bindings.processed;
  if (typeof bindings?.failed === "number") row.failed = bindings.failed;
  if (typeof bindings?.attempted === "number") row.attempted = bindings.attempted;
  if (typeof bindings?.cursor === "string") row.cursor = bindings.cursor;
  if (Array.isArray(bindings?.failures)) row.failures = bindings.failures as string[];
  if (sql.includes("cursor = NONE")) row.cursor = undefined;
  if (sql.includes("finished_at = IF")) {
    row.finished_at = new DateTime(new Date());
  } else if (sql.includes("finished_at = NONE")) {
    row.finished_at = undefined;
  }
  if (sql.includes("error = NONE")) row.error = undefined;
  if (sql.includes("failure_reason = NONE")) row.failure_reason = undefined;
  if (typeof bindings?.error === "string") row.error = bindings.error;
  if (typeof bindings?.failure_reason === "string") {
    row.failure_reason = bindings.failure_reason;
  }
}

function awakenUpdateQueryResult(
  sql: string,
  bindings: Record<string, unknown> | undefined,
  awakenRows: ReadonlyMap<string, AwakenRowState>,
): unknown[] | null {
  if (!sql.startsWith("UPDATE $id SET")) return null;
  const row = boundAwakenRow(bindings, awakenRows);
  if (row !== undefined) applyAwakenUpdate(row, sql, bindings);
  return [row === undefined ? [] : [row]];
}

function runFakeQuery(
  sql: string,
  bindings: Record<string, unknown> | undefined,
  queries: RecordedQuery[],
  awakenRows: ReadonlyMap<string, AwakenRowState>,
  stampedAtTier: ReadonlyMap<number, Map<string, string>>,
  tierStates: ReadonlyMap<string, StoredTierState>,
): unknown[] {
  queries.push({ sql, bindings });
  return (
    stampedNoteQueryResult(sql, stampedAtTier) ??
    tierStateQueryResult(sql, bindings, tierStates) ??
    awakenSelectQueryResult(sql, bindings, awakenRows) ??
    awakenUpdateQueryResult(sql, bindings, awakenRows) ?? [[]]
  );
}

/**
 * Build a SurrealConnection-shaped fake that supports the awaken handler's
 * runtime needs:
 *
 *   - `db.create(awakenRunRecordId)` for `createRun` (the awaken
 *     control plane).
 *   - `db.query(SELECT ... FROM awaken_run ...)` for `findCurrent`,
 *     `findLatestResumable`, and `findById`.
 *   - `db.query(UPDATE $id SET ...)` for `updateStatus`.
 *   - `db.live(new Table("awaken_run"))` returning a noop subscription so
 *     the worker's status-change subscription resolves (the unit tests
 *     never flip the row mid-flight, so the noop is sufficient).
 *   - `db.query(...)` calls fired by `clearTierAtByPath` (the reindex
 *     handler).
 *
 * Every recorded query is appended to `queries` so the existing reindex
 * tests still inspect SQL exactly as before.
 */
function makeFakeSurreal(bus?: EventBus): FakeSurrealConnection {
  const queries: RecordedQuery[] = [];
  const awakenRows = new Map<string, AwakenRowState>();
  const stampedAtTier = new Map<number, Map<string, string>>();
  const tierStates = new Map<string, StoredTierState>();
  let runCounter = 0;

  bus?.on("indexer:note-indexed", (event) => {
    const stamp = new DateTime(new Date());
    tierStates.set(event.path, {
      tier1_at: stamp,
      tier2_at: stamp,
      tier3_at: stamp,
    });
  });

  const fakeDb = {
    create: (target: unknown) => {
      const tableName =
        target instanceof Table
          ? target.name
          : target instanceof RecordId
            ? String(target.table)
            : "";
      return {
        content: async (input: Record<string, unknown>) => {
          if (tableName !== "awaken_run") {
            return [{ id: new RecordId(tableName, `fake-${runCounter++}`) }];
          }
          runCounter += 1;
          const id =
            target instanceof RecordId
              ? (target as RecordId<"awaken_run">)
              : awakenRunId(runCounter);
          const row = createAwakenRowState(id, input);
          awakenRows.set(id.id.toString(), row);
          return row;
        },
      };
    },
    query: (sql: string, bindings?: Record<string, unknown>) => {
      const result = runFakeQuery(sql, bindings, queries, awakenRows, stampedAtTier, tierStates);
      return {
        collect: async () => result,
      };
    },
    live: async () => ({
      subscribe: () => () => {},
      kill: async () => {},
    }),
  };
  return {
    db: fakeDb as unknown as Surreal,
    close: async () => {},
    queries,
    awakenRows,
    tierStates,
    stampedAtTier,
  };
}

describe("awaken handler", () => {
  test("creates an awaken_run row, enqueues every markdown file, and reaches completed", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal(bus);
    const vault = makeVault([
      { path: "a.md", mtime: 1000 },
      { path: "b.md", mtime: 2000 },
    ]);
    const lines: string[] = [];
    const handler = makeAwakenHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      awakenBackgroundRegistry: new AwakenBackgroundRegistry(),
      surreal,
      isExcluded: INCLUDE_ALL,
      approvalIntents: NO_APPROVAL_INTENTS,
    });
    const result = await handler(rpcRequest({}, { emit: (line) => lines.push(line) }));
    expect(queue.enqueued.sort()).toEqual(["a.md", "b.md"]);
    expect(result.ok).toBe(true);
    expect(result.queued).toBe(2);
    expect(result.status).toBe("completed");
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(0);
    expect(typeof result.runId).toBe("string");
    // The fake surreal recorded a row that the control-plane CLI helpers
    // would now find via `findCurrent` / `findById`.
    expect(surreal.awakenRows.size).toBe(1);
    const row = Array.from(surreal.awakenRows.values())[0];
    expect(row?.status).toBe("completed");
    expect(row?.processed).toBe(2);
    expect(row?.total).toBe(2);
  });

  test("reconciles in one batch per checkpoint and one final batch", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal(bus);
    const paths = Array.from(
      { length: 30 },
      (_, index) => `note-${String(index).padStart(2, "0")}.md`,
    );
    const handler = makeAwakenHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: makeVault(paths.map((path, index) => ({ path, mtime: index }))) as VaultAdapter,
      awakenBackgroundRegistry: new AwakenBackgroundRegistry(),
      surreal,
      isExcluded: INCLUDE_ALL,
      approvalIntents: NO_APPROVAL_INTENTS,
    });

    const result = await handler(rpcRequest({}, { requestId: "req-batches" }));

    expect(result.processed).toBe(30);
    expect(result.failed).toBe(0);
    const reconciliations = surreal.queries.filter((entry) =>
      entry.sql.includes("SELECT path, tier1_at, tier2_at, tier3_at"),
    );
    expect(reconciliations).toHaveLength(4);
    expect(reconciliations.map((entry) => entry.bindings?.paths)).toEqual([
      paths.slice(0, 10),
      paths.slice(10, 20),
      paths.slice(20, 30),
      paths,
    ]);
    const checkpoints = surreal.queries.filter(
      (entry) => entry.sql.startsWith("UPDATE $id SET") && entry.bindings?.status === "running",
    );
    expect(checkpoints.map((entry) => entry.bindings?.attempted)).toEqual([10, 20, 30]);
  });

  test("a tier-filtered run skips stamped notes whose content is unchanged", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal(bus);
    surreal.stampedAtTier.set(
      3,
      new Map([
        ["a.md", shaOf("# a.md\n")],
        ["b.md", shaOf("# b.md\n")],
      ]),
    );
    const reads: string[] = [];
    const vault: Pick<VaultAdapter, "listMarkdown" | "read"> = {
      listMarkdown: async () => [
        { path: "a.md", mtime: 1000 },
        { path: "b.md", mtime: 2000 },
        { path: "c.md", mtime: 3000 },
      ],
      read: async (path: string) => {
        reads.push(path);
        return `# ${path}\n`;
      },
    };
    const handler = makeAwakenHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      awakenBackgroundRegistry: new AwakenBackgroundRegistry(),
      surreal,
      isExcluded: INCLUDE_ALL,
      approvalIntents: NO_APPROVAL_INTENTS,
    });
    const result = await handler(rpcRequest({ tier: [3] }));
    expect(queue.enqueued).toEqual(["c.md"]);
    expect(result.queued).toBe(1);
    // Stamped notes are hashed once to prove they are unchanged, but never
    // pre-created a second time or pushed through the indexer queue.
    expect(reads.filter((path) => path === "a.md")).toHaveLength(1);
    expect(reads.filter((path) => path === "c.md")).toHaveLength(1);
  });

  test("a stamped note edited while the daemon was down is still queued", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal(bus);
    surreal.stampedAtTier.set(
      3,
      new Map([
        ["a.md", shaOf("# a.md\n")],
        ["b.md", shaOf("stale body that no longer matches the file")],
      ]),
    );
    const handler = makeAwakenHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: makeVault([
        { path: "a.md", mtime: 1000 },
        { path: "b.md", mtime: 2000 },
      ]) as VaultAdapter,
      awakenBackgroundRegistry: new AwakenBackgroundRegistry(),
      surreal,
      isExcluded: INCLUDE_ALL,
      approvalIntents: NO_APPROVAL_INTENTS,
    });
    const result = await handler(rpcRequest({ tier: [3] }));
    expect(queue.enqueued).toEqual(["b.md"]);
    expect(result.queued).toBe(1);
  });

  test("an explicit since window still queues stamped notes", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal(bus);
    surreal.stampedAtTier.set(
      3,
      new Map([
        ["a.md", shaOf("# a.md\n")],
        ["b.md", shaOf("# b.md\n")],
      ]),
    );
    const handler = makeAwakenHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: makeVault([
        { path: "a.md", mtime: 1000 },
        { path: "b.md", mtime: 2000 },
      ]) as VaultAdapter,
      awakenBackgroundRegistry: new AwakenBackgroundRegistry(),
      surreal,
      isExcluded: INCLUDE_ALL,
      approvalIntents: NO_APPROVAL_INTENTS,
    });
    const result = await handler(rpcRequest({ tier: [3], since: 500 }));
    expect(queue.enqueued.sort()).toEqual(["a.md", "b.md"]);
    expect(result.queued).toBe(2);
  });

  test("filters by since when provided", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal(bus);
    const vault = makeVault([
      { path: "old.md", mtime: 1000 },
      { path: "new.md", mtime: 5000 },
    ]);
    const handler = makeAwakenHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      awakenBackgroundRegistry: new AwakenBackgroundRegistry(),
      surreal,
      isExcluded: INCLUDE_ALL,
      approvalIntents: NO_APPROVAL_INTENTS,
    });
    await handler(rpcRequest({ since: 3000 }));
    expect(queue.enqueued).toEqual(["new.md"]);
  });

  test("forwards a partial tier filter to the queue", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal(bus);
    const vault = makeVault([
      { path: "a.md", mtime: 1 },
      { path: "b.md", mtime: 2 },
    ]);
    const handler = makeAwakenHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      awakenBackgroundRegistry: new AwakenBackgroundRegistry(),
      surreal,
      isExcluded: INCLUDE_ALL,
      approvalIntents: NO_APPROVAL_INTENTS,
    });
    const result = await handler(rpcRequest({ tier: [2] }));
    expect(result.tier).toEqual([2]);
    expect(queue.records).toHaveLength(2);
    for (const record of queue.records) {
      expect(record.tierFilter).toEqual([2]);
    }
  });

  test("forwards an undefined tier filter for the default `[1, 2, 3]` filter", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal(bus);
    const vault = makeVault([{ path: "a.md", mtime: 1 }]);
    const handler = makeAwakenHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      awakenBackgroundRegistry: new AwakenBackgroundRegistry(),
      surreal,
      isExcluded: INCLUDE_ALL,
      approvalIntents: NO_APPROVAL_INTENTS,
    });
    await handler(rpcRequest({ tier: [1, 2, 3] }));
    expect(queue.records[0]?.tierFilter).toBeUndefined();
  });

  test("rejects an invalid tier array without enqueueing", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal(bus);
    const vault = makeVault([{ path: "a.md", mtime: 1 }]);
    const handler = makeAwakenHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      awakenBackgroundRegistry: new AwakenBackgroundRegistry(),
      surreal,
      isExcluded: INCLUDE_ALL,
      approvalIntents: NO_APPROVAL_INTENTS,
    });
    await expect(handler(rpcRequest({ tier: ["abc", 0, 5] }))).rejects.toThrow(
      /invalid tier filter/,
    );
    expect(queue.records).toEqual([]);
  });

  test("rejects stale fields, invalid since/background values, and non-canonical tiers", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal(bus);
    let listed = false;
    const handler = makeAwakenHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: {
        listMarkdown: async () => {
          listed = true;
          return [];
        },
        read: async () => "",
      } as unknown as VaultAdapter,
      awakenBackgroundRegistry: new AwakenBackgroundRegistry(),
      surreal,
      isExcluded: INCLUDE_ALL,
      approvalIntents: NO_APPROVAL_INTENTS,
    });

    for (const params of [
      { force: true },
      { tierFilter: [1] },
      { batch: 10 },
      { since: -1 },
      { since: 1.5 },
      { since: "2026-08-30" },
      { background: false },
      { background: null },
      { tier: [2, 1] },
      { tier: [2, 2] },
    ]) {
      await expect(handler(rpcRequest(params))).rejects.toThrow();
    }

    expect(listed).toBe(false);
    expect(queue.records).toEqual([]);
    expect(surreal.awakenRows.size).toBe(0);
  });

  test("background: true returns immediately with a runId before the worker finishes", async () => {
    // Slow stub indexer: the bus event tee waits 50ms per path before
    // emitting `indexer:note-indexed`, so a foreground call would block on
    // every enqueue. The background path must return before the first
    // event fires.
    const bus = new EventBus();
    const surreal = makeFakeSurreal(bus);
    let enqueueCount = 0;
    const slowQueue = {
      records: [] as RecordedEnqueue[],
      enqueued: [] as string[],
      enqueue: (path: string, priority?: number, tierFilter?: ReadonlyArray<number>): void => {
        slowQueue.records.push({ path, priority, tierFilter });
        slowQueue.enqueued.push(path);
        enqueueCount += 1;
        setTimeout(() => {
          emitNoteIndexed(bus, path);
        }, 50);
      },
      drain: async () => {},
    };
    const vault = makeVault([
      { path: "a.md", mtime: 1 },
      { path: "b.md", mtime: 2 },
      { path: "c.md", mtime: 3 },
    ]);
    const handler = makeAwakenHandler({
      bus,
      indexer: slowQueue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      awakenBackgroundRegistry: new AwakenBackgroundRegistry(),
      surreal,
      isExcluded: INCLUDE_ALL,
      approvalIntents: NO_APPROVAL_INTENTS,
    });
    const startedAt = Date.now();
    const result = await handler(rpcRequest({ background: true }));
    const elapsed = Date.now() - startedAt;

    expect(result.ok).toBe(true);
    expect(result.background).toBe(true);
    expect(result.status).toBe("running");
    expect(typeof result.runId).toBe("string");
    // The background path must not block on the slow enqueue cycle. The
    // first `setTimeout` would only fire after 50ms; the handler should
    // return well before three enqueues complete.
    expect(elapsed).toBeLessThan(150);
    expect(enqueueCount).toBeLessThanOrEqual(1);

    // Wait for the background worker to drain so the test does not leak
    // a pending timer into the next test.
    await new Promise((resolve) => setTimeout(resolve, 250));
  });

  test("rejects a fresh run while a prior background worker is still draining", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal(bus);
    const registry = new AwakenBackgroundRegistry();
    registry.start(() => new Promise(() => {}));
    let listedVault = false;
    const vault = {
      listMarkdown: async () => {
        listedVault = true;
        return [{ path: "a.md", mtime: 1 }];
      },
      read: async (path: string) => `# ${path}\n`,
    };
    const handler = makeAwakenHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      awakenBackgroundRegistry: registry,
      surreal,
      isExcluded: INCLUDE_ALL,
      approvalIntents: NO_APPROVAL_INTENTS,
    });

    let caught: unknown;
    try {
      await handler(rpcRequest({ background: true }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("background awaken worker is still draining");
    expect(listedVault).toBe(false);
    expect(surreal.awakenRows.size).toBe(0);
    expect(queue.enqueued).toEqual([]);
  });

  test("rejects construction when the canonical SurrealDB substrate is missing", () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const vault = makeVault([{ path: "a.md", mtime: 1 }]);

    expect(() =>
      makeAwakenHandler({
        bus,
        indexer: queue as unknown as IndexerQueue,
        vault: vault as VaultAdapter,
        awakenBackgroundRegistry: new AwakenBackgroundRegistry(),
        isExcluded: INCLUDE_ALL,
        approvalIntents: NO_APPROVAL_INTENTS,
      } as unknown as AwakenHandlerDeps),
    ).toThrow("Awaken handlers require the SurrealDB substrate");
  });
});

describe("awaken status handler", () => {
  function seedRow(
    surreal: FakeSurrealConnection,
    status: AwakenRowState["status"] = "running",
  ): AwakenRowState {
    const id = awakenRunId(900);
    const paths = Array.from({ length: 12 }, (_, index) => `note-${index}.md`);
    const completed = status === "completed";
    const row: AwakenRowState = {
      id,
      status,
      started_at: new DateTime(new Date(1_700_000_000_000)),
      ...(completed
        ? { finished_at: new DateTime(new Date(1_700_000_001_000)) }
        : { cursor: paths[5] }),
      total: 12,
      processed: completed ? 11 : 5,
      failed: 1,
      attempted: completed ? 12 : 6,
      tier_filter: [1, 2, 3],
      priority_globs: [],
      paths,
      failures: [],
    };
    surreal.awakenRows.set(id.id.toString(), row);
    return row;
  }

  test("returns the current run using the canonical wire shape", async () => {
    const surreal = makeFakeSurreal();
    const row = seedRow(surreal);
    const result = await makeAwakenStatusHandler({ surreal })(rpcRequest());
    expect(result).toEqual({
      ok: true,
      run: {
        runId: row.id.toString(),
        status: "running",
        processed: 5,
        failed: 1,
        total: 12,
        startedAt: 1_700_000_000_000,
      },
    });
  });

  test("locks a follow-up read to its explicit run id", async () => {
    const surreal = makeFakeSurreal();
    const row = seedRow(surreal, "completed");
    const result = await makeAwakenStatusHandler({ surreal })(
      rpcRequest({ runId: row.id.toString() }),
    );
    expect((result.run as Record<string, unknown>).status).toBe("completed");
    expect(surreal.queries.at(-1)?.sql).toContain("WHERE id = $id");
  });

  test("returns null for a vault with no awaken history", async () => {
    const result = await makeAwakenStatusHandler({ surreal: makeFakeSurreal() })(rpcRequest());
    expect(result).toEqual({ ok: true, run: null });
  });

  test("rejects ids outside awaken_run before querying", async () => {
    const surreal = makeFakeSurreal();
    await expect(
      makeAwakenStatusHandler({ surreal })(rpcRequest({ runId: "note:wrong" })),
    ).rejects.toThrow("awaken_run");
    expect(surreal.queries).toHaveLength(0);
  });

  test("rejects empty and non-canonical awaken run keys", async () => {
    const surreal = makeFakeSurreal();
    const handler = makeAwakenStatusHandler({ surreal });
    await expect(handler(rpcRequest({ runId: "awaken_run:" }))).rejects.toThrow("canonical");
    await expect(handler(rpcRequest({ runId: "awaken_run:two words" }))).rejects.toThrow(
      "canonical",
    );
    expect(surreal.queries).toHaveLength(0);
  });

  test("rejects unknown status params and explicit null runId", async () => {
    const surreal = makeFakeSurreal();
    const handler = makeAwakenStatusHandler({ surreal });
    await expect(handler(rpcRequest({ latest: true }))).rejects.toThrow("unknown awaken parameter");
    await expect(handler(rpcRequest({ runId: null }))).rejects.toThrow("awaken_run");
    expect(surreal.queries).toHaveLength(0);
  });
});

describe("awaken pause/cancel handlers", () => {
  function seedRunningRow(surreal: FakeSurrealConnection): RecordId<"awaken_run"> {
    const id = awakenRunId(901);
    surreal.awakenRows.set(id.id.toString(), {
      id,
      status: "running",
      started_at: new DateTime(new Date()),
      total: 5,
      processed: 2,
      failed: 1,
      attempted: 3,
      tier_filter: [1, 2, 3],
      priority_globs: [],
      paths: ["a.md", "b.md", "c.md", "d.md", "e.md"],
      cursor: "b.md",
      failures: ["c.md"],
    });
    return id;
  }

  test("pause flips the current row and reports a draining background worker", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal();
    const registry = new AwakenBackgroundRegistry();
    registry.start(() => new Promise(() => {}));
    const runId = seedRunningRow(surreal);
    const handler = makeAwakenPauseHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: makeVault([]) as VaultAdapter,
      awakenBackgroundRegistry: registry,
      surreal,
      isExcluded: INCLUDE_ALL,
      approvalIntents: NO_APPROVAL_INTENTS,
    });

    const result = await handler(rpcRequest());

    expect(result).toMatchObject({
      ok: true,
      runId: runId.toString(),
      processed: 2,
      failed: 1,
      total: 5,
      status: "paused",
      draining: true,
    });
    expect(surreal.awakenRows.get(runId.id.toString())?.status).toBe("paused");
  });

  test("cancel flips the current row to terminal status and reports draining", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal();
    const registry = new AwakenBackgroundRegistry();
    registry.start(() => new Promise(() => {}));
    const runId = seedRunningRow(surreal);
    const handler = makeAwakenCancelHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: makeVault([]) as VaultAdapter,
      awakenBackgroundRegistry: registry,
      surreal,
      isExcluded: INCLUDE_ALL,
      approvalIntents: NO_APPROVAL_INTENTS,
    });

    const result = await handler(rpcRequest());

    expect(result).toMatchObject({
      ok: true,
      runId: runId.toString(),
      processed: 2,
      failed: 1,
      total: 5,
      status: "cancelled",
      draining: true,
    });
    const row = surreal.awakenRows.get(runId.id.toString());
    expect(row?.status).toBe("cancelled");
    expect(row?.finished_at).not.toBeNull();
  });

  test("pause rejects when no current row exists", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const handler = makeAwakenPauseHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: makeVault([]) as VaultAdapter,
      awakenBackgroundRegistry: new AwakenBackgroundRegistry(),
      surreal: makeFakeSurreal(),
      isExcluded: INCLUDE_ALL,
      approvalIntents: NO_APPROVAL_INTENTS,
    });

    let caught: unknown;
    try {
      await handler(rpcRequest());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("nothing to pause");
  });

  test("cancel rejects when no current row exists", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const handler = makeAwakenCancelHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: makeVault([]) as VaultAdapter,
      awakenBackgroundRegistry: new AwakenBackgroundRegistry(),
      surreal: makeFakeSurreal(),
      isExcluded: INCLUDE_ALL,
      approvalIntents: NO_APPROVAL_INTENTS,
    });

    let caught: unknown;
    try {
      await handler(rpcRequest());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("nothing to cancel");
  });

  test("pause and cancel reject every parameter before reading run state", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal();
    const deps: AwakenHandlerDeps = {
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: makeVault([]) as VaultAdapter,
      awakenBackgroundRegistry: new AwakenBackgroundRegistry(),
      surreal,
      isExcluded: INCLUDE_ALL,
      approvalIntents: NO_APPROVAL_INTENTS,
    };
    await expect(makeAwakenPauseHandler(deps)(rpcRequest({ runId: "ignored" }))).rejects.toThrow(
      "does not accept",
    );
    await expect(makeAwakenCancelHandler(deps)(rpcRequest({ force: true }))).rejects.toThrow(
      "does not accept",
    );
    expect(surreal.queries).toHaveLength(0);
  });
});

describe("awaken resume handler", () => {
  function seedPausedRow(
    surreal: FakeSurrealConnection,
    paths: ReadonlyArray<string>,
    cursor: string,
  ): RecordId<"awaken_run"> {
    const id = awakenRunId(902);
    const row: AwakenRowState = {
      id,
      status: "paused",
      started_at: new DateTime(new Date()),
      total: paths.length,
      processed: paths.indexOf(cursor) + 1,
      failed: 0,
      attempted: paths.indexOf(cursor) + 1,
      tier_filter: [1, 2, 3],
      priority_globs: [],
      paths: [...paths],
      cursor,
      failures: [],
    };
    surreal.awakenRows.set(id.id.toString(), row);
    return id;
  }

  async function waitForRowStatus(
    surreal: FakeSurrealConnection,
    runId: RecordId<"awaken_run">,
    target: string,
    timeoutMs = 1_000,
  ): Promise<AwakenRowState> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const row = surreal.awakenRows.get(runId.id.toString());
      if (row !== undefined && row.status === target) return row;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const row = surreal.awakenRows.get(runId.id.toString());
    if (row === undefined) {
      throw new Error("awaken resume test: row vanished before reaching target status");
    }
    throw new Error(
      `awaken resume test: row reached status='${row.status}' instead of '${target}'`,
    );
  }

  test("rejects when no resumable row exists", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal(bus);
    const vault = makeVault([{ path: "a.md", mtime: 1 }]);
    const handler = makeAwakenResumeHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      awakenBackgroundRegistry: new AwakenBackgroundRegistry(),
      surreal,
      isExcluded: INCLUDE_ALL,
      approvalIntents: NO_APPROVAL_INTENTS,
    });
    let caught: unknown;
    try {
      await handler(rpcRequest());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("no resumable awaken run found");
  });

  test("rejects every resume parameter before reading run state", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal();
    const handler = makeAwakenResumeHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: makeVault([]) as VaultAdapter,
      awakenBackgroundRegistry: new AwakenBackgroundRegistry(),
      surreal,
      isExcluded: INCLUDE_ALL,
      approvalIntents: NO_APPROVAL_INTENTS,
    });
    await expect(handler(rpcRequest({ background: true }))).rejects.toThrow("does not accept");
    expect(surreal.queries).toHaveLength(0);
  });

  test("flips paused row to running, kicks worker, and drives it to completed", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal(bus);
    const paths = ["a.md", "b.md", "c.md", "d.md", "e.md"];
    const runId = seedPausedRow(surreal, paths, "b.md");
    const vault: Pick<VaultAdapter, "listMarkdown" | "read"> = {
      listMarkdown: async () => {
        throw new Error("resume must not replace the persisted path plan");
      },
      read: async (path: string) => `# ${path}\n`,
    };

    const handler = makeAwakenResumeHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      awakenBackgroundRegistry: new AwakenBackgroundRegistry(),
      surreal,
      isExcluded: INCLUDE_ALL,
      approvalIntents: NO_APPROVAL_INTENTS,
    });

    const result = await handler(rpcRequest());
    expect(result.ok).toBe(true);
    expect(result.status).toBe("running");
    expect(result.runId).toBe(runId.toString());
    expect(result.processed).toBe(2);
    expect(result.total).toBe(paths.length);

    const finalRow = await waitForRowStatus(surreal, runId, "completed");
    expect(finalRow.processed).toBe(paths.length);
    expect(finalRow.failed).toBe(0);
    expect(finalRow.failures).toEqual([]);
    // Only the paths after the cursor were enqueued during resume.
    expect(queue.enqueued).toEqual(["c.md", "d.md", "e.md"]);
  });

  test("rejects resume while a background worker is still draining", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal();
    const registry = new AwakenBackgroundRegistry();
    registry.start(() => new Promise(() => {}));
    const paths = ["a.md", "b.md"];
    const vault = makeVault(paths.map((entry, index) => ({ path: entry, mtime: index })));
    const runId = seedPausedRow(surreal, paths, "a.md");
    const handler = makeAwakenResumeHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      awakenBackgroundRegistry: registry,
      surreal,
      isExcluded: INCLUDE_ALL,
      approvalIntents: NO_APPROVAL_INTENTS,
    });

    let caught: unknown;
    try {
      await handler(rpcRequest());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("background awaken worker is still draining");
    expect(surreal.awakenRows.get(runId.id.toString())?.status).toBe("paused");
    expect(queue.enqueued).toEqual([]);
  });
});

describe("reindex handler", () => {
  test("enqueues paths matching the glob", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal();
    const vault = makeVault([
      { path: "notes/a.md", mtime: 1 },
      { path: "notes/b.md", mtime: 2 },
      { path: "drafts/c.md", mtime: 3 },
    ]);
    const handler = makeReindexHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      awakenBackgroundRegistry: new AwakenBackgroundRegistry(),
      surreal,
      isExcluded: INCLUDE_ALL,
      approvalIntents: NO_APPROVAL_INTENTS,
    });
    await handler(rpcRequest({ pattern: "notes/*.md" }));
    expect(queue.enqueued.sort()).toEqual(["notes/a.md", "notes/b.md"]);
  });

  test("clears only the requested tier_at column when --tier 2 is supplied", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal();
    const vault = makeVaultWithoutRead([
      { path: "notes/a.md", mtime: 1 },
      { path: "notes/b.md", mtime: 2 },
    ]);
    const handler = makeReindexHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      awakenBackgroundRegistry: new AwakenBackgroundRegistry(),
      surreal,
      isExcluded: INCLUDE_ALL,
      approvalIntents: NO_APPROVAL_INTENTS,
    });
    await handler(rpcRequest({ pattern: "notes/*.md", tier: [2] }));

    const clearQueries = surreal.queries.filter((entry) =>
      entry.sql.startsWith("UPDATE note SET tier"),
    );
    expect(clearQueries).toHaveLength(2);
    for (const recorded of clearQueries) {
      expect(recorded.sql).toContain("tier2_at = NONE");
      expect(recorded.sql).not.toContain("tier1_at = NONE");
      expect(recorded.sql).not.toContain("tier3_at = NONE");
    }
    const paths = clearQueries.map((recorded) => recorded.bindings?.path).sort();
    expect(paths).toEqual(["notes/a.md", "notes/b.md"]);

    for (const record of queue.records) {
      expect(record.tierFilter).toEqual([2]);
    }
  });

  test("clears multiple tier_at columns when --tier 2,3 is supplied", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal();
    const vault = makeVaultWithoutRead([{ path: "notes/a.md", mtime: 1 }]);
    const handler = makeReindexHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      awakenBackgroundRegistry: new AwakenBackgroundRegistry(),
      surreal,
      isExcluded: INCLUDE_ALL,
      approvalIntents: NO_APPROVAL_INTENTS,
    });
    await handler(rpcRequest({ pattern: "notes/*.md", tier: [2, 3] }));

    const clearQueries = surreal.queries.filter((entry) =>
      entry.sql.startsWith("UPDATE note SET tier"),
    );
    expect(clearQueries).toHaveLength(1);
    const recorded = clearQueries[0];
    expect(recorded?.sql).toContain("tier2_at = NONE");
    expect(recorded?.sql).toContain("tier3_at = NONE");
    expect(recorded?.sql).not.toContain("tier1_at = NONE");
  });

  test("reindex rejects an invalid tier array before clearing or enqueueing", async () => {
    const bus = new EventBus();
    const queue = makeQueue(bus);
    const surreal = makeFakeSurreal();
    const vault = makeVaultWithoutRead([{ path: "notes/a.md", mtime: 1 }]);
    const handler = makeReindexHandler({
      bus,
      indexer: queue as unknown as IndexerQueue,
      vault: vault as VaultAdapter,
      awakenBackgroundRegistry: new AwakenBackgroundRegistry(),
      surreal,
      isExcluded: INCLUDE_ALL,
      approvalIntents: NO_APPROVAL_INTENTS,
    });
    await expect(handler(rpcRequest({ pattern: "notes/*.md", tier: ["abc"] }))).rejects.toThrow(
      /invalid tier filter/,
    );
    expect(surreal.queries.some((entry) => entry.sql.startsWith("UPDATE note SET tier"))).toBe(
      false,
    );
    expect(queue.records).toEqual([]);
  });
});
