import { describe, expect, test } from "bun:test";
import { DateTime, RecordId, type Surreal } from "surrealdb";
import { wrapNativeValue } from "../../../../src/core/db/nativeValue";
import { createUuidRecordId } from "../../../../src/core/db/recordId";
import { HistoryService } from "../../../../src/core/history/historyService";

function dbReturning(result: unknown): Surreal {
  return {
    query: () => ({ collect: async () => result }),
  } as unknown as Surreal;
}

function capturingDb(result: unknown): {
  db: Surreal;
  calls: Array<{ sql: string; bindings: Record<string, unknown> | undefined }>;
} {
  const calls: Array<{
    sql: string;
    bindings: Record<string, unknown> | undefined;
  }> = [];
  return {
    db: {
      query: (sql: string, bindings?: Record<string, unknown>) => {
        calls.push({ sql, bindings });
        return { collect: async () => result };
      },
    } as unknown as Surreal,
    calls,
  };
}

function makeService(result: unknown): HistoryService {
  return new HistoryService({
    db: dbReturning(result),
    inverters: {},
    retention: { max: 100, maxPerTarget: 20 },
  });
}

function persistedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: createUuidRecordId("history", "0198f4f0-1234-7000-8000-000000000003"),
    kind: "notes.create",
    target: "0-inbox/probe.md",
    before: undefined,
    after: wrapNativeValue("# Probe\n"),
    created_at: new DateTime(new Date(1_800_000_000_000)),
    client_identity: "human",
    ...overrides,
  };
}

describe("HistoryService storage integrity", () => {
  test.each([undefined, null, 0, -1, 1.5, Number.POSITIVE_INFINITY, 2 ** 53])(
    "rejects non-canonical retention max %p",
    (max) => {
      expect(
        () =>
          new HistoryService({
            db: dbReturning([[]]),
            inverters: {},
            retention: { max: max as number, maxPerTarget: 20 },
          }),
      ).toThrow("history retention max must be a positive safe integer");
    },
  );

  test("decodes a canonical native history row", async () => {
    const service = makeService([[persistedRow()]]);
    await expect(service.getRecent(1)).resolves.toEqual([
      {
        id: 'history:u"0198f4f0-1234-7000-8000-000000000003"',
        kind: "notes.create",
        target: "0-inbox/probe.md",
        before: null,
        after: "# Probe\n",
        createdAt: 1_800_000_000_000,
        clientIdentity: "human",
        proposalEdge: null,
        proposalCreatedAt: null,
        undo: null,
      },
    ]);
  });

  test("preserves a proposal revision datetime without losing nanoseconds", async () => {
    const service = makeService([
      [
        persistedRow({
          proposal_edge: new RecordId("related_to", "abcdefghijklmnopqrst"),
          proposal_created_at: new DateTime("2026-08-30T17:25:24.236542578Z"),
        }),
      ],
    ]);

    const rows = await service.getRecent(1);
    expect(rows[0]?.proposalEdge).toBe("related_to:abcdefghijklmnopqrst");
    expect(rows[0]?.proposalCreatedAt).toBe("2026-08-30T17:25:24.236542578Z");
  });

  test("filters recent history by an exact client identity when requested", async () => {
    const capture = capturingDb([[persistedRow({ client_identity: "claude-code" })]]);
    const service = new HistoryService({
      db: capture.db,
      inverters: {},
      retention: { max: 100, maxPerTarget: 20 },
    });

    await expect(service.getRecent(7, "claude-code")).resolves.toHaveLength(1);
    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0]?.sql).toContain("WHERE client_identity = $clientIdentity");
    expect(capture.calls[0]?.bindings).toEqual({
      limit: 7,
      clientIdentity: "claude-code",
    });
  });

  test("rejects a malformed recent-history client identity before querying", async () => {
    const capture = capturingDb([[]]);
    const service = new HistoryService({
      db: capture.db,
      inverters: {},
      retention: { max: 100, maxPerTarget: 20 },
    });
    await expect(service.getRecent(1, " claude-code")).rejects.toThrow(
      "history client identity must be a non-blank string",
    );
    expect(capture.calls).toHaveLength(0);
  });

  test.each([
    ["kind", { kind: "notes.improvise" }, "kind is not supported"],
    ["datetime", { created_at: "2027-01-15T08:00:00Z" }, "native SurrealDB datetime"],
    ["identity", { client_identity: null }, "client identity must be a non-blank string"],
    ["target", { target: "  " }, "target must be a non-blank string"],
    ["NONE", { before: null }, "null is not the canonical NONE representation"],
  ] as const)("rejects malformed persisted %s", async (_label, overrides, message) => {
    const service = makeService([[persistedRow(overrides)]]);
    await expect(service.getRecent(1)).rejects.toThrow(message);
  });

  test("rejects malformed query envelopes", async () => {
    const service = makeService([]);
    await expect(service.getRecent(1)).rejects.toThrow("invalid statement envelope");
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "rejects non-canonical recent limit %p",
    async (limit) => {
      const service = makeService([[]]);
      await expect(service.getRecent(limit)).rejects.toThrow(
        "history recent limit must be a positive safe integer",
      );
    },
  );

  test("rejects undefined snapshots before writing", async () => {
    const service = makeService([[]]);
    await expect(
      service.record({
        kind: "notes.create",
        target: "0-inbox/probe.md",
        before: undefined,
        after: "body",
      }),
    ).rejects.toThrow("snapshots must use null, not undefined");
  });
});
