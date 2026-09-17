import { describe, expect, test } from "bun:test";
import { DateTime, RecordId, type Surreal } from "surrealdb";
import { VaultPathError } from "../../../../src/adapters/vaultAdapter";
import { proposalRelationRecordId } from "../../../../src/core/approvals/proposalIdentity";
import { writebackEdgeTableFromId } from "../../../../src/core/db/edgeTables";
import { createUuidRecordId } from "../../../../src/core/db/recordId";
import { listProposals, makeProposalsHandlers } from "../../../../src/daemon/handlers/proposals";
import { RpcError } from "../../../../src/daemon/rpc";
import { agentPrincipal, rpcRequest } from "../../../rpcRequest";

type Responder = (sql: string, bindings: Record<string, unknown>) => unknown[];

function makeFakeDb(respond: Responder): { db: Surreal; queries: string[] } {
  const queries: string[] = [];
  const db = {
    query: (sql: string, bindings: Record<string, unknown> = {}) => {
      queries.push(sql);
      return { collect: async () => [respond(sql, bindings)] };
    },
  } as unknown as Surreal;
  return { db, queries };
}

function recordingService(
  approvalResult: { historyId: string; approvedBy: string } | null = {
    historyId: HISTORY_ID,
    approvedBy: "human",
  },
): {
  service: {
    approveEdge: (input: unknown) => Promise<{ historyId: string; approvedBy: string } | null>;
    rejectEdge: (input: unknown) => Promise<{ historyId: string; reason: string | null } | null>;
  };
  approved: unknown[];
  rejected: unknown[];
} {
  const approved: unknown[] = [];
  const rejected: unknown[] = [];
  return {
    approved,
    rejected,
    service: {
      approveEdge: async (input) => {
        approved.push(input);
        return approvalResult;
      },
      rejectEdge: async (input) => {
        rejected.push(input);
        const reason =
          typeof input === "object" &&
          input !== null &&
          typeof Reflect.get(input, "reason") === "string"
            ? (Reflect.get(input, "reason") as string)
            : null;
        return { historyId: HISTORY_ID, reason };
      },
    },
  };
}

const ACCESSIBLE_VAULT = { exists: async () => true };

function proposalHandlers(
  db: Surreal,
  approvalService = recordingService().service,
  vault: { exists: (path: string) => Promise<boolean> } = ACCESSIBLE_VAULT,
) {
  return makeProposalsHandlers({ db, approvalService, vault });
}

function proposalRecordId<TableName extends string>(
  table: TableName,
  value: number,
): RecordId<TableName> {
  return new RecordId(table, `a${value.toString().padStart(19, "0")}`);
}

const SUPPORTS_ID = proposalRecordId("supports", 1).toString();
const RELATED_TO_ID = proposalRecordId("related_to", 2).toString();
const HISTORY_ID = createUuidRecordId("history", "018f05cd-3f7b-7000-8000-000000000003").toString();
const NOTE_A_ID = new RecordId("note", "n0000000000000000001");
const NOTE_B_ID = new RecordId("note", "n0000000000000000002");
const CHUNK_IDS = [
  new RecordId("chunk", "c0000000000000000001"),
  new RecordId("chunk", "c0000000000000000002"),
  new RecordId("chunk", "c0000000000000000003"),
  new RecordId("chunk", "c0000000000000000004"),
  new RecordId("chunk", "c0000000000000000005"),
] as const;

const EDGE_ROW = {
  id: proposalRecordId("supports", 1),
  fromId: NOTE_A_ID,
  toId: NOTE_B_ID,
  fromPath: "a.md",
  toPath: "b.md",
  source: "linker",
  class: "INFERRED",
  agent: "linker",
  confidence: 0.82,
  evidence: undefined,
  approved: false,
  applied: true,
  created_at: new DateTime(new Date(1_700_000_000_000)),
};

function linkRow(
  overrides: Record<string, unknown> = {},
  options: { selected?: boolean } = {},
): Record<string, unknown> {
  const id = proposalRelationRecordId("related_to", NOTE_A_ID, NOTE_B_ID);
  return {
    id,
    in: NOTE_A_ID,
    out: NOTE_B_ID,
    source: "user",
    class: "INFERRED",
    agent: "claude-code",
    confidence: 1,
    ...(options.selected ? { evidence: undefined } : {}),
    approved: false,
    applied: true,
    created_at: new DateTime(new Date(1_700_000_000_000)),
    ...overrides,
  };
}

