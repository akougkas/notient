import { describe, expect, test } from "bun:test";
import { DateTime, RecordId, type Surreal } from "surrealdb";
import type { ApprovalService } from "../../../../../src/core/approvals/approvalService";
import { ApprovalGate } from "../../../../../src/core/chat/approvalGate";
import {
  makeApproveProposalTool,
  makeGetProposalTool,
  makeListProposalsTool,
  makeRejectProposalTool,
} from "../../../../../src/core/chat/tools/proposals";

const PROPOSAL_ID = "supports:8z7li22oizca97c0mwo4";
const HISTORY_ID = 'history:u"018f05cd-3f7b-7cc2-89fc-0242ac120002"';
const PROPOSAL_RECORD_ID = new RecordId("supports", "8z7li22oizca97c0mwo4");
const EVIDENCE_ID = new RecordId("chunk", "evidence0000000000001");
const PROPOSAL_ROW = {
  id: PROPOSAL_RECORD_ID,
  fromId: new RecordId("note", "source00000000000001"),
  toId: new RecordId("note", "target00000000000001"),
  fromPath: "source.md",
  toPath: "target.md",
  source: "linker",
  class: "INFERRED",
  agent: "linker",
  confidence: 0.75,
  evidence: [EVIDENCE_ID],
  approved: false,
  applied: true,
  created_at: new DateTime(new Date(1_700_000_000_000)),
};
const TEST_CONTEXT = { clientIdentity: "human" } as const;

type Responder = (sql: string, bindings: Record<string, unknown>) => unknown[];

function fakeDb(respond: Responder): Surreal {
  return {
    query: (sql: string, bindings: Record<string, unknown> = {}) => ({
      collect: async () => [respond(sql, bindings)],
    }),
  } as unknown as Surreal;
}

describe("proposals.approve / proposals.reject validation", () => {
  function makeContext(approvalService = {} as ApprovalService) {
    return {
      approvalService,
      approvalGate: new ApprovalGate({
        recordHistoryAutoApprove: async () => {},
        perToolPolicy: () => ({}),
        sessionGrants: { claim: async () => null },
      }),
      approvalMode: () => "yolo" as const,
      generateCallId: () => "call-1",
    };
  }

  test("approve schema rejects empty / missing id", () => {
    const tool = makeApproveProposalTool(makeContext());
    expect(() => tool.validate({ id: "" })).toThrow();
    expect(() => tool.validate({})).toThrow();
    expect(() => tool.validate("nope")).toThrow();
  });

  test("approve flags writeGated", () => {
    const tool = makeApproveProposalTool(makeContext());
    expect(tool.writeGated).toBe(true);
    expect(tool.name).toBe("proposals.approve");
  });

  test("reject schema accepts optional reason", () => {
    const tool = makeRejectProposalTool(makeContext());
    expect(tool.validate({ id: PROPOSAL_ID })).toEqual({ id: PROPOSAL_ID });
    expect(tool.validate({ id: PROPOSAL_ID, reason: "noisy" })).toEqual({
      id: PROPOSAL_ID,
      reason: "noisy",
    });
    expect(() => tool.validate({ id: "" })).toThrow();
    expect(() => tool.validate({ id: PROPOSAL_ID, reason: 7 })).toThrow();
    expect(() => tool.validate({ id: PROPOSAL_ID, reason: null })).toThrow();
    expect(() => tool.validate({ id: PROPOSAL_ID, reason: "   " })).toThrow();
    expect(() => tool.validate({ id: "supports:abc" })).toThrow();
    expect(() => tool.validate({ id: ` ${PROPOSAL_ID}` })).toThrow();
  });

  test("reject flags writeGated", () => {
    const tool = makeRejectProposalTool(makeContext());
    expect(tool.writeGated).toBe(true);
    expect(tool.name).toBe("proposals.reject");
  });
});

