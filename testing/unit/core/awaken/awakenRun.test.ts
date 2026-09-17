import { describe, expect, test } from "bun:test";
import { DateTime, type LiveMessage, type Surreal, Uuid } from "surrealdb";
import {
  createRun,
  findLatestRun,
  subscribeToStatus,
  updateStatus,
} from "../../../../src/core/awaken/awakenRun";
import { createUuidRecordId } from "../../../../src/core/db/recordId";

const FRESH_ID = createUuidRecordId("awaken_run", "018f05cd-3f7b-7000-8000-000000000001");
const OTHER_ID = createUuidRecordId("awaken_run", "018f05cd-3f7b-7000-8000-000000000002");
const STARTED_AT = new DateTime("2026-06-08T14:13:20.000Z");
const FINISHED_AT = new DateTime("2026-06-08T16:13:20.000Z");
const LIVE_QUERY_ID = new Uuid("018f05cd-3f7b-7000-8000-000000000099");

function runningRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: FRESH_ID,
    status: "running",
    started_at: STARTED_AT,
    total: 2,
    processed: 1,
    failed: 0,
    attempted: 1,
    tier_filter: [1, 2, 3],
    priority_globs: ["daily/**"],
    paths: ["daily/a.md", "notes/b.md"],
    cursor: "daily/a.md",
    failures: [],
    ...overrides,
  };
}

function completedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return runningRow({
    status: "completed",
    finished_at: FINISHED_AT,
    processed: 2,
    attempted: 2,
    cursor: undefined,
    ...overrides,
  });
}

function queryDb(envelope: unknown): Surreal {
  return {
    query: () => ({ collect: async () => envelope }),
  } as unknown as Surreal;
}

describe("createRun", () => {
  test("uses the scalar concrete-record create result and derives total from a copied plan", async () => {
    const inputs: Record<string, unknown>[] = [];
    const db = {
      create: (target: unknown) => ({
        content: async (input: Record<string, unknown>) => {
          inputs.push(input);
          return runningRow({
            id: target,
            total: input.total,
            processed: 0,
            attempted: 0,
            tier_filter: input.tier_filter,
            priority_globs: input.priority_globs,
            paths: input.paths,
            cursor: undefined,
          });
        },
      }),
    } as unknown as Surreal;
    const paths = ["daily/a.md", "notes/b.md"];

    const id = await createRun(db, {
      tierFilter: [2, 3],
      priorityGlobs: ["daily/**"],
      paths,
    });
    paths.push("mutated.md");

    expect(id.toString()).toStartWith('awaken_run:u"');
    expect(inputs[0]).toMatchObject({
      total: 2,
      attempted: 0,
      tier_filter: [2, 3],
      paths: ["daily/a.md", "notes/b.md"],
    });
  });

  test("rejects the table-targeted array response instead of preserving a scalar/array alias", async () => {
    const db = {
      create: () => ({ content: async () => [runningRow({ processed: 0, attempted: 0 })] }),
    } as unknown as Surreal;

    await expect(
      createRun(db, { tierFilter: [1], priorityGlobs: [], paths: ["a.md", "b.md"] }),
    ).rejects.toThrow("non-record result");
  });

  test.each([
    [{ tierFilter: [], priorityGlobs: [], paths: [] }, "tierFilter"],
    [{ tierFilter: [2, 1], priorityGlobs: [], paths: [] }, "ordered canonically"],
    [{ tierFilter: [1, 1], priorityGlobs: [], paths: [] }, "ordered canonically"],
    [{ tierFilter: [4], priorityGlobs: [], paths: [] }, "only tiers"],
    [{ tierFilter: [1], priorityGlobs: ["  "], paths: [] }, "nonblank"],
    [{ tierFilter: [1], priorityGlobs: ["daily/**", "daily/**"], paths: [] }, "duplicates"],
    [{ tierFilter: [1], priorityGlobs: [], paths: [""] }, "nonblank"],
    [{ tierFilter: [1], priorityGlobs: [], paths: ["same.md", "same.md"] }, "duplicates"],
  ])("rejects malformed create input %# before touching storage", async (input, message) => {
    const db = {
      create: () => {
        throw new Error("database must not be reached");
      },
    } as unknown as Surreal;

    await expect(createRun(db, input)).rejects.toThrow(message);
  });
});