function stageEnvelope(branch: unknown): unknown[] {
  return [undefined, undefined, undefined, undefined, branch, undefined];
}

function makeProposeDb(transactionResult: unknown): {
  db: Surreal;
  calls: Array<{ sql: string; bindings: Record<string, unknown> }>;
} {
  const calls: Array<{ sql: string; bindings: Record<string, unknown> }> = [];
  const db = {
    query: (sql: string, bindings: Record<string, unknown> = {}) => {
      calls.push({ sql, bindings });
      return {
        collect: async () =>
          sql.startsWith("SELECT id, path FROM note")
            ? [
                [
                  { id: NOTE_A_ID, path: "source.md" },
                  { id: NOTE_B_ID, path: "target.md" },
                ],
              ]
            : transactionResult,
      };
    },
  } as unknown as Surreal;
  return { db, calls };
}

function linkRequest(agent = "claude-code") {
  return rpcRequest(
    { sourcePath: "source.md", targetPath: "target.md", relation: "related_to" },
    { principal: agentPrincipal(agent) },
  );
}

describe("writebackEdgeTableFromId", () => {
  test("accepts the six linker tables", () => {
    expect(writebackEdgeTableFromId("supports:1")).toBe("supports");
    expect(writebackEdgeTableFromId("related_to:xyz")).toBe("related_to");
  });

  test("rejects a non-proposal table and a malformed id", () => {
    expect(writebackEdgeTableFromId("wikilink:1")).toBeNull();
    expect(writebackEdgeTableFromId("nocolon")).toBeNull();
    expect(writebackEdgeTableFromId(":leading")).toBeNull();
  });
});

