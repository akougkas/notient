import { describe, expect, test } from "bun:test";
import { ApprovalGate } from "../../../../src/core/chat/approvalGate";
import type { DurableNoteWriteInput } from "../../../../src/core/history/durableNoteWriter";
import { NonBlockingApprovalTracker } from "../../../../src/daemon/handlers/nonBlockingApproval";
import { makeProposalNoteHandler } from "../../../../src/daemon/handlers/proposalNote";
import { RpcError } from "../../../../src/daemon/rpc";
import { agentPrincipal, rpcRequest } from "../../../rpcRequest";

const HISTORY_ID = 'history:u"018f05cd-3f7b-7000-8000-000000000002"';
const NOW = Date.parse("2026-03-04T09:15:00.000Z");

function makeGate(): ApprovalGate {
  return new ApprovalGate({
    recordHistoryAutoApprove: async () => {},
    perToolPolicy: () => ({}),
    sessionGrants: { claim: async () => null },
    now: () => NOW,
  });
}

function build(options: {
  exists?: () => Promise<boolean>;
  approvalMode?: "safe" | "yolo";
}) {
  const gate = makeGate();
  const writes: DurableNoteWriteInput[] = [];
  const handler = makeProposalNoteHandler({
    approvalGate: gate,
    approvalTracker: new NonBlockingApprovalTracker(),
    approvalMode: () => options.approvalMode ?? "safe",
    vault: { exists: options.exists ?? (async () => false) },
    applyWrite: async (input) => {
      writes.push(input);
      return { applied: true, historyId: HISTORY_ID };
    },
    hash: async () => "a".repeat(64),
    now: () => NOW,
  });
  return { gate, handler, writes };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}

describe("proposals.propose_note", () => {
  test("parks safely, attributes the server principal, then writes through the durable boundary", async () => {
    const { gate, handler, writes } = build({});
    const result = await handler(
      rpcRequest(
        { title: "Auth proposal", body: "Use passkeys", kind: "decision" },
        { principal: agentPrincipal("claude-code") },
      ),
    );

    expect(result).toMatchObject({
      ok: true,
      applied: false,
      pending: true,
      path: "Notient/proposals/2026-03-04-auth-proposal.md",
    });
    expect(writes).toEqual([]);
    const pending = gate.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      toolName: "proposals.propose_note",
      path: "Notient/proposals/2026-03-04-auth-proposal.md",
      requestedBy: "claude-code",
    });
    expect(pending[0]?.preview).toContain("Use passkeys");

    gate.resolve(
      String(result.callId),
      { approved: true },
      { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
    );
    await settle();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      kind: "notes.create",
      target: "Notient/proposals/2026-03-04-auth-proposal.md",
      before: null,
      clientIdentity: "claude-code",
    });
    expect(writes[0]?.after).toContain('proposedBy: "claude-code"');
    expect(writes[0]?.after).toContain('proposedAt: "2026-03-04T09:15:00.000Z"');
  });

  test("yolo mode returns an exact applied receipt inline", async () => {
    const { handler, writes } = build({ approvalMode: "yolo" });
    await expect(
      handler(
        rpcRequest({ title: "Immediate", body: "body" }, { principal: agentPrincipal("codex") }),
      ),
    ).resolves.toEqual({
      ok: true,
      applied: true,
      path: "Notient/proposals/2026-03-04-immediate.md",
      sha: "a".repeat(64),
      historyId: HISTORY_ID,
    });
    expect(writes[0]?.clientIdentity).toBe("codex");
  });

  test("an existing target is refused without entering the approval gate", async () => {
    const { gate, handler, writes } = build({ exists: async () => true });
    const result = await handler(
      rpcRequest({ title: "Collision", body: "body" }, { principal: agentPrincipal("codex") }),
    );
    expect(result).toMatchObject({
      ok: true,
      applied: false,
      pending: false,
      reason: "path already exists: Notient/proposals/2026-03-04-collision.md",
    });
    expect(gate.listPending()).toEqual([]);
    expect(writes).toEqual([]);
  });

  test("rejects malformed input before consulting storage or approval", async () => {
    let probes = 0;
    const { gate, handler, writes } = build({
      exists: async () => {
        probes++;
        return false;
      },
    });
    for (const params of [
      { title: "line\nbreak", body: "x" },
      { title: "x", body: "y", kind: "Not Valid" },
      { title: "x", body: "y", path: "Notient/conversations/forged.md" },
    ]) {
      try {
        await handler(rpcRequest(params, { principal: agentPrincipal("codex") }));
        throw new Error("expected malformed proposal refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(RpcError);
        expect((error as RpcError).code).toBe("INVALID_PARAMS");
      }
    }
    expect(probes).toBe(0);
    expect(gate.listPending()).toEqual([]);
    expect(writes).toEqual([]);
  });
});
