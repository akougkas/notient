import { describe, expect, test } from "bun:test";
import type { ClientHandle, ClientOptions, RpcResponseFrame } from "../../../../src/cli/client";
import {
  runProposalsApproveCommand,
  runProposalsListCommand,
  runProposalsRejectCommand,
} from "../../../../src/cli/commands/proposalsCli";
import type { StructuredEvent } from "../../../../src/cli/output";
import { makeEmitter } from "../../../../src/cli/output";
import { writebackEdgeTableFromId } from "../../../../src/core/db/edgeTables";
import { createUuidRecordId } from "../../../../src/core/db/recordId";

const RELATION_KEY = "8z7li22oizca97c0mwo4";
const SUPPORTS_ID = `supports:${RELATION_KEY}`;
const RELATED_TO_ID = `related_to:${RELATION_KEY}`;
const HISTORY_ID = createUuidRecordId("history", "018f05cd-3f7b-7000-8000-000000000001").toString();

function rpcHarness(frames: RpcResponseFrame[]) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const connections: ClientOptions[] = [];
  let closed = false;
  const client: ClientHandle = {
    principal: { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
    call(method, params) {
      calls.push({ method, params });
      return (async function* () {
        for (const frame of frames) yield frame;
      })();
    },
    close: async () => {
      closed = true;
    },
  };
  return {
    calls,
    connections,
    closed: () => closed,
    connect: async (options: ClientOptions) => {
      connections.push(options);
      return client;
    },
  };
}

describe("proposals CLI module shape", () => {
  test("module exports the run functions", () => {
    expect(typeof runProposalsListCommand).toBe("function");
    expect(typeof runProposalsApproveCommand).toBe("function");
    expect(typeof runProposalsRejectCommand).toBe("function");
  });

  test("the canonical edge parser accepts every writeback prefix", () => {
    expect(writebackEdgeTableFromId(`supports:${RELATION_KEY}`)).toBe("supports");
    expect(writebackEdgeTableFromId(`contradicts:${RELATION_KEY}`)).toBe("contradicts");
    expect(writebackEdgeTableFromId(`extends:${RELATION_KEY}`)).toBe("extends");
    expect(writebackEdgeTableFromId(`exemplifies:${RELATION_KEY}`)).toBe("exemplifies");
    expect(writebackEdgeTableFromId(`synthesizes:${RELATION_KEY}`)).toBe("synthesizes");
    expect(writebackEdgeTableFromId(`related_to:${RELATION_KEY}`)).toBe("related_to");
  });

  test("the canonical edge parser rejects malformed and non-writeback ids", () => {
    expect(writebackEdgeTableFromId("note:abc")).toBeNull();
    expect(writebackEdgeTableFromId("wikilink:abc")).toBeNull();
    expect(writebackEdgeTableFromId("abc")).toBeNull();
    expect(writebackEdgeTableFromId(":abc")).toBeNull();
    expect(writebackEdgeTableFromId("")).toBeNull();
  });
});