describe("listProposals", () => {
  test("selects only unapproved rows across the linker tables", async () => {
    const { db, queries } = makeFakeDb(() => []);
    await listProposals({ db, approvalService: recordingService().service }, {});
    expect(queries).toHaveLength(6);
    expect(queries.every((sql) => sql.includes("WHERE approved = false"))).toBe(true);
    expect(queries.every((sql) => sql.includes("in.tombstoned_at IS NONE"))).toBe(true);
    expect(queries.every((sql) => sql.includes("out.tombstoned_at IS NONE"))).toBe(true);
    expect(queries[0]).toContain("FROM supports");
    expect(queries[5]).toContain("FROM related_to");
  });

  test("requires one exact statement envelope from every proposal query", async () => {
    for (const raw of [[], [[], []], {}, [null]]) {
      const db = {
        query: () => ({ collect: async () => raw }),
      } as unknown as Surreal;
      await expect(
        listProposals({ db, approvalService: recordingService().service }, {}),
      ).rejects.toThrow("invalid statement envelope");
    }
  });

  test("projects the edge with both note paths and its confidence", async () => {
    const { db } = makeFakeDb((sql) =>
      sql.includes("FROM supports") ? [EDGE_ROW] : sql.includes("FROM chunk") ? [{ text: "" }] : [],
    );
    const result = await listProposals({ db, approvalService: recordingService().service }, {});
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({
      id: SUPPORTS_ID,
      table: "supports",
      fromNotePath: "a.md",
      toNotePath: "b.md",
      confidence: 0.82,
      source: "linker",
      agent: "linker",
      createdAt: 1_700_000_000_000,
    });
  });

  test("evidence is fetched from chunk text and capped at two snippets", async () => {
    let requestedEvidence = 0;
    const { db } = makeFakeDb((sql, bindings) => {
      if (sql.includes("FROM supports")) return [{ ...EDGE_ROW, evidence: CHUNK_IDS.slice(0, 3) }];
      if (sql.includes("FROM chunk")) {
        const ids = bindings.ids as Array<RecordId<"chunk">>;
        requestedEvidence = ids.length;
        return ids.map((id) => ({ id, text: `text for ${id.toString()}` }));
      }
      return [];
    });
    const result = await listProposals({ db, approvalService: recordingService().service }, {});
    expect(result.proposals[0]?.evidence).toHaveLength(2);
    expect(result.proposals[0]?.evidence[0]?.chunkId).toBe(CHUNK_IDS[0].toString());
    expect(result.proposals[0]?.evidence[0]?.text).toBe(`text for ${CHUNK_IDS[0].toString()}`);
    expect(requestedEvidence).toBe(3);
  });

  test("evidence for every proposal is resolved in a single chunk query", async () => {
    const { db, queries } = makeFakeDb((sql, bindings) => {
      if (sql.includes("FROM supports")) {
        return [
          { ...EDGE_ROW, id: proposalRecordId("supports", 1), evidence: CHUNK_IDS.slice(0, 2) },
          { ...EDGE_ROW, id: proposalRecordId("supports", 2), evidence: CHUNK_IDS.slice(2, 4) },
          { ...EDGE_ROW, id: proposalRecordId("supports", 3), evidence: CHUNK_IDS.slice(4) },
        ];
      }
      if (sql.includes("FROM chunk")) {
        const ids = bindings.ids as Array<RecordId<"chunk">>;
        return ids.map((id) => ({ id, text: `text for ${id.toString()}` }));
      }
      return [];
    });
    const result = await listProposals({ db, approvalService: recordingService().service }, {});
    expect(queries.filter((sql) => sql.includes("FROM chunk"))).toHaveLength(1);
    expect(result.proposals[2]?.evidence[0]?.text).toBe(`text for ${CHUNK_IDS[4].toString()}`);
  });

  test("rejects blank or mismatched evidence rows", async () => {
    const badEvidenceRows = [
      [{ id: CHUNK_IDS[0], text: "   " }],
      [{ id: CHUNK_IDS[1], text: "wrong chunk" }],
      [
        { id: CHUNK_IDS[0], text: "one" },
        { id: CHUNK_IDS[0], text: "duplicate" },
      ],
    ];
    for (const evidenceRows of badEvidenceRows) {
      const { db } = makeFakeDb((sql) => {
        if (sql.includes("FROM supports")) {
          return [{ ...EDGE_ROW, evidence: [CHUNK_IDS[0]] }];
        }
        if (sql.includes("FROM chunk")) return evidenceRows;
        return [];
      });
      await expect(
        listProposals({ db, approvalService: recordingService().service }, {}),
      ).rejects.toThrow("proposal storage integrity");
    }
  });

  test("each edge query carries its own LIMIT so one table cannot starve the rest", async () => {
    const { db, queries } = makeFakeDb(() => []);
    await listProposals({ db, approvalService: recordingService().service }, { limit: 100 });
    expect(queries.filter((sql) => sql.includes("FROM chunk"))).toHaveLength(0);
    expect(queries.every((sql) => /LIMIT \d+;/.test(sql))).toBe(true);
  });

  test("a table with a full page of pending rows does not crowd out the others", async () => {
    const supports = Array.from({ length: 150 }, (_unused, index) => ({
      ...EDGE_ROW,
      id: proposalRecordId("supports", index + 1),
    }));
    const relatedTo = Array.from({ length: 3 }, (_unused, index) => ({
      ...EDGE_ROW,
      id: proposalRecordId("related_to", index + 1),
    }));
    const { db } = makeFakeDb((sql) => {
      if (sql.includes("FROM supports")) return supports;
      if (sql.includes("FROM related_to")) return relatedTo;
      return [];
    });
    const result = await listProposals(
      { db, approvalService: recordingService().service },
      { limit: 100 },
    );
    expect(result.proposals).toHaveLength(100);
    const tables = new Set(result.proposals.map((proposal) => proposal.table));
    expect(tables.has("supports")).toBe(true);
    expect(tables.has("related_to")).toBe(true);
    expect(result.proposals.filter((proposal) => proposal.table === "related_to")).toHaveLength(3);
  });

  test("a referenced chunk that does not resolve fails closed", async () => {
    const { db } = makeFakeDb((sql) =>
      sql.includes("FROM supports") ? [{ ...EDGE_ROW, evidence: [CHUNK_IDS[0]] }] : [],
    );
    await expect(
      listProposals({ db, approvalService: recordingService().service }, {}),
    ).rejects.toThrow("exactly one row for every requested chunk");
  });

  test("a notePath filter binds both edge endpoints", async () => {
    const { db, queries } = makeFakeDb(() => []);
    await listProposals({ db, approvalService: recordingService().service }, { notePath: "a.md" });
    expect(queries[0]).toContain("(in.path = $path OR out.path = $path)");
  });

  test("an agent filter is bound on every edge table", async () => {
    const { db, queries } = makeFakeDb(() => []);
    await listProposals({ db, approvalService: recordingService().service }, { agent: "linker" });
    expect(queries.every((sql) => sql.includes("agent = $agent"))).toBe(true);
  });

  test("the limit caps the total across tables", async () => {
    const { db } = makeFakeDb((sql) =>
      sql.includes("FROM supports")
        ? [
            { ...EDGE_ROW, id: proposalRecordId("supports", 1) },
            { ...EDGE_ROW, id: proposalRecordId("supports", 2) },
            { ...EDGE_ROW, id: proposalRecordId("supports", 3) },
          ]
        : [],
    );
    const result = await listProposals(
      { db, approvalService: recordingService().service },
      { limit: 2 },
    );
    expect(result.proposals).toHaveLength(2);
  });

  test("rejects malformed persisted fields instead of fabricating proposal values", async () => {
    const corruptions: Array<[string, Record<string, unknown>, string]> = [
      ["relation id", { id: SUPPORTS_ID }, "native SurrealDB relation"],
      ["source endpoint", { fromId: "note:a" }, "native note record"],
      ["target path", { toPath: "" }, "non-empty note path"],
      ["source authority", { source: "legacy", agent: "legacy" }, "proposal-producing authority"],
      ["agent attribution", { agent: "synthesizer" }, "exactly match"],
      ["class", { class: "AMBIGUOUS" }, "class must be INFERRED"],
      ["confidence", { confidence: Number.NaN }, "finite number"],
      ["confidence range", { confidence: 1.01 }, "finite number"],
      ["null evidence", { evidence: null }, "evidence must be NONE"],
      ["empty evidence", { evidence: [] }, "evidence must be NONE"],
      ["string evidence", { evidence: [CHUNK_IDS[0].toString()] }, "native chunk record"],
      ["duplicate evidence", { evidence: [CHUNK_IDS[0], CHUNK_IDS[0]] }, "duplicate chunk"],
      ["approved state", { approved: true }, "pending state"],
      ["applied state", { applied: false }, "pending state"],
      ["datetime", { created_at: new Date(1_700_000_000_000) }, "native SurrealDB datetime"],
    ];
    for (const [label, corruption, message] of corruptions) {
      const { db } = makeFakeDb((sql) =>
        sql.includes("FROM supports") ? [{ ...EDGE_ROW, ...corruption }] : [],
      );
      await expect(
        listProposals({ db, approvalService: recordingService().service }, {}),
        label,
      ).rejects.toThrow(message);
    }
  });
});

