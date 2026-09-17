import { describe, expect, test } from "bun:test";
import { DateTime, type Surreal } from "surrealdb";
import { nativeDateTimeToEpochMillis } from "../../../../src/core/db/dateTime";
import { createUuidRecordId } from "../../../../src/core/db/recordId";
import {
  buildVaultStatsQuery,
  collectVaultStats,
  summarizeAwakenRun,
} from "../../../../src/daemon/handlers/vaultStats";

/** One result slice per statement, mirroring the multi-statement driver. */
type Responder = (sql: string) => unknown[][];

function makeFakeDb(respond: Responder): { db: Surreal; queries: string[] } {
  const queries: string[] = [];
  const db = {
    query: (sql: string) => {
      queries.push(sql);
      return { collect: async () => respond(sql) };
    },
  } as unknown as Surreal;
  return { db, queries };
}

interface EdgeGroup {
  approved: boolean;
  applied: boolean;
  count: number;
}

interface StatsRows {
  counts?: Record<string, unknown>;
  edges?: Record<string, EdgeGroup[]>;
  activeAwaken?: Record<string, unknown>[];
  newestAwaken?: Record<string, unknown>[];
}

function answerStatsStatement(statement: string, options: StatsRows): unknown[] {
  if (statement.startsWith("SELECT id, status")) {
    return statement.includes("WHERE status IN")
      ? (options.activeAwaken ?? [])
      : (options.newestAwaken ?? []);
  }
  const table = /FROM (\w+)/.exec(statement)?.[1] ?? "";
  if (statement.includes("GROUP BY approved, applied")) return options.edges?.[table] ?? [];
  const count = options.counts?.[table];
  return count === undefined ? [] : [{ count }];
}

/**
 * Answers the one multi-statement query by splitting it back into
 * statements and serving each from a table-keyed lookup.
 */
function statsDb(options: StatsRows): { db: Surreal; queries: string[] } {
  return makeFakeDb((sql) =>
    sql
      .split("\n")
      .filter((statement) => statement.trim().length > 0)
      .map((statement) => answerStatsStatement(statement, options)),
  );
}

describe("collectVaultStats", () => {
  test("issues exactly one query for the whole snapshot", async () => {
    const { db, queries } = statsDb({});
    await collectVaultStats({ db, pendingApprovals: () => 0 });
    expect(queries).toHaveLength(1);
  });

  test("counts every entity table and sums the typed edges", async () => {
    const { db } = statsDb({
      counts: {
        note: 12,
        block: 40,
        chunk: 90,
        concept: 7,
        claim: 3,
        question: 2,
        wikilink: 21,
      },
      edges: {
        supports: [
          { approved: true, applied: true, count: 2 },
          { approved: false, applied: false, count: 1 },
        ],
        related_to: [{ approved: true, applied: true, count: 4 }],
      },
    });
    const stats = await collectVaultStats({ db, pendingApprovals: () => 5 });
    expect(stats.notes).toBe(12);
    expect(stats.blocks).toBe(40);
    expect(stats.chunks).toBe(90);
    expect(stats.concepts).toBe(7);
    expect(stats.claims).toBe(3);
    expect(stats.questions).toBe(2);
    expect(stats.wikilinks).toBe(21);
    expect(stats.typedEdgesApproved).toBe(6);
    expect(stats.typedEdgesPending).toBe(1);
    expect(stats.pendingApprovals).toBe(5);
    expect(stats.typedEdges[0]).toEqual({ table: "supports", approved: 2, pending: 1 });
  });

  test("an approved but not yet applied edge counts as pending, not as lost", async () => {
    const { db } = statsDb({
      edges: {
        supports: [
          { approved: true, applied: false, count: 3 },
          { approved: false, applied: false, count: 1 },
        ],
      },
    });
    const stats = await collectVaultStats({ db, pendingApprovals: () => 0 });
    expect(stats.typedEdges[0]).toEqual({ table: "supports", approved: 0, pending: 4 });
    expect(stats.typedEdgesApproved).toBe(0);
    expect(stats.typedEdgesPending).toBe(4);
  });

  test("an empty vault reports zeros rather than throwing", async () => {
    const { db } = statsDb({});
    const stats = await collectVaultStats({ db, pendingApprovals: () => 0 });
    expect(stats.notes).toBe(0);
    expect(stats.typedEdges).toHaveLength(6);
    expect(stats.typedEdgesApproved).toBe(0);
    expect(stats.awaken).toBeNull();
  });

  test("always reports all six linker tables in a fixed order", async () => {
    const { db } = statsDb({});
    const stats = await collectVaultStats({ db, pendingApprovals: () => 0 });
    expect(stats.typedEdges.map((entry) => entry.table)).toEqual([
      "supports",
      "contradicts",
      "extends",
      "exemplifies",
      "synthesizes",
      "related_to",
    ]);
  });

  test("rejects a missing statement slice instead of inventing zeroes", async () => {
    const { db } = makeFakeDb(() => []);
    await expect(collectVaultStats({ db, pendingApprovals: () => 0 })).rejects.toThrow(
      "expected 15 query result slices",
    );
  });

  test("rejects malformed counts instead of inventing zeroes", async () => {
    const { db } = statsDb({ counts: { note: "twelve" } });
    await expect(collectVaultStats({ db, pendingApprovals: () => 0 })).rejects.toThrow(
      "note count is not a nonnegative integer",
    );
  });

  test("the awaken run comes back from the same query", async () => {
    const { db, queries } = statsDb({
      activeAwaken: [
        {
          id: createUuidRecordId("awaken_run", "018f0000-0000-7000-8000-000000000002"),
          status: "running",
          processed: 3,
          total: 9,
          failed: 0,
          started_at: new DateTime(new Date(1_700_000_000_000)),
          finished_at: undefined,
          error: undefined,
        },
      ],
    });
    const stats = await collectVaultStats({ db, pendingApprovals: () => 0 });
    expect(queries).toHaveLength(1);
    expect(stats.awaken?.runId).toBe('awaken_run:u"018f0000-0000-7000-8000-000000000002"');
    expect(stats.awaken?.status).toBe("running");
  });
});

