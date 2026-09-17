import { describe, expect, test } from "bun:test";
import { DateTime, RecordId, type Surreal } from "surrealdb";
import { ApprovalService } from "../../../../src/core/approvals/approvalService";
import {
  proposalAcceptanceHistoryId,
  proposalApprovalIntentId,
  proposalRejectionHistoryId,
} from "../../../../src/core/approvals/proposalIdentity";
import type { WritebackEdgeTable } from "../../../../src/core/db/edgeTables";
import { wrapNativeValue } from "../../../../src/core/db/nativeValue";
import { createUuidRecordId } from "../../../../src/core/db/recordId";
import { EventBus } from "../../../../src/core/events/eventBus";

const EDGE_KEY = "abcdefghijklmnopqrst";
const EDGE_ID = new RecordId("supports", EDGE_KEY);
const OTHER_EDGE_ID = new RecordId("supports", "bcdefghijklmnopqrstu");
const SOURCE_ID = new RecordId("note", "alpha");
const TARGET_ID = new RecordId("note", "beta");
const CREATED_AT = new DateTime(new Date("2026-08-29T12:00:00.000Z"));
const FINISHED_AT = new DateTime(new Date("2026-08-29T12:00:01.000Z"));
const BEFORE_BODY = "# Alpha\n";
const AFTER_BODY = "---\nnotient:\n  supports:\n    - '[[beta]]'\n---\n# Alpha\n";

type QueryResponder = (
  sql: string,
  bindings: Record<string, unknown> | undefined,
) => unknown | Promise<unknown>;

interface ServiceOptions {
  bus?: EventBus;
  read?: (path: string) => Promise<string>;
  writeIfUnchanged?: (path: string, expected: string, content: string) => Promise<boolean>;
  hash?: (content: string) => Promise<string>;
  pruneHistory?: () => Promise<void>;
}

async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function mockDb(respond: QueryResponder): Surreal {
  return {
    query: (sql: string, bindings?: Record<string, unknown>) => ({
      collect: async () =>
        sql.includes("FROM proposal_review WHERE edge_ids CONTAINS")
          ? [[]]
          : await respond(sql, bindings),
    }),
  } as unknown as Surreal;
}

function makeService(db: Surreal, options: ServiceOptions = {}): ApprovalService {
  return new ApprovalService({
    db,
    bus: options.bus ?? new EventBus(),
    vault: {
      read: options.read ?? (async () => BEFORE_BODY),
      writeIfUnchanged: options.writeIfUnchanged ?? (async () => true),
    },
    hash: options.hash ?? sha256Hex,
    pruneHistory: options.pruneHistory ?? (async () => {}),
  });
}

function selectedEdge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EDGE_ID,
    in: SOURCE_ID,
    out: TARGET_ID,
    source: "linker",
    class: "INFERRED",
    agent: "linker",
    confidence: 0.8,
    evidence: undefined,
    approved: false,
    applied: true,
    created_at: CREATED_AT,
    ...overrides,
  };
}

function applyingEdge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return selectedEdge({
    approved: true,
    applied: false,
    approved_by: "human",
    ...overrides,
  });
}

function appliedEdge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return selectedEdge({
    approved: true,
    applied: true,
    approved_by: "human",
    ...overrides,
  });
}

function tableFromQuery(sql: string): WritebackEdgeTable | null {
  for (const table of [
    "supports",
    "contradicts",
    "extends",
    "exemplifies",
    "synthesizes",
    "related_to",
  ] as const) {
    if (sql.includes(`FROM ${table}`)) return table;
  }
  return null;
}

function pendingPreparationDb(sourcePath = "alpha.md", targetPath = "beta.md"): Surreal {
  return mockDb((sql, bindings) => {
    if (sql.includes("FROM history") || sql.includes("FROM approval_intent")) return [[]];
    if (sql.includes("FROM supports")) return [[selectedEdge()]];
    if (sql.startsWith("SELECT id, path FROM note")) {
      const path = bindings?.id === SOURCE_ID ? sourcePath : targetPath;
      return [[{ id: bindings?.id, path }]];
    }
    throw new Error(`unexpected query: ${sql}`);
  });
}