describe("proposals.propose_link", () => {
  test("stages one exact user-authored pending edge and returns its stable id", async () => {
    const { db, calls } = makeProposeDb(stageEnvelope(linkRow()));
    const handlers = proposalHandlers(db);

    const result = await handlers.proposeLink(linkRequest());
    const expectedId = proposalRelationRecordId("related_to", NOTE_A_ID, NOTE_B_ID).toString();
    expect(result).toEqual({
      ok: true,
      proposalId: expectedId,
      sourcePath: "source.md",
      targetPath: "target.md",
      relation: "related_to",
      pending: true,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      sql: "SELECT id, path FROM note WHERE path INSIDE $paths AND tombstoned_at = NONE;",
      bindings: { paths: ["source.md", "target.md"] },
    });
    expect(calls[1]?.sql).toContain("BEGIN;");
    expect(calls[1]?.sql).toContain("LET $liveEndpoints = (SELECT VALUE id FROM note");
    expect(calls[1]?.sql).toContain("LET $existing = (SELECT");
    expect(calls[1]?.sql).toContain("IF array::len($liveEndpoints) != 2");
    expect(calls[1]?.sql).toContain("IF array::len($existing) = 0");
    expect(calls[1]?.sql).toContain(
      "source: $source, class: 'INFERRED', confidence: $confidence, evidence: $evidence, provenance: $provenance, agent: $agent, approved: false, applied: true",
    );
    expect(calls[1]?.sql).toEndWith("COMMIT;");
    expect(calls[1]?.bindings).toMatchObject({
      edgeId: proposalRelationRecordId("related_to", NOTE_A_ID, NOTE_B_ID),
      from: NOTE_A_ID,
      to: NOTE_B_ID,
      agent: "claude-code",
      source: "user",
      confidence: 1,
    });
  });

  test("same-agent replay and concurrent attempts converge on the same pending proposal", async () => {
    let transactions = 0;
    const calls: string[] = [];
    const db = {
      query: (sql: string) => ({
        collect: async () => {
          calls.push(sql);
          if (sql.startsWith("SELECT id, path FROM note")) {
            return [
              [
                { id: NOTE_A_ID, path: "source.md" },
                { id: NOTE_B_ID, path: "target.md" },
              ],
            ];
          }
          transactions++;
          return transactions === 1
            ? stageEnvelope(linkRow())
            : stageEnvelope([linkRow({}, { selected: true })]);
        },
      }),
    } as unknown as Surreal;
    const handlers = proposalHandlers(db);

    const [first, second] = await Promise.all([
      handlers.proposeLink(linkRequest()),
      handlers.proposeLink(linkRequest()),
    ]);
    expect(first).toEqual(second);
    expect(first.pending).toBe(true);
    expect(transactions).toBe(2);
    expect(calls.filter((sql) => sql.startsWith("SELECT id, path FROM note"))).toHaveLength(2);
  });

  test.each([
    ["another authenticated agent", linkRow({ agent: "cursor" }, { selected: true })],
    [
      "an autonomous linker proposal",
      linkRow({ source: "linker", agent: "linker", confidence: 0.82 }, { selected: true }),
    ],
    ["an already-applied edge", linkRow({ approved: true, applied: true }, { selected: true })],
    [
      "an alternate relation id",
      linkRow({ id: proposalRecordId("related_to", 99) }, { selected: true }),
    ],
  ])("refuses or fails closed on a duplicate owned by %s", async (_label, existing) => {
    const { db } = makeProposeDb(stageEnvelope([existing]));
    const handlers = proposalHandlers(db);
    await expect(handlers.proposeLink(linkRequest())).rejects.toThrow();
  });

  test("fails closed unless the transaction returns the exact six-statement envelope", async () => {
    const malformed = [
      [],
      [undefined, undefined, undefined, undefined, linkRow()],
      [undefined, undefined, undefined, undefined, linkRow(), undefined, undefined],
      [null, undefined, undefined, undefined, linkRow(), undefined],
      [undefined, null, undefined, undefined, linkRow(), undefined],
      [undefined, undefined, null, undefined, linkRow(), undefined],
      [undefined, undefined, undefined, null, linkRow(), undefined],
      [undefined, undefined, undefined, undefined, linkRow(), null],
      stageEnvelope([]),
      [
        undefined,
        undefined,
        undefined,
        undefined,
        [linkRow({}, { selected: true }), linkRow({}, { selected: true })],
        undefined,
      ],
    ];
    for (const raw of malformed) {
      const { db } = makeProposeDb(raw);
      const handlers = proposalHandlers(db);
      await expect(handlers.proposeLink(linkRequest())).rejects.toThrow(
        "proposal storage integrity",
      );
    }
  });

  test("refuses a proposal whose endpoint disappeared before the staging transaction", async () => {
    const { db } = makeProposeDb(stageEnvelope({ unavailable: true }));
    const handlers = proposalHandlers(db);
    const error = await handlers.proposeLink(linkRequest()).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe("INVALID_PARAMS");
    expect((error as Error).message).toContain("endpoint disappeared or was deleted");
  });

  test("rejects same, missing, and noncanonical endpoints before mutation", async () => {
    const invalidParams = [
      { sourcePath: "same.md", targetPath: "same.md", relation: "related_to" },
      { sourcePath: ".notient/private.md", targetPath: "target.md", relation: "related_to" },
      { sourcePath: "../source.md", targetPath: "target.md", relation: "related_to" },
      { sourcePath: "/source.md", targetPath: "target.md", relation: "related_to" },
      { sourcePath: "source.md", targetPath: "target.md", relation: "wikilink" },
      { sourcePath: "source.md", targetPath: "target.md", relation: "related_to", extra: true },
    ];
    for (const params of invalidParams) {
      const { db, calls } = makeProposeDb(stageEnvelope(linkRow()));
      const handlers = proposalHandlers(db);
      await expect(
        handlers.proposeLink(rpcRequest(params, { principal: agentPrincipal() })),
      ).rejects.toThrow();
      expect(calls).toHaveLength(0);
    }

    const calls: string[] = [];
    const db = {
      query: (sql: string) => ({
        collect: async () => {
          calls.push(sql);
          return [[{ id: NOTE_A_ID, path: "source.md" }]];
        },
      }),
    } as unknown as Surreal;
    const handlers = proposalHandlers(db);
    await expect(handlers.proposeLink(linkRequest())).rejects.toThrow("not indexed: target.md");
    expect(calls).toHaveLength(1);
  });

  test("maps missing files and escaping symlink containment failures to INVALID_PARAMS", async () => {
    for (const vault of [
      { exists: async () => false },
      {
        exists: async () => {
          throw new VaultPathError("escape");
        },
      },
    ]) {
      const { db, calls } = makeProposeDb(stageEnvelope(linkRow()));
      const handlers = proposalHandlers(db, recordingService().service, vault);
      const error = await handlers
        .proposeLink(
          rpcRequest(
            {
              sourcePath: "escape/secret.md",
              targetPath: "target.md",
              relation: "related_to",
            },
            { principal: agentPrincipal() },
          ),
        )
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe("INVALID_PARAMS");
      expect(calls).toHaveLength(0);
    }
  });

  test("malformed endpoint query rows fail closed", async () => {
    const malformedRows: unknown[][] = [
      [
        { id: NOTE_A_ID, path: "source.md", extra: true },
        { id: NOTE_B_ID, path: "target.md" },
      ],
      [
        { id: "note:a", path: "source.md" },
        { id: NOTE_B_ID, path: "target.md" },
      ],
      [
        { id: NOTE_A_ID, path: "source.md" },
        { id: NOTE_B_ID, path: "other.md" },
      ],
      [
        { id: NOTE_A_ID, path: "source.md" },
        { id: NOTE_B_ID, path: "source.md" },
      ],
    ];
    for (const rows of malformedRows) {
      const db = {
        query: () => ({ collect: async () => [rows] }),
      } as unknown as Surreal;
      const handlers = proposalHandlers(db);
      await expect(handlers.proposeLink(linkRequest())).rejects.toThrow(
        "proposal storage integrity",
      );
    }
  });
});