describe("proposals CLI input validation", () => {
  test("approve with empty id exits 2 and emits INVALID_PARAMS", async () => {
    const events: StructuredEvent[] = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => events.push(JSON.parse(line) as StructuredEvent),
    });
    const code = await runProposalsApproveCommand({
      vaultPath: "/dev/null",
      emitter,
      id: "",
    });
    expect(code).toBe(2);
    expect(events[0]?.type).toBe("error");
    expect(events[0]?.code).toBe("INVALID_PARAMS");
  });

  test("approve with non-writeback prefix exits 2 and emits INVALID_ID", async () => {
    const events: StructuredEvent[] = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => events.push(JSON.parse(line) as StructuredEvent),
    });
    const code = await runProposalsApproveCommand({
      vaultPath: "/dev/null",
      emitter,
      id: "note:abc",
    });
    expect(code).toBe(2);
    expect(events[0]?.type).toBe("error");
    expect(events[0]?.code).toBe("INVALID_ID");
  });

  test("reject with empty id exits 2 and emits INVALID_PARAMS", async () => {
    const events: StructuredEvent[] = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => events.push(JSON.parse(line) as StructuredEvent),
    });
    const code = await runProposalsRejectCommand({
      vaultPath: "/dev/null",
      emitter,
      id: "",
    });
    expect(code).toBe(2);
    expect(events[0]?.type).toBe("error");
    expect(events[0]?.code).toBe("INVALID_PARAMS");
  });

  test("reject with non-writeback prefix exits 2 and emits INVALID_ID", async () => {
    const events: StructuredEvent[] = [];
    const emitter = makeEmitter({
      mode: "json",
      write: (line) => events.push(JSON.parse(line) as StructuredEvent),
    });
    const code = await runProposalsRejectCommand({
      vaultPath: "/dev/null",
      emitter,
      id: "wikilink:abc",
    });
    expect(code).toBe(2);
    expect(events[0]?.type).toBe("error");
    expect(events[0]?.code).toBe("INVALID_ID");
  });

  test("list forwards every filter and preserves the CLI row shape", async () => {
    const rpc = rpcHarness([
      {
        id: "req-1",
        type: "result",
        ok: true,
        proposals: [
          {
            id: SUPPORTS_ID,
            table: "supports",
            fromNotePath: "a.md",
            toNotePath: "b.md",
            agent: "linker",
            confidence: 0.8,
            createdAt: 1,
            evidence: [],
          },
        ],
      },
    ]);
    const events: StructuredEvent[] = [];
    const code = await runProposalsListCommand({
      vaultPath: "/vault",
      emitter: { emit: (event) => events.push(event) },
      asJson: false,
      notePath: "a.md",
      agent: "linker",
      limit: 7,
      connect: rpc.connect,
    });
    expect(code).toBe(0);
    expect(rpc.calls).toEqual([
      {
        method: "links.proposals",
        params: { notePath: "a.md", agent: "linker", limit: 7 },
      },
    ]);
    expect(events).toEqual([
      {
        type: "proposals:list",
        id: SUPPORTS_ID,
        table: "supports",
        source: "a.md",
        target: "b.md",
        agent: "linker",
        confidence: 0.8,
      },
    ]);
    expect(rpc.closed()).toBe(true);
  });

  test("approve and reject are daemon calls and retain idempotent not-found semantics", async () => {
    const approve = rpcHarness([
      {
        id: "req-1",
        type: "result",
        ok: true,
        edgeId: SUPPORTS_ID,
        table: "supports",
        found: false,
        historyId: null,
        approvedBy: null,
      },
    ]);
    const approvedEvents: StructuredEvent[] = [];
    expect(
      await runProposalsApproveCommand({
        vaultPath: "/vault",
        emitter: { emit: (event) => approvedEvents.push(event) },
        id: SUPPORTS_ID,
        connect: approve.connect,
      }),
    ).toBe(0);
    expect(approve.calls).toEqual([{ method: "links.approve", params: { id: SUPPORTS_ID } }]);
    expect(approvedEvents[0]?.type).toBe("proposals:not_found");

    const reject = rpcHarness([
      {
        id: "req-1",
        type: "result",
        ok: true,
        edgeId: RELATED_TO_ID,
        table: "related_to",
        found: true,
        reason: "duplicate",
        historyId: HISTORY_ID,
      },
    ]);
    const rejectedEvents: StructuredEvent[] = [];
    expect(
      await runProposalsRejectCommand({
        vaultPath: "/vault",
        emitter: { emit: (event) => rejectedEvents.push(event) },
        id: RELATED_TO_ID,
        reason: "  duplicate  ",
        clientIdentity: "operator",
        connect: reject.connect,
      }),
    ).toBe(0);
    expect(reject.calls).toEqual([
      {
        method: "links.reject",
        params: { id: RELATED_TO_ID, reason: "  duplicate  " },
      },
    ]);
    expect(reject.connections[0]?.clientIdentity).toBe("operator");
    expect(rejectedEvents[0]).toMatchObject({
      type: "proposals:rejected",
      reason: "duplicate",
      historyId: HISTORY_ID,
    });
  });

  test("an admin refusal is visible and exits nonzero", async () => {
    const rpc = rpcHarness([
      {
        id: "req-1",
        type: "error",
        code: "FORBIDDEN",
        message: "links.approve requires the 'admin' scope",
      },
    ]);
    const events: StructuredEvent[] = [];
    const code = await runProposalsApproveCommand({
      vaultPath: "/vault",
      emitter: { emit: (event) => events.push(event) },
      id: SUPPORTS_ID,
      connect: rpc.connect,
    });
    expect(code).toBe(1);
    expect(events[0]).toMatchObject({ type: "error", code: "FORBIDDEN" });
  });
});