describe("stored row decoding", () => {
  test("returns one strict native row and converts DateTime values to valid Dates", async () => {
    const row = await findLatestRun(queryDb([[completedRow()]]));

    expect(row?.id.toString()).toBe(FRESH_ID.toString());
    expect(row?.status).toBe("completed");
    expect(row?.started_at).toBeInstanceOf(Date);
    expect(row?.started_at.toISOString()).toBe("2026-06-08T14:13:20.000Z");
    expect(row?.finished_at?.toISOString()).toBe("2026-06-08T16:13:20.000Z");
    expect(row?.cursor).toBeNull();
    expect(row?.error).toBeNull();
  });

  test.each([
    [[], "invalid statement envelope"],
    [[[]], null],
    [[[], []], "invalid statement envelope"],
    [[[completedRow(), completedRow({ id: OTHER_ID })]], "more than one LIMIT row"],
  ])("enforces the exact one-statement, zero-or-one row envelope %#", async (envelope, message) => {
    if (message === null) {
      expect(await findLatestRun(queryDb(envelope))).toBeNull();
      return;
    }
    await expect(findLatestRun(queryDb(envelope))).rejects.toThrow(message);
  });

  test.each([
    [runningRow({ status: "unknown" }), "supported status"],
    [runningRow({ started_at: new Date("2026-06-08T14:13:20Z") }), "native SurrealDB datetime"],
    [runningRow({ finished_at: null }), "uses null instead of SurrealDB NONE"],
    [runningRow({ cursor: null }), "uses null instead of SurrealDB NONE"],
    [runningRow({ error: null }), "uses null instead of SurrealDB NONE"],
    [runningRow({ total: Number.MAX_SAFE_INTEGER + 1 }), "safe integer"],
    [runningRow({ processed: -1 }), "safe integer"],
    [runningRow({ processed: 2, attempted: 1 }), "processed cannot exceed attempted"],
    [runningRow({ failed: 2, attempted: 1 }), "failed cannot exceed attempted"],
    [runningRow({ attempted: 3 }), "attempted cannot exceed total"],
    [runningRow({ processed: 0 }), "processed plus failed must equal attempted"],
    [runningRow({ tier_filter: [3, 2] }), "ordered canonically"],
    [runningRow({ tier_filter: [1, 4] }), "only tiers"],
    [runningRow({ paths: ["daily/a.md", "daily/a.md"] }), "duplicates"],
    [runningRow({ paths: ["daily/a.md"] }), "path-plan length"],
    [runningRow({ cursor: "absent.md" }), "cursor must belong"],
    [runningRow({ failures: ["absent.md"], failed: 1, processed: 0 }), "failure path"],
    [runningRow({ failures: ["daily/a.md"], failed: 0 }), "cannot outnumber"],
    [runningRow({ finished_at: FINISHED_AT }), "active runs must not"],
    [completedRow({ finished_at: undefined }), "terminal runs must have"],
    [completedRow({ finished_at: new DateTime("2026-06-08T12:00:00Z") }), "cannot precede"],
    [completedRow({ attempted: 1, processed: 1 }), "attempted every path"],
    [completedRow({ cursor: "notes/b.md" }), "must not retain a cursor"],
    [completedRow({ error: "boom" }), "only failed runs"],
    [
      completedRow({
        status: "failed",
        attempted: 1,
        processed: 1,
        finished_at: FINISHED_AT,
      }),
      "exactly one terminal diagnostic",
    ],
    [
      completedRow({
        status: "failed",
        attempted: 1,
        processed: 1,
        finished_at: FINISHED_AT,
        error: "boom",
        failure_reason: "daemon_shutdown",
      }),
      "exactly one terminal diagnostic",
    ],
  ])("rejects corrupt persisted state %#", async (row, message) => {
    await expect(findLatestRun(queryDb([[row]]))).rejects.toThrow(message);
  });
});

