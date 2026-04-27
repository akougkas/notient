import { describe, expect, test } from "bun:test";
import { ApprovalGate, type ApprovalGateEvents, type PendingApproval } from "./approvalGate";
import type { ToolCall } from "./types";

function makeCall(id = "call-1", name = "notes.create"): ToolCall {
  return { id, name, args: { path: "/x.md" } };
}

interface Recorder {
  pending: PendingApproval[];
  resolved: { callId: string; approved: boolean; reason?: string }[];
  autoApproved: ToolCall[];
}

function makeGate(recorder: Recorder, autoFails = false): ApprovalGate {
  const events: ApprovalGateEvents = {
    onPending: (p) => recorder.pending.push(p),
    onResolved: (callId, decision) =>
      recorder.resolved.push({ callId, approved: decision.approved, reason: decision.reason }),
  };
  return new ApprovalGate({
    events,
    recordHistoryAutoApprove: async (call) => {
      if (autoFails) throw new Error("history write failed");
      recorder.autoApproved.push(call);
    },
  });
}

describe("ApprovalGate", () => {
  test("safe mode resolves with approved=true on user.approve", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const gate = makeGate(recorder);
    const controller = new AbortController();
    const call = makeCall();
    const promise = gate.request(call, "safe", "preview body", controller.signal);
    expect(gate.hasPending()).toBe(true);
    expect(recorder.pending).toHaveLength(1);
    expect(recorder.pending[0].callId).toBe("call-1");
    expect(recorder.pending[0].preview).toBe("preview body");
    gate.resolve("call-1", { approved: true });
    const decision = await promise;
    expect(decision.approved).toBe(true);
    expect(recorder.resolved).toEqual([{ callId: "call-1", approved: true, reason: undefined }]);
    expect(gate.hasPending()).toBe(false);
  });

  test("safe mode resolves with rejection + reason", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const gate = makeGate(recorder);
    const controller = new AbortController();
    const promise = gate.request(makeCall(), "safe", "preview", controller.signal);
    gate.resolve("call-1", { approved: false, reason: "wrong path" });
    const decision = await promise;
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe("wrong path");
    expect(recorder.resolved).toHaveLength(1);
    expect(recorder.resolved[0].reason).toBe("wrong path");
    expect(gate.hasPending()).toBe(false);
  });

  test("yolo mode auto-resolves immediately and records history", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const gate = makeGate(recorder);
    const controller = new AbortController();
    const decision = await gate.request(makeCall(), "yolo", "preview", controller.signal);
    expect(decision.approved).toBe(true);
    expect(recorder.pending).toHaveLength(0);
    expect(recorder.autoApproved).toHaveLength(1);
    expect(recorder.autoApproved[0].id).toBe("call-1");
    expect(recorder.resolved).toEqual([{ callId: "call-1", approved: true, reason: undefined }]);
    expect(gate.hasPending()).toBe(false);
  });

  test("abort during pending approval rejects with AbortError", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const gate = makeGate(recorder);
    const controller = new AbortController();
    const promise = gate.request(makeCall(), "safe", "preview", controller.signal);
    controller.abort();
    let caught: unknown = null;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    expect((caught as Error).name).toBe("AbortError");
    expect(gate.hasPending()).toBe(false);
    expect(recorder.resolved).toHaveLength(0);
  });

  test("request thrown synchronously when signal is already aborted", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const gate = makeGate(recorder);
    const controller = new AbortController();
    controller.abort();
    let caught: unknown = null;
    try {
      await gate.request(makeCall(), "safe", "preview", controller.signal);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).name).toBe("AbortError");
    expect(gate.hasPending()).toBe(false);
  });

  test("resolve cleans up handler so further resolves are no-ops", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const gate = makeGate(recorder);
    const controller = new AbortController();
    const promise = gate.request(makeCall(), "safe", "preview", controller.signal);
    gate.resolve("call-1", { approved: true });
    await promise;
    gate.resolve("call-1", { approved: false, reason: "ignored" });
    expect(recorder.resolved).toHaveLength(1);
  });

  test("cancelAll resolves every pending entry as rejected with the supplied reason", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const gate = makeGate(recorder);
    const controller = new AbortController();
    const p1 = gate.request(makeCall("a"), "safe", "p1", controller.signal);
    const p2 = gate.request(makeCall("b"), "safe", "p2", controller.signal);
    expect(gate.hasPending()).toBe(true);
    gate.cancelAll("turn-aborted");
    const [d1, d2] = await Promise.all([p1, p2]);
    expect(d1).toEqual({ approved: false, reason: "turn-aborted" });
    expect(d2).toEqual({ approved: false, reason: "turn-aborted" });
    expect(gate.hasPending()).toBe(false);
    expect(recorder.resolved).toHaveLength(2);
    expect(recorder.resolved.map((entry) => entry.reason)).toEqual([
      "turn-aborted",
      "turn-aborted",
    ]);
  });

  test("cancelAll defaults the reason to 'cancelled'", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const gate = makeGate(recorder);
    const controller = new AbortController();
    const promise = gate.request(makeCall(), "safe", "preview", controller.signal);
    gate.cancelAll();
    const decision = await promise;
    expect(decision).toEqual({ approved: false, reason: "cancelled" });
    expect(gate.hasPending()).toBe(false);
  });

  test("cancelAll is a no-op when nothing is pending", () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const gate = makeGate(recorder);
    gate.cancelAll("anything");
    expect(recorder.resolved).toHaveLength(0);
  });

  test("list() returns the currently pending approvals", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const gate = makeGate(recorder);
    const controller = new AbortController();
    void gate.request(makeCall("a"), "safe", "p1", controller.signal).catch(() => {});
    void gate.request(makeCall("b"), "safe", "p2", controller.signal).catch(() => {});
    expect(
      gate
        .list()
        .map((p) => p.callId)
        .sort(),
    ).toEqual(["a", "b"]);
    controller.abort();
  });

  test("safe mode auto-approves a tool with explicit auto override", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const events: ApprovalGateEvents = {
      onPending: (p) => recorder.pending.push(p),
      onResolved: (callId, decision) =>
        recorder.resolved.push({ callId, approved: decision.approved, reason: decision.reason }),
    };
    const gate = new ApprovalGate({
      events,
      recordHistoryAutoApprove: async (call) => {
        recorder.autoApproved.push(call);
      },
      perToolPolicy: { "vault.read_note": "auto" },
    });
    const controller = new AbortController();
    const decision = await gate.request(
      { id: "c1", name: "vault.read_note", args: {} },
      "safe",
      "preview",
      controller.signal,
    );
    expect(decision.approved).toBe(true);
    expect(recorder.pending).toHaveLength(0);
    expect(recorder.autoApproved).toHaveLength(1);
  });

  test("yolo mode still gates tools with explicit ask override", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const events: ApprovalGateEvents = {
      onPending: (p) => recorder.pending.push(p),
      onResolved: (callId, decision) =>
        recorder.resolved.push({ callId, approved: decision.approved, reason: decision.reason }),
    };
    const gate = new ApprovalGate({
      events,
      recordHistoryAutoApprove: async () => {},
      perToolPolicy: { "obsidian.eval": "ask" },
    });
    const controller = new AbortController();
    const promise = gate.request(
      { id: "c2", name: "obsidian.eval", args: { code: "1" } },
      "yolo",
      "preview",
      controller.signal,
    );
    expect(gate.hasPending()).toBe(true);
    gate.resolve("c2", { approved: true });
    const decision = await promise;
    expect(decision.approved).toBe(true);
    expect(recorder.autoApproved).toHaveLength(0);
  });

  test("policyFor returns mode default when no override is present", () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const gate = makeGate(recorder);
    expect(gate.policyFor("notes.create", "safe")).toBe("ask");
    expect(gate.policyFor("notes.create", "yolo")).toBe("auto");
  });
});
