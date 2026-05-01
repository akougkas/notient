import { describe, expect, test } from "bun:test";
import type { SessionGrant, SessionGrantFindQuery } from "../../../../src/core/services/sessionGrants";
import {
  ApprovalGate,
  type ApprovalGateEvents,
  type PendingApproval,
  type SessionGrantLookup,
  extractFolder,
} from "../../../../src/core/chat/approvalGate";
import type { ToolCall } from "../../../../src/core/chat/types";

function makeCall(id = "call-1", name = "notes.create"): ToolCall {
  return { id, name, args: { path: "/x.md" } };
}

interface Recorder {
  pending: PendingApproval[];
  resolved: { callId: string; approved: boolean; reason?: string; sessionId?: number }[];
  autoApproved: ToolCall[];
}

function nullGrants(): SessionGrantLookup {
  return { find: () => null, incrementWriteCount: () => {} };
}

interface RecordingGrants extends SessionGrantLookup {
  findQueries: SessionGrantFindQuery[];
  incrementCalls: number[];
}

function recordingGrants(grant: SessionGrant | null): RecordingGrants {
  const findQueries: SessionGrantFindQuery[] = [];
  const incrementCalls: number[] = [];
  return {
    findQueries,
    incrementCalls,
    find: (query) => {
      findQueries.push(query);
      return grant;
    },
    incrementWriteCount: (id) => {
      incrementCalls.push(id);
    },
  };
}

function makeStubGrant(overrides: Partial<SessionGrant> = {}): SessionGrant {
  return {
    id: 7,
    client: "claude-code",
    grantedAt: 1_000,
    expiresAt: 99_999_999_999_999,
    allowedFolders: ["Inbox/"],
    allowedTools: [],
    maxWrites: null,
    usedWrites: 0,
    revokedAt: null,
    ...overrides,
  };
}