async function approvalIntent(
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return {
    id: await proposalApprovalIntentId(EDGE_ID),
    edge: EDGE_ID,
    table_name: "supports",
    edge_created_at: CREATED_AT,
    source_note: SOURCE_ID,
    target_note: TARGET_ID,
    source_path: "alpha.md",
    target_path: "beta.md",
    kind: "note.frontmatter",
    before_body: BEFORE_BODY,
    after_body: AFTER_BODY,
    before_sha: await sha256Hex(BEFORE_BODY),
    after_sha: await sha256Hex(AFTER_BODY),
    history_id: await proposalAcceptanceHistoryId(EDGE_ID),
    approved_by: "human",
    producer: "linker",
    tool_approval: undefined,
    prepared_at: CREATED_AT,
    write_started_at: undefined,
    cancel_requested_at: undefined,
    ...overrides,
  };
}

async function acceptanceAudit(
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return {
    id: await proposalAcceptanceHistoryId(EDGE_ID),
    kind: "note.frontmatter",
    target: "alpha.md",
    before: wrapNativeValue(BEFORE_BODY),
    after: wrapNativeValue(AFTER_BODY),
    client_identity: "human",
    proposal_edge: EDGE_ID,
    proposal_created_at: CREATED_AT,
    created_at: FINISHED_AT,
    ...overrides,
  };
}

async function rejectionAudit(
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return {
    id: await proposalRejectionHistoryId(EDGE_ID),
    kind: "proposal.reject",
    target: EDGE_ID.toString(),
    before: wrapNativeValue({
      id: EDGE_ID,
      table: "supports",
      in: SOURCE_ID,
      out: TARGET_ID,
      source: "linker",
      class: "INFERRED",
      agent: "linker",
      confidence: 0.8,
      evidence: [],
      approved: false,
      applied: true,
      created_at: CREATED_AT,
    }),
    after: wrapNativeValue({ decision: "rejected", reason: "duplicate" }),
    client_identity: "human",
    created_at: FINISHED_AT,
    ...overrides,
  };
}

function withoutField(value: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[field];
  return copy;
}

