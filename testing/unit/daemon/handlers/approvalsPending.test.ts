import { describe, expect, test } from "bun:test";
import { ApprovalGate } from "../../../../src/core/chat/approvalGate";
import type { ToolCall } from "../../../../src/core/chat/types";
import {
  collectPendingApprovals,
  makeApprovalsPendingHandler,
} from "../../../../src/daemon/handlers/approvalsPending";
import { agentPrincipal, rpcRequest } from "../../../rpcRequest";

const NO_GRANTS = {
  claim: async () => null,
};
const HUMAN_CONTEXT = { clientIdentity: "human" } as const;

function makeGate(now: () => number = () => 1_000): ApprovalGate {
  return new ApprovalGate({
    recordHistoryAutoApprove: async () => {},
    perToolPolicy: () => ({}),
    sessionGrants: NO_GRANTS,
    now,
  });
}

function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, args };
}

async function advanceGrantLookup(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ApprovalGate.listPending", () => {
  test("is empty when nothing is parked", () => {
    expect(makeGate().listPending()).toEqual([]);
    expect(makeGate().pendingCount()).toBe(0);
  });

  test("projects a parked call without its resolve handle or raw args", async () => {
    const gate = makeGate();
    void gate.request(
      call("c1", "notes.append", { notePath: "Inbox/today.md", body: "x" }),
      "safe",
      "+ x",
      new AbortController().signal,
      { clientIdentity: "mcp" },
    );
    await advanceGrantLookup();
    const pending = gate.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual({
      callId: "c1",
      toolName: "notes.append",
      preview: "+ x",
      path: "Inbox/today.md",
      requestedBy: "mcp",
      requestedAt: 1_000,
    });
    expect(Object.keys(pending[0] ?? {})).not.toContain("resolve");
  });

  test("a tool call with no path argument reports a null path", async () => {
    const gate = makeGate();
    void gate.request(
      call("c2", "search.run"),
      "safe",
      "",
      new AbortController().signal,
      HUMAN_CONTEXT,
    );
    await advanceGrantLookup();
    expect(gate.listPending()[0]?.path).toBeNull();
  });

  test("projects the required requester identity", async () => {
    const gate = makeGate();
    void gate.request(
      call("c3", "notes.create"),
      "safe",
      "",
      new AbortController().signal,
      HUMAN_CONTEXT,
    );
    await advanceGrantLookup();
    expect(gate.listPending()[0]?.requestedBy).toBe("human");
  });

  test("entries come back oldest first", async () => {
    let clock = 100;
    const gate = makeGate(() => clock);
    void gate.request(call("first", "a"), "safe", "", new AbortController().signal, HUMAN_CONTEXT);
    await advanceGrantLookup();
    clock = 200;
    void gate.request(call("second", "b"), "safe", "", new AbortController().signal, HUMAN_CONTEXT);
    await advanceGrantLookup();
    expect(gate.listPending().map((entry) => entry.callId)).toEqual(["first", "second"]);
  });

  test("listing does not resolve or remove anything", async () => {
    const gate = makeGate();
    void gate.request(
      call("c4", "notes.append"),
      "safe",
      "",
      new AbortController().signal,
      HUMAN_CONTEXT,
    );
    await advanceGrantLookup();
    gate.listPending();
    gate.listPending();
    expect(gate.pendingCount()).toBe(1);
    expect(gate.hasPending()).toBe(true);
  });

  test("a resolved call leaves the pending list", async () => {
    const gate = makeGate();
    void gate.request(
      call("c5", "notes.append"),
      "safe",
      "",
      new AbortController().signal,
      HUMAN_CONTEXT,
    );
    await advanceGrantLookup();
    expect(
      gate.resolve(
        "c5",
        { approved: true },
        { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
      ),
    ).toBe(true);
    expect(gate.listPending()).toEqual([]);
  });
});

describe("approvals.pending handler", () => {
  test("maps the gate projection onto the wire shape", async () => {
    const gate = makeGate();
    void gate.request(
      call("c6", "notes.replace_section", { notePath: "a.md" }),
      "safe",
      "preview text",
      new AbortController().signal,
      { clientIdentity: "human" },
    );
    await advanceGrantLookup();
    const payload = await makeApprovalsPendingHandler({ approvalGate: gate })(rpcRequest());
    expect(payload).toEqual({
      ok: true,
      approvals: [
        {
          callId: "c6",
          tool: "notes.replace_section",
          preview: "preview text",
          path: "a.md",
          requestedBy: "human",
          requestedAt: 1_000,
        },
      ],
    });
  });

  test("returns an empty list rather than an error on an idle gate", () => {
    expect(collectPendingApprovals({ approvalGate: makeGate() })).toEqual({
      ok: true,
      approvals: [],
    });
  });

  test("agents see only their own approval previews while a human sees every pending call", async () => {
    const gate = makeGate();
    const controller = new AbortController();
    const claudePending = gate.request(
      call("claude-call", "notes.write", { path: "claude.md" }),
      "safe",
      "claude private preview",
      controller.signal,
      { clientIdentity: "claude-code" },
    );
    const codexPending = gate.request(
      call("codex-call", "notes.write", { path: "codex.md" }),
      "safe",
      "codex private preview",
      controller.signal,
      { clientIdentity: "codex" },
    );
    await advanceGrantLookup();
    const handler = makeApprovalsPendingHandler({ approvalGate: gate });

    const claude = await handler(rpcRequest({}, { principal: agentPrincipal("claude-code") }));
    const human = await handler(rpcRequest());

    expect((claude.approvals as Array<{ callId: string }>).map((entry) => entry.callId)).toEqual([
      "claude-call",
    ]);
    expect((human.approvals as Array<{ callId: string }>).map((entry) => entry.callId)).toEqual([
      "claude-call",
      "codex-call",
    ]);

    gate.resolve("claude-call", { approved: false, reason: "test complete" });
    gate.resolve("codex-call", { approved: false, reason: "test complete" });
    await Promise.all([claudePending, codexPending]);
  });
});