describe("updateStatus", () => {
  test("validates the merged state and decodes the exact UPDATE RETURN AFTER row", async () => {
    const current = runningRow();
    const calls: Array<{ sql: string; bindings?: Record<string, unknown> }> = [];
    const db = {
      query: (sql: string, bindings?: Record<string, unknown>) => ({
        collect: async () => {
          calls.push({ sql, bindings });
          if (sql.startsWith("SELECT")) return [[current]];
          return [
            [
              runningRow({
                processed: 1,
                failed: 1,
                attempted: 2,
                cursor: "notes/b.md",
                failures: ["notes/b.md"],
              }),
            ],
          ];
        },
      }),
    } as unknown as Surreal;

    await updateStatus(db, FRESH_ID, "running", {
      processed: 1,
      failed: 1,
      attempted: 2,
      cursor: "notes/b.md",
      failurePaths: ["notes/b.md"],
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.sql).toContain("RETURN AFTER");
    expect(calls[1]?.sql).toContain("WHERE status = $expected_status");
    expect(calls[1]?.bindings).toMatchObject({
      expected_processed: 1,
      processed: 1,
      failed: 1,
      attempted: 2,
      failures: ["notes/b.md"],
    });
  });

  test("clamps a terminal server-clock sample to the immutable start time", async () => {
    const calls: string[] = [];
    const db = {
      query: (sql: string) => ({
        collect: async () => {
          calls.push(sql);
          return sql.startsWith("SELECT") ? [[runningRow()]] : [[completedRow()]];
        },
      }),
    } as unknown as Surreal;

    await updateStatus(db, FRESH_ID, "completed", {
      processed: 2,
      attempted: 2,
      cursor: null,
    });

    expect(calls[1]).toContain(
      "finished_at = IF finished_at = NONE THEN array::max([started_at, time::now()]) ELSE finished_at END",
    );
  });

  test.each([
    [{ processed: Number.MAX_SAFE_INTEGER + 1 }, "safe integer"],
    [{ attempted: -1 }, "safe integer"],
    [{ cursor: " " }, "nonblank"],
    [{ error: "" }, "nonblank"],
    [{ failureReason: "  " }, "nonblank"],
    [{ failurePaths: ["daily/a.md", "daily/a.md"] }, "duplicates"],
    [{ failurePaths: [""] }, "nonblank"],
    [{ unknown: 1 } as never, "unsupported field"],
  ])("rejects malformed update extras %# before reading storage", async (extra, message) => {
    const db = {
      query: () => {
        throw new Error("database must not be reached");
      },
    } as unknown as Surreal;
    await expect(updateStatus(db, FRESH_ID, "running", extra)).rejects.toThrow(message);
  });

  test("rejects cross-field and failure-path corruption before issuing UPDATE", async () => {
    const calls: string[] = [];
    const db = {
      query: (sql: string) => ({
        collect: async () => {
          calls.push(sql);
          return [[runningRow()]];
        },
      }),
    } as unknown as Surreal;

    await expect(
      updateStatus(db, FRESH_ID, "running", {
        processed: 2,
        attempted: 1,
        failurePaths: ["absent.md"],
      }),
    ).rejects.toThrow("processed cannot exceed attempted");
    expect(calls).toHaveLength(1);
  });

  test("requires exactly one diagnostic for failure and clears diagnostics on resume", async () => {
    const runningDb = queryDb([[runningRow()]]);
    await expect(updateStatus(runningDb, FRESH_ID, "failed")).rejects.toThrow(
      "exactly one terminal diagnostic",
    );

    const failed = runningRow({
      status: "failed",
      finished_at: FINISHED_AT,
      error: "embedding failed",
    });
    const calls: Array<{ sql: string; bindings?: Record<string, unknown> }> = [];
    const resumeDb = {
      query: (sql: string, bindings?: Record<string, unknown>) => ({
        collect: async () => {
          calls.push({ sql, bindings });
          return sql.startsWith("SELECT") ? [[failed]] : [[runningRow()]];
        },
      }),
    } as unknown as Surreal;

    await updateStatus(resumeDb, FRESH_ID, "running");
    expect(calls[1]?.sql).toContain("finished_at = NONE");
    expect(calls[1]?.sql).toContain("error = NONE");
    expect(calls[1]?.sql).toContain("failure_reason = NONE");
  });

  test("rejects a zero-row UPDATE result instead of reporting success", async () => {
    let count = 0;
    const db = {
      query: () => ({
        collect: async () => {
          count += 1;
          return count === 1 ? [[runningRow()]] : [[]];
        },
      }),
    } as unknown as Surreal;

    await expect(updateStatus(db, FRESH_ID, "paused")).rejects.toThrow(
      "did not return exactly one row",
    );
  });
});

describe("subscribeToStatus", () => {
  test("surfaces a malformed matching status when the subscription closes", async () => {
    let handler: ((message: LiveMessage) => void) | undefined;
    let killed = false;
    const db = {
      live: async () => ({
        subscribe: (next: (message: LiveMessage) => void) => {
          handler = next;
          return () => {};
        },
        kill: async () => {
          killed = true;
        },
      }),
    } as unknown as Surreal;
    const statuses: string[] = [];
    const subscription = await subscribeToStatus(db, FRESH_ID, (status) => statuses.push(status));

    handler?.({
      queryId: LIVE_QUERY_ID,
      action: "UPDATE",
      recordId: FRESH_ID,
      value: { status: "finished" },
    });

    await expect(subscription.close()).rejects.toThrow("supported status");
    expect(killed).toBe(true);
    expect(statuses).toEqual([]);
  });

  test("ignores another canonical run and forwards a valid matching status", async () => {
    let handler: ((message: LiveMessage) => void) | undefined;
    const db = {
      live: async () => ({
        subscribe: (next: (message: LiveMessage) => void) => {
          handler = next;
          return () => {};
        },
        kill: async () => {},
      }),
    } as unknown as Surreal;
    const statuses: string[] = [];
    const subscription = await subscribeToStatus(db, FRESH_ID, (status) => statuses.push(status));

    handler?.({
      queryId: LIVE_QUERY_ID,
      action: "UPDATE",
      recordId: OTHER_ID,
      value: { status: "paused" },
    });
    handler?.({
      queryId: LIVE_QUERY_ID,
      action: "UPDATE",
      recordId: FRESH_ID,
      value: { status: "paused" },
    });
    await subscription.close();

    expect(statuses).toEqual(["paused"]);
  });
});