describe("ApprovalService", () => {
  test("module exports the service constructor", () => {
    expect(typeof ApprovalService).toBe("function");
  });

  test("listPendingEdges decodes native proposal rows and globally orders them", async () => {
    const later = new DateTime(new Date("2026-08-29T13:00:00.000Z"));
    const db = mockDb((sql) => {
      const table = tableFromQuery(sql);
      if (table === "supports") return [[selectedEdge()]];
      if (table === "contradicts") {
        return [
          [
            selectedEdge({
              id: new RecordId("contradicts", "bcdefghijklmnopqrstu"),
              created_at: later,
            }),
          ],
        ];
      }
      return [[]];
    });

    const listed = await makeService(db).listPendingEdges();

    expect(listed.map((edge) => edge.table)).toEqual(["contradicts", "supports"]);
    expect(listed[0]).toMatchObject({
      agent: "linker",
      confidence: 0.8,
      source: SOURCE_ID,
      target: TARGET_ID,
    });
  });

  test("listPendingEdges rejects malformed envelopes and persisted proposal fields", async () => {
    const corruptions: unknown[] = [
      [],
      [selectedEdge()],
      [[selectedEdge({ legacy: true })]],
      [[selectedEdge({ id: EDGE_ID.toString() })]],
      [[selectedEdge({ in: SOURCE_ID.toString() })]],
      [[selectedEdge({ out: SOURCE_ID })]],
      [[selectedEdge({ source: "user", agent: "user" })]],
      [[selectedEdge({ agent: null })]],
      [[selectedEdge({ class: "AMBIGUOUS" })]],
      [[selectedEdge({ confidence: Number.NaN })]],
      [[selectedEdge({ evidence: null })]],
      [[selectedEdge({ evidence: [] })]],
      [[selectedEdge({ approved: true, applied: false })]],
      [[selectedEdge({ created_at: CREATED_AT.toString() })]],
    ];

    for (const raw of corruptions) {
      const service = makeService(
        mockDb((sql) => (tableFromQuery(sql) === "supports" ? raw : [[]])),
      );
      await expect(service.listPendingEdges()).rejects.toThrow("proposal storage integrity");
    }
  });

  test("approveEdge rejects noncanonical input before touching storage", async () => {
    const untouched = makeService(
      mockDb(() => {
        throw new Error("database must not be reached");
      }),
    );
    const invalidInputs: Array<{ input: unknown; message: string }> = [
      {
        input: {
          id: new RecordId("supports", "not-canonical"),
          table: "supports",
          approvedBy: "human",
        },
        message: "canonical supports relation record id",
      },
      {
        input: { id: EDGE_ID, table: "contradicts", approvedBy: "human" },
        message: "canonical contradicts relation record id",
      },
      {
        input: { id: EDGE_ID, table: "wikilink", approvedBy: "human" },
        message: "table is not writeback-capable",
      },
      {
        input: { id: EDGE_ID, table: "supports", approvedBy: " human" },
        message: "canonical nonblank",
      },
      {
        input: { id: EDGE_ID, table: "supports", approvedBy: "" },
        message: "canonical nonblank",
      },
      {
        input: { id: EDGE_ID, table: "supports", approvedBy: "human", actor: "legacy" },
        message: "unknown field",
      },
    ];

    for (const { input, message } of invalidInputs) {
      await expect(untouched.approveEdge(input as never)).rejects.toThrow(message);
    }
  });

  test("approveEdge returns the deterministic durable receipt without replaying a write", async () => {
    const audit = await acceptanceAudit();
    let reads = 0;
    let writes = 0;
    let prunes = 0;
    const service = makeService(
      mockDb((sql) => {
        if (sql.includes("FROM history")) return [[audit]];
        if (sql.includes("FROM supports")) return [[appliedEdge()]];
        throw new Error(`unexpected query: ${sql}`);
      }),
      {
        read: async () => {
          reads += 1;
          return BEFORE_BODY;
        },
        writeIfUnchanged: async () => {
          writes += 1;
          return true;
        },
        pruneHistory: async () => {
          prunes += 1;
        },
      },
    );

    const result = await service.approveEdge({
      id: EDGE_ID,
      table: "supports",
      approvedBy: "human",
    });

    expect(result).toEqual({
      historyId: (await proposalAcceptanceHistoryId(EDGE_ID)).toString(),
      approvedBy: "human",
    });
    expect({ reads, writes }).toEqual({ reads: 0, writes: 0 });
    expect(prunes).toBe(1);
  });

  test("approveEdge reports retention failure without falsifying a committed receipt", async () => {
    const audit = await acceptanceAudit();
    const bus = new EventBus();
    const failures: Array<{
      type: "indexer:error";
      path: string;
      phase?: string;
      message: string;
    }> = [];
    bus.on("indexer:error", (event) => failures.push(event));
    const service = makeService(
      mockDb((sql) => {
        if (sql.includes("FROM history")) return [[audit]];
        if (sql.includes("FROM supports")) return [[appliedEdge()]];
        throw new Error(`unexpected query: ${sql}`);
      }),
      {
        bus,
        pruneHistory: async () => {
          throw new Error("retention unavailable");
        },
      },
    );

    const result = await service.approveEdge({
      id: EDGE_ID,
      table: "supports",
      approvedBy: "human",
    });

    expect(result).toEqual({
      historyId: (await proposalAcceptanceHistoryId(EDGE_ID)).toString(),
      approvedBy: "human",
    });
    expect(failures).toEqual([
      {
        type: "indexer:error",
        path: (await proposalAcceptanceHistoryId(EDGE_ID)).toString(),
        phase: "history-retention",
        message: "retention unavailable",
      },
    ]);
  });

  test("approveEdge fails closed on malformed acceptance receipt identity", async () => {
    const base = await acceptanceAudit();
    const corruptions: Array<Record<string, unknown>> = [
      { ...base, legacy: true },
      { ...base, id: (await proposalAcceptanceHistoryId(EDGE_ID)).toString() },
      { ...base, kind: "note.append_section" },
      { ...base, target: "../alpha.md" },
      { ...base, before: BEFORE_BODY },
      { ...base, proposal_edge: OTHER_EDGE_ID },
      { ...base, proposal_created_at: CREATED_AT.toString() },
      { ...base, client_identity: " human" },
      { ...base, created_at: FINISHED_AT.toString() },
    ];

    for (const audit of corruptions) {
      const service = makeService(
        mockDb((sql) => {
          if (sql.includes("FROM history")) return [[audit]];
          throw new Error(`unexpected query: ${sql}`);
        }),
      );
      await expect(
        service.approveEdge({ id: EDGE_ID, table: "supports", approvedBy: "human" }),
      ).rejects.toThrow();
    }
  });

  test("approveEdge binds an acceptance receipt to the terminal edge revision and principal", async () => {
    const audit = await acceptanceAudit();
    const corruptTerminalRows = [
      appliedEdge({ approved_by: "other" }),
      appliedEdge({ created_at: FINISHED_AT }),
      applyingEdge(),
      appliedEdge({ id: OTHER_EDGE_ID }),
    ];

    for (const row of corruptTerminalRows) {
      const service = makeService(
        mockDb((sql) => {
          if (sql.includes("FROM history")) return [[audit]];
          if (sql.includes("FROM supports")) return [[row]];
          throw new Error(`unexpected query: ${sql}`);
        }),
      );
      await expect(
        service.approveEdge({ id: EDGE_ID, table: "supports", approvedBy: "human" }),
      ).rejects.toThrow("proposal storage integrity");
    }
  });

  test("approveEdge rejects malformed pending rows before preparing an intent", async () => {
    const corruptions = [
      selectedEdge({ id: OTHER_EDGE_ID }),
      selectedEdge({ approved: true, applied: false }),
      selectedEdge({ evidence: [] }),
      selectedEdge({ created_at: CREATED_AT.toString() }),
    ];

    for (const row of corruptions) {
      const service = makeService(
        mockDb((sql) => {
          if (sql.includes("FROM history") || sql.includes("FROM approval_intent")) return [[]];
          if (sql.includes("FROM supports")) return [[row]];
          throw new Error(`unexpected query: ${sql}`);
        }),
      );
      await expect(
        service.approveEdge({ id: EDGE_ID, table: "supports", approvedBy: "human" }),
      ).rejects.toThrow("proposal storage integrity");
    }
  });

  test("approveEdge rejects noncanonical stored note paths before vault access", async () => {
    const corruptPaths = [
      "../escape.md",
      "/absolute.md",
      "nested\\note.md",
      "note.txt",
      ".md",
      "note.md/",
      " note.md",
      "note\u0000.md",
    ];

    for (const corruptPath of corruptPaths) {
      let reads = 0;
      const service = makeService(pendingPreparationDb(corruptPath), {
        read: async () => {
          reads += 1;
          return BEFORE_BODY;
        },
      });

      await expect(
        service.approveEdge({ id: EDGE_ID, table: "supports", approvedBy: "human" }),
      ).rejects.toThrow("canonical vault-relative");
      expect(reads).toBe(0);
    }
  });

  test("approveEdge validates prepared body hashes before persisting an intent", async () => {
    const service = makeService(pendingPreparationDb(), { hash: async () => "not-a-sha" });

    await expect(
      service.approveEdge({ id: EDGE_ID, table: "supports", approvedBy: "human" }),
    ).rejects.toThrow("lowercase SHA-256");
  });

  test("approval intents require one exact native storage shape", async () => {
    const base = await approvalIntent();
    const corruptions: Array<Record<string, unknown>> = [
      { ...base, legacy: true },
      withoutField(base, "write_started_at"),
      withoutField(base, "cancel_requested_at"),
      { ...base, id: base.id?.toString() },
      { ...base, edge: new RecordId("supports", "not-canonical") },
      { ...base, table_name: "wikilink" },
      { ...base, source_note: TARGET_ID },
      { ...base, edge_created_at: CREATED_AT.toString() },
      { ...base, source_path: "../alpha.md" },
      { ...base, target_path: "beta.txt" },
      { ...base, kind: "proposal.accept" },
      { ...base, before_body: null },
      { ...base, before_sha: "A".repeat(64) },
      { ...base, history_id: base.history_id?.toString() },
      { ...base, approved_by: " human" },
      { ...base, producer: "" },
      { ...base, prepared_at: CREATED_AT.toString() },
      { ...base, write_started_at: null },
      { ...base, cancel_requested_at: null },
    ];

    for (const row of corruptions) {
      const service = makeService(
        mockDb((sql) => {
          if (sql.includes("FROM approval_intent")) return [[row]];
          throw new Error(`unexpected query: ${sql}`);
        }),
      );
      await expect(service.reconcilePendingApplications()).rejects.toThrow();
    }
  });

  test("approveEdge validates a stored intent against its deterministic edge identity and bytes", async () => {
    const base = await approvalIntent();
    const corruptions: Array<Record<string, unknown>> = [
      {
        ...base,
        id: createUuidRecordId("approval_intent", "11111111-1111-5111-8111-111111111111"),
      },
      { ...base, edge: OTHER_EDGE_ID },
      {
        ...base,
        history_id: createUuidRecordId("history", "22222222-2222-5222-8222-222222222222"),
      },
      { ...base, kind: "note.append_section" },
      { ...base, before_sha: "1".repeat(64) },
      { ...base, after_sha: "2".repeat(64) },
    ];

    for (const row of corruptions) {
      const service = makeService(
        mockDb((sql) => {
          if (sql.includes("FROM history")) return [[]];
          if (sql.includes("FROM approval_intent")) return [[row]];
          throw new Error(`unexpected query: ${sql}`);
        }),
      );
      await expect(
        service.approveEdge({ id: EDGE_ID, table: "supports", approvedBy: "human" }),
      ).rejects.toThrow("approval intent");
    }
  });

  test("reconciliation reports a valid intent whose applying edge is missing", async () => {
    const intent = await approvalIntent();
    const bus = new EventBus();
    const failures: Array<{
      type: "indexer:error";
      path: string;
      phase?: string;
      message: string;
    }> = [];
    bus.on("indexer:error", (event) => failures.push(event));
    const service = makeService(
      mockDb((sql) => {
        if (sql.includes("FROM approval_intent")) return [[intent]];
        if (sql.includes("FROM history")) return [[]];
        if (tableFromQuery(sql) !== null) return [[]];
        throw new Error(`unexpected query: ${sql}`);
      }),
      { bus },
    );

    expect(await service.reconcilePendingApplications()).toEqual({
      replayed: 0,
      abandoned: 0,
      failed: 1,
      deferred: 0,
    });
    expect(failures).toEqual([
      {
        type: "indexer:error",
        path: EDGE_ID.toString(),
        phase: "approval-reconciliation",
        message:
          "proposal storage integrity: supports applying approval lookup must return exactly one row",
      },
    ]);
  });

  test("reconciliation detects an applying edge with no durable intent or receipt", async () => {
    const bus = new EventBus();
    const failures: Array<{
      type: "indexer:error";
      path: string;
      phase?: string;
      message: string;
    }> = [];
    bus.on("indexer:error", (event) => failures.push(event));
    const service = makeService(
      mockDb((sql) => {
        if (sql.includes("FROM approval_intent") || sql.includes("FROM history")) return [[]];
        if (tableFromQuery(sql) === "supports") return [[applyingEdge()]];
        if (tableFromQuery(sql) !== null) return [[]];
        throw new Error(`unexpected query: ${sql}`);
      }),
      { bus },
    );

    expect(await service.reconcilePendingApplications()).toEqual({
      replayed: 0,
      abandoned: 0,
      failed: 1,
      deferred: 0,
    });
    expect(failures).toEqual([
      {
        type: "indexer:error",
        path: EDGE_ID.toString(),
        phase: "approval-reconciliation",
        message: "approval storage integrity: applying edge has no durable write intent",
      },
    ]);
  });

  test("reconciliation rejects malformed applying rows instead of downgrading corruption", async () => {
    const bus = new EventBus();
    const failures: string[] = [];
    bus.on("indexer:error", (event) => failures.push(event.message));
    const service = makeService(
      mockDb((sql) => {
        if (sql.includes("FROM approval_intent")) return [[]];
        if (tableFromQuery(sql) === "supports") return [[applyingEdge({ agent: null })]];
        if (tableFromQuery(sql) !== null) return [[]];
        throw new Error(`unexpected query: ${sql}`);
      }),
      { bus },
    );

    await expect(service.reconcilePendingApplications()).rejects.toThrow(
      "proposal storage integrity",
    );
    expect(failures).toEqual([]);
  });

  test("rejectEdge rejects aliases and noncanonical decision metadata before storage", async () => {
    const untouched = makeService(
      mockDb(() => {
        throw new Error("database must not be reached");
      }),
    );
    const invalidInputs = [
      { id: EDGE_ID, table: "supports", rejectedBy: " human" },
      { id: EDGE_ID, table: "supports", rejectedBy: "human", reason: " padded " },
      { id: EDGE_ID, table: "supports", rejectedBy: "human", actor: "legacy" },
    ];

    for (const input of invalidInputs) {
      await expect(untouched.rejectEdge(input as never)).rejects.toThrow();
    }
  });

  test("rejectEdge replays the deterministic durable rejection receipt", async () => {
    const audit = await rejectionAudit();
    let prunes = 0;
    const service = makeService(
      mockDb((sql) => {
        if (sql.includes("FROM history")) return [[audit]];
        throw new Error(`unexpected query: ${sql}`);
      }),
      {
        pruneHistory: async () => {
          prunes += 1;
        },
      },
    );

    expect(
      await service.rejectEdge({
        id: EDGE_ID,
        table: "supports",
        rejectedBy: "retrying-client",
        reason: "a different retry reason",
      }),
    ).toEqual({
      historyId: (await proposalRejectionHistoryId(EDGE_ID)).toString(),
      reason: "duplicate",
    });
    expect(prunes).toBe(1);
  });

  test("rejectEdge fails closed on malformed durable audit storage", async () => {
    const base = await rejectionAudit();
    const corruptions = [
      { ...base, legacy: true },
      { ...base, target: OTHER_EDGE_ID.toString() },
      { ...base, client_identity: " human" },
      { ...base, created_at: FINISHED_AT.toString() },
      { ...base, before: wrapNativeValue({ malformed: true }) },
      { ...base, after: wrapNativeValue({ decision: "rejected", reason: " padded " }) },
    ];

    for (const row of corruptions) {
      const service = makeService(
        mockDb((sql) => {
          if (sql.includes("FROM history")) return [[row]];
          throw new Error(`unexpected query: ${sql}`);
        }),
      );
      await expect(
        service.rejectEdge({ id: EDGE_ID, table: "supports", rejectedBy: "human" }),
      ).rejects.toThrow();
    }
  });
});