describe("buildVaultStatsQuery", () => {
  test("tombstoned notes are excluded from the note count", () => {
    expect(buildVaultStatsQuery()).toContain("FROM note WHERE tombstoned_at = NONE");
  });

  test("each edge table is grouped once instead of counted twice", () => {
    const sql = buildVaultStatsQuery();
    expect(sql).toContain(
      "SELECT approved, applied, count() AS count FROM supports GROUP BY approved, applied;",
    );
    expect(sql).not.toContain("approved = true AND applied = true");
  });

  test("one statement per count plus six edge tables and two exact awaken reads", () => {
    const statements = buildVaultStatsQuery()
      .split("\n")
      .filter((line) => line.trim().length > 0);
    expect(statements).toHaveLength(7 + 6 + 2);
    expect(statements.at(-2)).toContain("WHERE status IN ['running', 'paused']");
    expect(statements.at(-1)).toContain("ORDER BY started_at DESC LIMIT 1");
  });
});

describe("summarizeAwakenRun", () => {
  const runIds = {
    one: createUuidRecordId("awaken_run", "018f0000-0000-7000-8000-000000000001"),
    live: createUuidRecordId("awaken_run", "018f0000-0000-7000-8000-000000000002"),
    newest: createUuidRecordId("awaken_run", "018f0000-0000-7000-8000-000000000003"),
  };
  const runRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: runIds.one,
    status: "completed",
    processed: 10,
    total: 10,
    failed: 0,
    started_at: new DateTime(new Date(1_700_000_000_000)),
    finished_at: new DateTime(new Date(1_700_000_060_000)),
    error: undefined,
    ...overrides,
  });

  test("returns null when no run has ever been recorded", () => {
    expect(summarizeAwakenRun([], [])).toBeNull();
  });

  test("prefers the directly queried active run over a newer terminal one", () => {
    const summary = summarizeAwakenRun(
      [runRow({ id: runIds.live, status: "paused", processed: 3, finished_at: undefined })],
      [runRow({ id: runIds.newest, status: "completed" })],
    );
    expect(summary?.runId).toBe(runIds.live.toString());
    expect(summary?.status).toBe("paused");
    expect(summary?.finishedAt).toBeNull();
  });

  test("falls back to the newest row once every run has finished", () => {
    const summary = summarizeAwakenRun([], [runRow({ id: runIds.newest })]);
    expect(summary?.runId).toBe(runIds.newest.toString());
    expect(summary?.startedAt).toBe(1_700_000_000_000);
    expect(summary?.finishedAt).toBe(1_700_000_060_000);
  });

  test("rejects impossible counter and identity shapes", () => {
    expect(() =>
      summarizeAwakenRun([], [runRow({ processed: null, total: null, failed: null })]),
    ).toThrow("awaken processed is not a nonnegative integer");
    expect(() => summarizeAwakenRun([], [runRow({ id: "awaken_run:one" })])).toThrow(
      "awaken run id must be a native SurrealDB record id",
    );
  });

  test("rejects compatibility datetime, NONE, and row-field aliases", () => {
    expect(() => summarizeAwakenRun([], [runRow({ started_at: new Date(1) })])).toThrow(
      "awaken started_at is invalid",
    );
    expect(() =>
      summarizeAwakenRun([runRow({ status: "running", finished_at: null })], []),
    ).toThrow("finished_at is not a native SurrealDB datetime or NONE");
    expect(() => summarizeAwakenRun([], [runRow({ legacy: true })])).toThrow(
      "result is not exactly one row",
    );
  });
});

describe("nativeDateTimeToEpochMillis", () => {
  test("accepts only a valid native SurrealDB DateTime", () => {
    expect(nativeDateTimeToEpochMillis(new DateTime(new Date(5)))).toBe(5);
  });

  test("rejects compatibility datetime representations", () => {
    expect(nativeDateTimeToEpochMillis(new Date(5))).toBeNull();
    expect(nativeDateTimeToEpochMillis("1970-01-01T00:00:00.005Z")).toBeNull();
    expect(nativeDateTimeToEpochMillis(5)).toBeNull();
    expect(nativeDateTimeToEpochMillis(null)).toBeNull();
    expect(nativeDateTimeToEpochMillis(undefined)).toBeNull();
  });
});
