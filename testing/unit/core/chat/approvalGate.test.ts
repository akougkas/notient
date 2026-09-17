import { describe, expect, test } from "bun:test";
import {
  ApprovalGate,
  type ApprovalGateEvents,
  type PendingApproval,
  type SessionGrantLookup,
  extractFolder,
} from "../../../../src/core/chat/approvalGate";
import type { ToolCall } from "../../../../src/core/chat/types";
import type {
  SessionGrant,
  SessionGrantClaimQuery,
} from "../../../../src/core/services/sessionGrants";

function makeCall(id = "call-1", name = "notes.create"): ToolCall {
  return { id, name, args: { path: "/x.md" } };
}

interface Recorder {
  pending: PendingApproval[];
  resolved: { callId: string; approved: boolean; reason?: string; sessionId?: string }[];
  autoApproved: ToolCall[];
}

function nullGrants(): SessionGrantLookup {
  return { claim: async () => null };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function advanceGrantLookup(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

interface RecordingGrants extends SessionGrantLookup {
  claimQueries: SessionGrantClaimQuery[];
}

function recordingGrants(grant: SessionGrant | null): RecordingGrants {
  const claimQueries: SessionGrantClaimQuery[] = [];
  return {
    claimQueries,
    claim: async (query) => {
      claimQueries.push(query);
      return grant;
    },
  };
}

function makeStubGrant(overrides: Partial<SessionGrant> = {}): SessionGrant {
  return {
    id: sessionId(7),
    client: "claude-code",
    grantedAt: 1_000,
    expiresAt: 99_999_999_999_999,
    allowedFolders: ["Inbox/"],
    allowedTools: ["*"],
    maxWrites: null,
    usedWrites: 1,
    revokedAt: null,
    ...overrides,
  };
}

function sessionId(value: number): string {
  return `agent_session:fixture${value}`;
}

const HUMAN_CONTEXT = { clientIdentity: "human" } as const;

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
  const gate = new ApprovalGate({
    recordHistoryAutoApprove: async (call) => {
      if (autoFails) throw new Error("history write failed");
      recorder.autoApproved.push(call);
    },
    perToolPolicy: () => ({}),
    sessionGrants: grants,
  });
  gate.subscribe(events);
  return gate;
}

describe("ApprovalGate", () => {
  test("a pending boolean decision cannot confer human approval", async () => {
    const gate = new ApprovalGate({
      perToolPolicy: () => ({}),
      sessionGrants: nullGrants(),
      recordHistoryAutoApprove: async () => {},
    });
    const pending = gate.request(
      { id: "unattributed", name: "notes.create", args: { notePath: "Inbox/test.md" } },
      "safe",
      "preview",
      new AbortController().signal,
      { clientIdentity: "codex" },
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(() => gate.resolve("unattributed", { approved: true })).toThrow("authenticated human");
    expect(gate.listPending()).toHaveLength(1);
    gate.resolve("unattributed", { approved: false, reason: "cancelled" });
    expect((await pending).approved).toBe(false);
  });

  test("safe mode resolves with approved=true on user.approve", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const gate = makeGate(recorder);
    const controller = new AbortController();
    const call = makeCall();
    const promise = gate.request(call, "safe", "preview body", controller.signal, HUMAN_CONTEXT);
    await advanceGrantLookup();
    expect(gate.hasPending()).toBe(true);
    expect(recorder.pending).toHaveLength(1);
    expect(recorder.pending[0].callId).toBe("call-1");
    expect(recorder.pending[0].preview).toBe("preview body");
    gate.resolve(
      "call-1",
      { approved: true },
      { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
    );
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
    const promise = gate.request(makeCall(), "safe", "preview", controller.signal, HUMAN_CONTEXT);
    await advanceGrantLookup();
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
    const decision = await gate.request(
      makeCall(),
      "yolo",
      "preview",
      controller.signal,
      HUMAN_CONTEXT,
    );
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
    const promise = gate.request(makeCall(), "safe", "preview", controller.signal, HUMAN_CONTEXT);
    await advanceGrantLookup();
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
      await gate.request(makeCall(), "safe", "preview", controller.signal, HUMAN_CONTEXT);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).name).toBe("AbortError");
    expect(gate.hasPending()).toBe(false);
  });

  test("abort during grant lookup cannot create a pending approval", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const lookup = deferred<SessionGrant | null>();
    const gate = makeGate(recorder, false, {
      claim: () => lookup.promise,
    });
    const controller = new AbortController();

    const request = gate.request(makeCall(), "safe", "preview", controller.signal, HUMAN_CONTEXT);
    controller.abort();

    let caught: unknown = null;
    try {
      await request;
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).name).toBe("AbortError");
    expect(gate.hasPending()).toBe(false);
    expect(
      gate.resolve(
        "call-1",
        { approved: true },
        { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
      ),
    ).toBe(false);
    expect(recorder.pending).toEqual([]);
    expect(recorder.resolved).toEqual([]);
    lookup.resolve(null);
  });

  test("abort during atomic grant claim cannot return an approved decision", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const claim = deferred<SessionGrant | null>();
    let claimStarted = false;
    const gate = makeGate(recorder, false, {
      claim: () => {
        claimStarted = true;
        return claim.promise;
      },
    });
    const controller = new AbortController();

    const request = gate.request(makeCall(), "safe", "preview", controller.signal, HUMAN_CONTEXT);
    await advanceGrantLookup();
    expect(claimStarted).toBe(true);
    controller.abort();

    let caught: unknown = null;
    try {
      await request;
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).name).toBe("AbortError");
    expect(gate.hasPending()).toBe(false);
    expect(recorder.pending).toEqual([]);
    expect(recorder.resolved).toEqual([]);
    claim.resolve(makeStubGrant({ id: sessionId(41) }));
  });

  test("resolve cleans up handler so further resolves are no-ops", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const gate = makeGate(recorder);
    const controller = new AbortController();
    const promise = gate.request(makeCall(), "safe", "preview", controller.signal, HUMAN_CONTEXT);
    await advanceGrantLookup();
    expect(
      gate.resolve(
        "call-1",
        { approved: true },
        { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
      ),
    ).toBe(true);
    await promise;
    expect(gate.resolve("call-1", { approved: false, reason: "ignored" })).toBe(false);
    expect(recorder.resolved).toHaveLength(1);
  });

  test("resolve reports false for unknown call ids", () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const gate = makeGate(recorder);
    expect(
      gate.resolve(
        "missing",
        { approved: true },
        { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
      ),
    ).toBe(false);
    expect(recorder.resolved).toHaveLength(0);
  });

  test("cancelAll resolves every pending entry as rejected with the supplied reason", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const gate = makeGate(recorder);
    const controller = new AbortController();
    const p1 = gate.request(makeCall("a"), "safe", "p1", controller.signal, HUMAN_CONTEXT);
    const p2 = gate.request(makeCall("b"), "safe", "p2", controller.signal, HUMAN_CONTEXT);
    await advanceGrantLookup();
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
    const promise = gate.request(makeCall(), "safe", "preview", controller.signal, HUMAN_CONTEXT);
    await advanceGrantLookup();
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
    void gate
      .request(makeCall("a"), "safe", "p1", controller.signal, HUMAN_CONTEXT)
      .catch(() => {});
    void gate
      .request(makeCall("b"), "safe", "p2", controller.signal, HUMAN_CONTEXT)
      .catch(() => {});
    await advanceGrantLookup();
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
      recordHistoryAutoApprove: async (call) => {
        recorder.autoApproved.push(call);
      },
      perToolPolicy: () => ({ "vault.read_note": "auto" }),
      sessionGrants: nullGrants(),
    });
    gate.subscribe(events);
    const controller = new AbortController();
    const decision = await gate.request(
      { id: "c1", name: "vault.read_note", args: {} },
      "safe",
      "preview",
      controller.signal,
      HUMAN_CONTEXT,
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
      recordHistoryAutoApprove: async () => {},
      perToolPolicy: () => ({ "obsidian.eval": "ask" }),
      sessionGrants: nullGrants(),
    });
    gate.subscribe(events);
    const controller = new AbortController();
    const promise = gate.request(
      { id: "c2", name: "obsidian.eval", args: { code: "1" } },
      "yolo",
      "preview",
      controller.signal,
      HUMAN_CONTEXT,
    );
    await advanceGrantLookup();
    expect(gate.hasPending()).toBe(true);
    gate.resolve(
      "c2",
      { approved: true },
      { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
    );
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
  test("rejects an empty client identity before consulting grants", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const grants = recordingGrants(null);
    const gate = makeGate(recorder, false, grants);

    await expect(
      gate.request(
        { id: "c1", name: "notes.create", args: { notePath: "Inbox/today.md" } },
        "safe",
        "preview",
        new AbortController().signal,
        { clientIdentity: "" },
      ),
    ).rejects.toThrow("authenticated clientIdentity");
    expect(grants.claimQueries).toEqual([]);
    expect(gate.hasPending()).toBe(false);
  });

  test("active grant yields an accepted decision with its typed sessionId", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const grants = recordingGrants(makeStubGrant({ id: sessionId(42) }));
    const gate = makeGate(recorder, false, grants);
    const decision = await gate.request(
      { id: "c1", name: "notes.create", args: { notePath: "Inbox/today.md" } },
      "safe",
      "preview",
      new AbortController().signal,
      { clientIdentity: "claude-code" },
    );
    expect(decision.approved).toBe(true);
    expect(decision.reason).toBeUndefined();
    expect(decision.sessionId).toBe(sessionId(42));
    expect(grants.claimQueries).toHaveLength(1);
    expect(grants.claimQueries[0]).toMatchObject({
      client: "claude-code",
      tool: "notes.create",
      folder: "Inbox/",
    });
    // Session-grant approvals do NOT invoke recordHistoryAutoApprove; that
    // recorder is reserved for yolo-mode auto decisions so /history can show the
    // distinct kinds.
    expect(recorder.autoApproved).toHaveLength(0);
    expect(recorder.pending).toHaveLength(0);
    expect(recorder.resolved).toEqual([
      { callId: "c1", approved: true, reason: undefined, sessionId: sessionId(42) },
    ]);
  });

  test("grant lookup uses full parent folder for narrow scratch scopes", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const grants = recordingGrants(makeStubGrant({ id: sessionId(43) }));
    const gate = makeGate(recorder, false, grants);
    await gate.request(
      {
        id: "c1",
        name: "notes.create",
        args: { notePath: "Notient/live-battle-test/scratch.md" },
      },
      "safe",
      "preview",
      new AbortController().signal,
      { clientIdentity: "codex-battle" },
    );
    expect(grants.claimQueries[0]).toMatchObject({
      client: "codex-battle",
      tool: "notes.create",
      folder: "Notient/live-battle-test/",
    });
  });

  test("uses the required authenticated identity for the grant lookup", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const grants = recordingGrants(null);
    const gate = makeGate(recorder, false, grants);
    const promise = gate.request(
      { id: "c1", name: "notes.create", args: { notePath: "Inbox/today.md" } },
      "safe",
      "preview",
      new AbortController().signal,
      HUMAN_CONTEXT,
    );
    await advanceGrantLookup();
    // Resolve so we don't leak the pending entry; the assertion below is on
    // the claim query the gate already submitted.
    gate.resolve(
      "c1",
      { approved: true },
      { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
    );
    await promise;
    expect(grants.claimQueries[0].client).toBe(HUMAN_CONTEXT.clientIdentity);
  });

  test("grant excludes call.name via allowedTools -> falls through to per-tool policy", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    // `claim` returns null because the SessionGrants service filters allowedTools
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
    expect(decision.sessionId).toBeUndefined();
  });

  test("exhausted grant -> claim returns null -> falls through", async () => {
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
    expect(recorder.autoApproved).toHaveLength(1);
  });

  test("expired grant -> claim returns null -> falls through", async () => {
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
  });

  test("revoked grant -> claim returns null -> falls through", async () => {
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
    await advanceGrantLookup();
    expect(gate.hasPending()).toBe(true);
    gate.resolve(
      "c1",
      { approved: true },
      { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
    );
    const decision = await promise;
    expect(decision.approved).toBe(true);
    expect(decision.sessionId).toBeUndefined();
  });

  test("performs exactly one atomic claim per auto-approved call", async () => {
    const recorder: Recorder = { pending: [], resolved: [], autoApproved: [] };
    const grants = recordingGrants(makeStubGrant({ id: sessionId(99) }));
    const gate = makeGate(recorder, false, grants);
    await gate.request(
      { id: "c1", name: "notes.create", args: { notePath: "Inbox/a.md" } },
      "safe",
      "preview",
      new AbortController().signal,
      { clientIdentity: "claude-code" },
    );
    expect(grants.claimQueries).toHaveLength(1);
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
      recordHistoryAutoApprove: async () => {},
      perToolPolicy: () => ({}),
      sessionGrants: grants,
      now: () => 1_234_567,
    });
    gate.subscribe(events);
    const promise = gate.request(
      { id: "c1", name: "notes.create", args: { notePath: "Inbox/a.md" } },
      "safe",
      "preview",
      new AbortController().signal,
      { clientIdentity: "claude-code" },
    );
    await advanceGrantLookup();
    gate.resolve(
      "c1",
      { approved: true },
      { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
    );
    await promise;
    expect(grants.claimQueries[0].now).toBe(1_234_567);
  });
});

describe("extractFolder", () => {
  test("returns parent folder with trailing slash for nested paths", () => {
    expect(extractFolder("Inbox/today.md")).toBe("Inbox/");
    expect(extractFolder("Notient/agent-asks/auth.md")).toBe("Notient/agent-asks/");
    expect(extractFolder("Notient/live-battle-test/scratch.md")).toBe("Notient/live-battle-test/");
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