describe("proposal chat-tool storage decoding", () => {
  function makeStorageContext(approvalService: ApprovalService) {
    return {
      approvalService,
      approvalGate: new ApprovalGate({
        recordHistoryAutoApprove: async () => {},
        perToolPolicy: () => ({}),
        sessionGrants: { claim: async () => null },
      }),
      approvalMode: () => "yolo" as const,
      generateCallId: () => "call-storage",
    };
  }

  test("lists and gets one exact native pending proposal", async () => {
    const db = fakeDb((sql) => (sql.includes("FROM supports") ? [PROPOSAL_ROW] : []));
    const list = makeListProposalsTool(db);
    const listed = await list.invoke({}, new AbortController().signal, TEST_CONTEXT);
    expect(listed.proposals).toEqual([
      {
        kind: "edge",
        id: PROPOSAL_ID,
        type: "supports",
        sourceId: PROPOSAL_ROW.fromId.toString(),
        targetId: PROPOSAL_ROW.toId.toString(),
        sourceNotePath: "source.md",
        targetNotePath: "target.md",
        confidence: 0.75,
        source: "linker",
        agent: "linker",
        evidence: [EVIDENCE_ID.toString()],
        rationale: null,
        createdAt: 1_700_000_000_000,
      },
    ]);

    const get = makeGetProposalTool(db);
    const fetched = await get.invoke(
      { id: PROPOSAL_ID },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    expect(fetched.proposal?.id).toBe(PROPOSAL_ID);
  });

  test("queries only proposals whose public note endpoints are still live", async () => {
    const queries: string[] = [];
    const db = fakeDb((sql) => {
      queries.push(sql);
      return [];
    });
    await makeListProposalsTool(db).invoke({}, new AbortController().signal, TEST_CONTEXT);
    await makeGetProposalTool(db).invoke(
      { id: PROPOSAL_ID },
      new AbortController().signal,
      TEST_CONTEXT,
    );
    for (const sql of queries) {
      expect(sql).toContain("in.tombstoned_at IS NONE");
      expect(sql).toContain("out.tombstoned_at IS NONE");
    }
  });

  test("a valid empty query is the only shape decoded as not found", async () => {
    const empty = makeGetProposalTool(fakeDb(() => []));
    expect(
      await empty.invoke({ id: PROPOSAL_ID }, new AbortController().signal, TEST_CONTEXT),
    ).toEqual({ proposal: null });

    for (const raw of [[], [[], []], {}, [null]]) {
      const db = {
        query: () => ({ collect: async () => raw }),
      } as unknown as Surreal;
      await expect(
        makeGetProposalTool(db).invoke(
          { id: PROPOSAL_ID },
          new AbortController().signal,
          TEST_CONTEXT,
        ),
      ).rejects.toThrow("invalid statement envelope");
    }
  });

  test("malformed rows and database errors propagate", async () => {
    const malformed = makeListProposalsTool(
      fakeDb((sql) =>
        sql.includes("FROM supports") ? [{ ...PROPOSAL_ROW, agent: "synthesizer" }] : [],
      ),
    );
    await expect(malformed.invoke({}, new AbortController().signal, TEST_CONTEXT)).rejects.toThrow(
      "agent must exactly match",
    );

    const failedDb = {
      query: () => ({
        collect: async () => {
          throw new Error("surreal query failed");
        },
      }),
    } as unknown as Surreal;
    await expect(
      makeGetProposalTool(failedDb).invoke(
        { id: PROPOSAL_ID },
        new AbortController().signal,
        TEST_CONTEXT,
      ),
    ).rejects.toThrow("surreal query failed");
  });

  test("list limit is rejected rather than clamped", () => {
    const list = makeListProposalsTool(fakeDb(() => []));
    expect(() => list.validate({ limit: 201 })).toThrow("1 through 200");
    expect(() => list.validate({ limit: 1.5 })).toThrow("1 through 200");
    expect(() => list.validate({ limit: null })).toThrow("1 through 200");
    for (const notePath of [" a.md", ".hidden.md", "notes/private.txt", "notes/../x.md"]) {
      expect(() => list.validate({ notePath })).toThrow(
        "exact ordinary public vault-relative Markdown",
      );
    }
    expect(() => list.validate({ agent: "" })).toThrow("canonical proposal producer");
    expect(() => list.validate({ agent: "Legacy Agent" })).toThrow("canonical proposal producer");
    expect(list.validate({ agent: "codex" })).toEqual({ agent: "codex" });
    expect(() => list.validate(null)).toThrow("expected object");
  });

  test("approve delegates the atomic pending-state decision to ApprovalService", async () => {
    let approvals = 0;
    const service = {
      approveEdge: async () => {
        approvals += 1;
        return { historyId: HISTORY_ID, approvedBy: "human" };
      },
    } as unknown as ApprovalService;
    const valid = makeApproveProposalTool(makeStorageContext(service));
    expect(
      await valid.invoke({ id: PROPOSAL_ID }, new AbortController().signal, TEST_CONTEXT),
    ).toEqual({
      applied: true,
      id: PROPOSAL_ID,
      table: "supports",
      historyId: HISTORY_ID,
      approvedBy: "human",
    });
    expect(approvals).toBe(1);
  });
});