describe("proposals.approve / proposals.reject", () => {
  test("an agent cannot decide a relationship even when it calls the handler directly", async () => {
    const recorder = recordingService();
    const { db } = makeFakeDb(() => [EDGE_ROW]);
    const handlers = proposalHandlers(db, recorder.service);
    const request = rpcRequest(
      { id: SUPPORTS_ID },
      { principal: { id: "codex", kind: "agent", scopes: ["read", "write"] } },
    );
    await expect(handlers.approve(request)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(handlers.reject(request)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(recorder.approved).toHaveLength(0);
    expect(recorder.rejected).toHaveLength(0);
  });

  test("a pending row is handed to the approval service", async () => {
    const recorder = recordingService();
    const { db } = makeFakeDb(() => [EDGE_ROW]);
    const handlers = proposalHandlers(db, recorder.service);
    const result = await handlers.approve(rpcRequest({ id: SUPPORTS_ID }));
    expect(result).toEqual({
      ok: true,
      edgeId: SUPPORTS_ID,
      table: "supports",
      found: true,
      historyId: HISTORY_ID,
      approvedBy: "human",
    });
    expect(recorder.approved).toHaveLength(1);
    expect(recorder.approved[0]).toMatchObject({ approvedBy: "human" });
  });

  test("rejecting a pending row calls rejectEdge", async () => {
    const recorder = recordingService();
    const { db } = makeFakeDb(() => [{ ...EDGE_ROW, id: proposalRecordId("related_to", 2) }]);
    const handlers = proposalHandlers(db, recorder.service);
    const result = await handlers.reject(
      rpcRequest({ id: RELATED_TO_ID, reason: "not actually related" }),
    );
    expect(result).toMatchObject({
      found: true,
      table: "related_to",
      reason: "not actually related",
      historyId: HISTORY_ID,
    });
    expect(recorder.rejected).toHaveLength(1);
    expect(recorder.rejected[0]).toMatchObject({
      reason: "not actually related",
      rejectedBy: "human",
    });
  });

  test("an already-decided row is idempotent, not an error", async () => {
    const recorder = recordingService(null);
    const { db } = makeFakeDb(() => []);
    const handlers = proposalHandlers(db, recorder.service);
    const missingId = proposalRecordId("supports", 999).toString();
    expect(await handlers.approve(rpcRequest({ id: missingId }))).toEqual({
      ok: true,
      edgeId: missingId,
      table: "supports",
      found: false,
      historyId: null,
      approvedBy: null,
    });
    expect(recorder.approved).toHaveLength(1);
  });

  test("a missing id is rejected as INVALID_PARAMS", async () => {
    const { db } = makeFakeDb(() => []);
    const handlers = proposalHandlers(db);
    await expect(handlers.approve(rpcRequest())).rejects.toThrow(
      "canonical SurrealDB relation record id",
    );
  });

  test("malformed list filters are rejected before touching the database", async () => {
    const { db, queries } = makeFakeDb(() => []);
    const handlers = proposalHandlers(db);
    await expect(handlers.list(rpcRequest({ limit: Number.NaN }))).rejects.toThrow("1 through 200");
    await expect(handlers.list(rpcRequest({ limit: 1.5 }))).rejects.toThrow("1 through 200");
    await expect(handlers.list(rpcRequest({ limit: null }))).rejects.toThrow("1 through 200");
    await expect(handlers.list(rpcRequest({ limit: 201 }))).rejects.toThrow("1 through 200");
    await expect(handlers.list(rpcRequest({ agent: "" }))).rejects.toThrow("canonical proposal");
    await expect(handlers.list(rpcRequest({ agent: "Legacy Agent" }))).rejects.toThrow(
      "canonical proposal",
    );
    for (const notePath of [" a.md", ".notient/private.md", "notes//invalid.md", "a.txt"]) {
      await expect(handlers.list(rpcRequest({ notePath })), notePath).rejects.toThrow(
        "exact ordinary public vault-relative Markdown note path",
      );
    }
    expect(queries).toHaveLength(0);
  });

  test("accepts contradictionHunter as an autonomous proposal filter", async () => {
    const { db, queries } = makeFakeDb(() => []);
    const handlers = proposalHandlers(db);
    await handlers.list(rpcRequest({ agent: "contradictionHunter" }));
    expect(queries).toHaveLength(6);
    expect(queries.every((sql) => sql.includes("agent = $agent"))).toBe(true);
  });

  test("an id outside the linker tables is refused before touching the database", async () => {
    const { db, queries } = makeFakeDb(() => []);
    const handlers = proposalHandlers(db);
    await expect(
      handlers.reject(rpcRequest({ id: proposalRecordId("wikilink", 1).toString() })),
    ).rejects.toThrow("canonical SurrealDB relation record id");
    expect(queries).toHaveLength(0);
  });

  test("alternate and whitespace-normalized relation ids are refused before querying", async () => {
    const { db, queries } = makeFakeDb(() => []);
    const handlers = proposalHandlers(db);
    for (const id of ["supports:abc", ` ${SUPPORTS_ID}`, `${SUPPORTS_ID} `]) {
      await expect(handlers.approve(rpcRequest({ id }))).rejects.toThrow(
        "canonical SurrealDB relation record id",
      );
    }
    expect(queries).toHaveLength(0);
  });

  test("approval-service failures propagate instead of becoming a missing proposal", async () => {
    const { db } = makeFakeDb(() => []);
    const service = recordingService().service;
    service.approveEdge = async () => {
      throw new Error("surreal transport failed");
    };
    const handlers = proposalHandlers(db, service);
    await expect(handlers.approve(rpcRequest({ id: SUPPORTS_ID }))).rejects.toThrow(
      "surreal transport failed",
    );
  });
});