function makeGate(
  recorder: Recorder,
  autoFails = false,
  grants: SessionGrantLookup = nullGrants(),
): ApprovalGate {
  const events: ApprovalGateEvents = {
    onPending: (p) => recorder.pending.push(p),
    onResolved: (callId, decision) =>
      recorder.resolved.push({
        callId,
        approved: decision.approved,
        reason: decision.reason,
        sessionId: decision.sessionId,
      }),
  };
  return new ApprovalGate({
    events,
    recordHistoryAutoApprove: async (call) => {
      if (autoFails) throw new Error("history write failed");
      recorder.autoApproved.push(call);
    },
    sessionGrants: grants,
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
    expect(recorder.resolved).toEqual([
      { callId: "call-1", approved: true, reason: undefined, sessionId: undefined },
    ]);
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
    expect(recorder.resolved).toEqual([
      { callId: "call-1", approved: true, reason: undefined, sessionId: undefined },
    ]);
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
    expect(gate.resolve("call-1", { approved: true })).toBe(true);
    await promise;
    expect(gate.resolve("call-1", { approved: false, reason: "ignored" })).toBe(false);
    expect(recorder.resolved).toHaveLength(1);
  });

  test("resolve reports false for unknown call ids", () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const gate = makeGate(recorder);
    expect(gate.resolve("missing", { approved: true })).toBe(false);
    expect(recorder.resolved).toHaveLength(0);
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
        recorder.resolved.push({
          callId,
          approved: decision.approved,
          reason: decision.reason,
          sessionId: decision.sessionId,
        }),
    };
    const gate = new ApprovalGate({
      events,
      recordHistoryAutoApprove: async (call) => {
        recorder.autoApproved.push(call);
      },
      perToolPolicy: { "vault.read_note": "auto" },
      sessionGrants: nullGrants(),
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
        recorder.resolved.push({
          callId,
          approved: decision.approved,
          reason: decision.reason,
          sessionId: decision.sessionId,
        }),
    };
    const gate = new ApprovalGate({
      events,
      recordHistoryAutoApprove: async () => {},
      perToolPolicy: { "obsidian.eval": "ask" },
      sessionGrants: nullGrants(),
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

describe("ApprovalGate session grants", () => {
  test("active grant yields auto decision with session-grant reason and sessionId", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const grants = recordingGrants(makeStubGrant({ id: 42 }));
    const gate = makeGate(recorder, false, grants);
    const decision = await gate.request(
      { id: "c1", name: "notes.create", args: { notePath: "Inbox/today.md" } },
      "safe",
      "preview",
      new AbortController().signal,
      { clientIdentity: "claude-code" },
    );
    expect(decision.approved).toBe(true);
    expect(decision.reason).toBe("session-grant#42");
    expect(decision.sessionId).toBe(42);
    expect(grants.findQueries).toHaveLength(1);
    expect(grants.findQueries[0]).toMatchObject({
      client: "claude-code",
      tool: "notes.create",
      folder: "Inbox/",
    });
    expect(grants.incrementCalls).toEqual([42]);
    // Session-grant approvals do NOT invoke recordHistoryAutoApprove; that
    // hook is reserved for yolo-mode auto decisions so /history can show the
    // distinct kinds.
    expect(recorder.autoApproved).toHaveLength(0);
    expect(recorder.pending).toHaveLength(0);
    expect(recorder.resolved).toEqual([
      { callId: "c1", approved: true, reason: "session-grant#42", sessionId: 42 },
    ]);
  });

  test("missing clientIdentity in context defaults to 'human' for the grant lookup", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const grants = recordingGrants(null);
    const gate = makeGate(recorder, false, grants);
    // No context arg at all.
    const promise = gate.request(
      { id: "c1", name: "notes.create", args: { notePath: "Inbox/today.md" } },
      "safe",
      "preview",
      new AbortController().signal,
    );
    // Resolve so we don't leak the pending entry; the assertion below is on
    // the find query the gate already submitted.
    gate.resolve("c1", { approved: true });
    await promise;
    expect(grants.findQueries[0].client).toBe("human");
  });

  test("grant excludes call.name via allowedTools -> falls through to per-tool policy", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    // `find` returns null because the SessionGrants service filters allowedTools
    // server-side; that's the same reality we model here.
    const grants = recordingGrants(null);
    const gate = makeGate(recorder, false, grants);
    const decision = await gate.request(
      { id: "c1", name: "notes.create", args: { notePath: "Inbox/x.md" } },
      "yolo",
      "preview",
      new AbortController().signal,
      { clientIdentity: "claude-code" },
    );
    expect(decision.approved).toBe(true);
    // Falls through to yolo-mode auto, which records via recordHistoryAutoApprove.
    expect(recorder.autoApproved).toHaveLength(1);
    expect(grants.incrementCalls).toEqual([]);
    expect(decision.sessionId).toBeUndefined();
  });

  test("exhausted grant -> find returns null -> falls through", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const grants = recordingGrants(null);
    const gate = makeGate(recorder, false, grants);
    const decision = await gate.request(
      { id: "c1", name: "notes.create", args: { notePath: "Inbox/x.md" } },
      "yolo",
      "preview",
      new AbortController().signal,
      { clientIdentity: "claude-code" },
    );
    expect(decision.approved).toBe(true);
    expect(decision.sessionId).toBeUndefined();
    expect(grants.incrementCalls).toEqual([]);
    expect(recorder.autoApproved).toHaveLength(1);
  });

  test("expired grant -> find returns null -> falls through", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const grants = recordingGrants(null);
    const gate = makeGate(recorder, false, grants);
    const decision = await gate.request(
      { id: "c1", name: "notes.create", args: { notePath: "Inbox/x.md" } },
      "yolo",
      "preview",
      new AbortController().signal,
      { clientIdentity: "claude-code" },
    );
    expect(decision.approved).toBe(true);
    expect(decision.sessionId).toBeUndefined();
    expect(grants.incrementCalls).toEqual([]);
  });

  test("revoked grant -> find returns null -> falls through", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const grants = recordingGrants(null);
    const gate = makeGate(recorder, false, grants);
    const decision = await gate.request(
      { id: "c1", name: "notes.create", args: { notePath: "Inbox/x.md" } },
      "yolo",
      "preview",
      new AbortController().signal,
      { clientIdentity: "claude-code" },
    );
    expect(decision.approved).toBe(true);
    expect(decision.sessionId).toBeUndefined();
    expect(grants.incrementCalls).toEqual([]);
  });

  test("no grant for client -> existing per-tool behavior unchanged", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const grants = recordingGrants(null);
    const gate = makeGate(recorder, false, grants);
    // Safe mode + no policy override = still asks.
    const promise = gate.request(
      { id: "c1", name: "notes.create", args: { notePath: "Inbox/x.md" } },
      "safe",
      "preview",
      new AbortController().signal,
      { clientIdentity: "claude-code" },
    );
    expect(gate.hasPending()).toBe(true);
    gate.resolve("c1", { approved: true });
    const decision = await promise;
    expect(decision.approved).toBe(true);
    expect(decision.sessionId).toBeUndefined();
    expect(grants.incrementCalls).toEqual([]);
  });

  test("incrementWriteCount fires exactly once per auto-approved call", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const grants = recordingGrants(makeStubGrant({ id: 99 }));
    const gate = makeGate(recorder, false, grants);
    await gate.request(
      { id: "c1", name: "notes.create", args: { notePath: "Inbox/a.md" } },
      "safe",
      "preview",
      new AbortController().signal,
      { clientIdentity: "claude-code" },
    );
    expect(grants.incrementCalls).toEqual([99]);
  });

  test("uses options.now for grant expiry checks when provided", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const grants = recordingGrants(null);
    const events: ApprovalGateEvents = {
      onPending: (p) => recorder.pending.push(p),
      onResolved: (callId, decision) =>
        recorder.resolved.push({
          callId,
          approved: decision.approved,
          reason: decision.reason,
          sessionId: decision.sessionId,
        }),
    };
    const gate = new ApprovalGate({
      events,
      recordHistoryAutoApprove: async () => {},
      sessionGrants: grants,
      now: () => 1_234_567,
    });
    const promise = gate.request(
      { id: "c1", name: "notes.create", args: { notePath: "Inbox/a.md" } },
      "safe",
      "preview",
      new AbortController().signal,
      { clientIdentity: "claude-code" },
    );
    gate.resolve("c1", { approved: true });
    await promise;
    expect(grants.findQueries[0].now).toBe(1_234_567);
  });
});

describe("extractFolder", () => {
  test("returns leading folder segment with trailing slash for nested paths", () => {
    expect(extractFolder("Inbox/today.md")).toBe("Inbox/");
    expect(extractFolder("Notient/agent-asks/auth.md")).toBe("Notient/");
  });

  test("returns empty string for files at the vault root", () => {
    expect(extractFolder("top.md")).toBe("");
  });

  test("returns empty string for undefined, empty, or non-string input", () => {
    expect(extractFolder(undefined)).toBe("");
    expect(extractFolder("")).toBe("");
    expect(extractFolder("   ")).toBe("");
  });

  test("trims surrounding whitespace before splitting", () => {
    expect(extractFolder("  Inbox/today.md  ")).toBe("Inbox/");
  });
});
