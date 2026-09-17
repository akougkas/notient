import { describe, expect, test } from "bun:test";
import type { ClientHandle, RpcResponseFrame } from "../../../../src/cli/client";
import { RpcCallError, createRpc, isDisconnect } from "../../../../src/cli/tui/rpc";
import { editBuffer } from "../../../../src/cli/tui/runtime";
import { graphNeighborsFixture } from "../../../graphFixture";
import { currentCoverageFixture } from "../../../indexingFixture";

interface Captured {
  method: string;
  params: Record<string, unknown>;
}

function makeClient(respond: (method: string) => RpcResponseFrame[] | Error): {
  handle: ClientHandle;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const handle: ClientHandle = {
    principal: { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
    call(method, params): AsyncIterable<RpcResponseFrame> {
      calls.push({ method, params });
      const outcome = respond(method);
      return (async function* () {
        if (outcome instanceof Error) throw outcome;
        for (const frame of outcome) yield frame;
      })();
    },
    close: async () => {},
  };
  return { handle, calls };
}

const result = (payload: Record<string, unknown>): RpcResponseFrame[] => [
  { id: "1", type: "result", ...payload },
];

test("TUI stop is scoped to its connection and validates the cancellation receipt", async () => {
  const { handle, calls } = makeClient(() => result({ ok: true, aborted: true }));
  expect(await createRpc(handle).chatAbort()).toEqual({ ok: true, aborted: true });
  expect(calls).toEqual([{ method: "chat.abort", params: {} }]);
  const foreignScope = makeClient(() => result({ ok: true, aborted: true, scope: "all" }));
  await expect(createRpc(foreignScope.handle).chatAbort()).rejects.toThrow("wire integrity");
});

const PROPOSAL_ID = "supports:aaaaaaaaaaaaaaaaaaaa";
const HISTORY_ID = 'history:u"018f05cd-3f7b-7000-8000-000000000001"';
const AWAKEN_ID = 'awaken_run:u"018f05cd-3f7b-7000-8000-000000000002"';
const eventId = (value: number): string =>
  `agent_event:u"00000000-0000-4000-8000-${value.toString().padStart(12, "0")}"`;

const emptyEdgeCounts = [
  "supports",
  "contradicts",
  "extends",
  "exemplifies",
  "synthesizes",
  "related_to",
].map((table) => ({ table, approved: 0, pending: 0 }));

function emptyStats(notes = 0): Record<string, unknown> {
  return {
    ok: true,
    notes,
    blocks: 0,
    chunks: 0,
    concepts: 0,
    claims: 0,
    questions: 0,
    wikilinks: 0,
    typedEdges: emptyEdgeCounts,
    typedEdgesApproved: 0,
    typedEdgesPending: 0,
    pendingApprovals: 0,
    awaken: null,
  };
}

describe("createRpc method mapping", () => {
  test("daemon.model_catalog returns the typed private-boundary projection", async () => {
    const { handle, calls } = makeClient(() =>
      result({
        ok: true,
        source: "openai-compatible",
        models: [
          {
            id: "chat-model",
            type: "chat",
            state: "unknown",
            loadedContextLength: null,
          },
        ],
      }),
    );
    const catalog = await createRpc(handle).modelCatalog();
    expect(calls[0]?.method).toBe("daemon.model_catalog");
    expect(catalog.models[0]?.id).toBe("chat-model");
    expect(JSON.stringify(catalog)).not.toContain("apiKey");
  });

  test("vault.stats returns the typed result", async () => {
    const { handle, calls } = makeClient(() => result(emptyStats(4)));
    const stats = await createRpc(handle).vaultStats();
    expect(calls[0]?.method).toBe("vault.stats");
    expect(stats.notes).toBe(4);
  });

  test("links.proposals omits absent filters instead of sending undefined", async () => {
    const { handle, calls } = makeClient(() => result({ ok: true, proposals: [] }));
    const rpc = createRpc(handle);
    await rpc.proposalsList();
    expect(calls[0]?.params).toEqual({});
    await rpc.proposalsList({ notePath: "a.md", agent: "linker", limit: 10 });
    expect(calls[1]?.params).toEqual({ notePath: "a.md", agent: "linker", limit: 10 });
  });

  test("links.approve and reject carry the id and rejection reason", async () => {
    const { handle, calls } = makeClient((method) =>
      method === "links.approve"
        ? result({
            ok: true,
            edgeId: PROPOSAL_ID,
            table: "supports",
            found: true,
            historyId: HISTORY_ID,
            approvedBy: "human",
          })
        : result({
            ok: true,
            edgeId: PROPOSAL_ID,
            table: "supports",
            found: true,
            historyId: HISTORY_ID,
            reason: "duplicate idea",
          }),
    );
    const rpc = createRpc(handle);
    expect((await rpc.proposalsApprove(PROPOSAL_ID)).found).toBe(true);
    await rpc.proposalsReject(PROPOSAL_ID, "duplicate idea");
    expect(calls.map((call) => call.method)).toEqual(["links.approve", "links.reject"]);
    expect(calls[1]?.params).toEqual({ id: PROPOSAL_ID, reason: "duplicate idea" });
  });

  test("chat.approve uses the discriminated wire request", async () => {
    let response = 0;
    const { handle, calls } = makeClient(() => {
      response += 1;
      return response === 1
        ? result({ ok: true, callId: "call-1", approved: true })
        : result({ ok: true, callId: "call-2", approved: false, reason: "too risky" });
    });
    const rpc = createRpc(handle);
    await rpc.chatApprove({ callId: "call-1", approved: true });
    expect(calls[0]?.params).toEqual({ callId: "call-1", approved: true });
    await rpc.chatApprove({ callId: "call-2", approved: false, reason: "too risky" });
    expect(calls[1]?.params).toEqual({
      callId: "call-2",
      approved: false,
      reason: "too risky",
    });
  });

  test("vault.neighbors asks for pending edges only when told to", async () => {
    const { handle, calls } = makeClient(() => result(graphNeighborsFixture("a.md")));
    const rpc = createRpc(handle);
    await rpc.neighbors("a.md");
    expect(calls[0]?.params).toEqual({ path: "a.md", includeProposed: false });
    await rpc.neighbors("a.md", true);
    expect(calls[1]?.params).toEqual({ path: "a.md", includeProposed: true });
  });

  test("vault.resolve_link sends the selected citation as the canonical target parameter", async () => {
    const { handle, calls } = makeClient(() =>
      result({ ok: true, resolved: true, path: "notes/Alpha.md", selector: null }),
    );
    const resolved = await createRpc(handle).resolveLink("[[Alpha]]");
    expect(calls[0]).toEqual({
      method: "vault.resolve_link",
      params: { target: "[[Alpha]]" },
    });
    expect(resolved).toMatchObject({
      ok: true,
      resolved: true,
      path: "notes/Alpha.md",
      selector: null,
    });
  });

  test("agent.events polls without blocking the daemon on a long poll", async () => {
    const { handle, calls } = makeClient(() =>
      result({ ok: true, events: [], cursor: eventId(7), longPollExpired: false }),
    );
    const events = await createRpc(handle).agentEvents(eventId(3));
    expect(calls[0]?.params).toEqual({
      since: eventId(3),
      limit: 100,
      longPollMs: 0,
    });
    expect(events.cursor).toBe(eventId(7));
  });

  test("recent link proposals use the bounded snapshot contract", async () => {
    const { handle, calls } = makeClient(() =>
      result({ ok: true, events: [], cursor: eventId(9), longPollExpired: false }),
    );
    const events = await createRpc(handle).recentLinkProposals(1_700_000_000_000, 25);
    expect(calls[0]).toEqual({
      method: "agent.events",
      params: {
        snapshotSinceMs: 1_700_000_000_000,
        types: ["swarm:link_proposed"],
        limit: 25,
      },
    });
    expect(events.cursor).toBe(eventId(9));
  });

  test("awaken control verbs map onto their methods", async () => {
    const { handle, calls } = makeClient((method) =>
      method === "awaken.run"
        ? result({
            ok: true,
            queued: 3,
            tier: [1, 2, 3],
            runId: AWAKEN_ID,
            status: "running",
            background: true,
          })
        : result({
            ok: true,
            runId: AWAKEN_ID,
            processed: 1,
            failed: 0,
            total: 3,
            status: "paused",
            draining: true,
          }),
    );
    const rpc = createRpc(handle);
    await rpc.awaken({ background: true });
    await rpc.awakenControl("pause");
    expect(calls.map((call) => call.method)).toEqual(["awaken.run", "awaken.pause"]);
    expect(calls[0]?.params).toEqual({ background: true });
  });

  test("search.run defaults to balanced mode", async () => {
    const { handle, calls } = makeClient(() =>
      result({
        ok: true,
        result: {
          query: "query",
          mode: "balanced",
          hits: [],
          durationMs: 0,
          coverage: currentCoverageFixture(),
        },
      }),
    );
    await createRpc(handle).search("query");
    expect(calls[0]?.params).toEqual({ query: "query", mode: "balanced", limit: 8 });
  });

  test("search.run rejects a null terminal result", async () => {
    const { handle } = makeClient(() => result({ ok: true, result: null }));
    await expect(createRpc(handle).search("query")).rejects.toMatchObject({
      code: "WIRE_INTEGRITY",
    });
  });

  test("event frames before the result are drained, not returned", async () => {
    const { handle } = makeClient(() => [
      { id: "1", type: "event", event: "search:hits" },
      {
        id: "1",
        type: "result",
        ok: true,
        result: {
          query: "x",
          mode: "balanced",
          hits: [],
          durationMs: 0,
          coverage: currentCoverageFixture(),
        },
      },
    ]);
    const search = await createRpc(handle).search("x");
    expect(search.ok).toBe(true);
  });
});

describe("error mapping", () => {
  test("a handler error frame becomes RpcCallError with the daemon's code", async () => {
    const { handle } = makeClient(() => [
      {
        id: "1",
        type: "error",
        code: "METHOD_NOT_FOUND",
        message: "unknown method",
        detail: {},
      },
    ]);
    const error = await createRpc(handle)
      .vaultStats()
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(RpcCallError);
    expect((error as RpcCallError).code).toBe("METHOD_NOT_FOUND");
    expect((error as RpcCallError).method).toBe("vault.stats");
  });

  test("a malformed error frame is an explicit wire-integrity failure", async () => {
    const { handle } = makeClient(() => [{ id: "1", type: "error" }]);
    const error = (await createRpc(handle)
      .health()
      .catch((thrown: unknown) => thrown)) as RpcCallError;
    expect(error.code).toBe("WIRE_INTEGRITY");
    expect(error.message).toContain("wire integrity error");
  });

  test("a dead transport is reported as DAEMON_DISCONNECTED", async () => {
    const { handle } = makeClient(() => new Error("DAEMON_DISCONNECTED: socket closed"));
    const error = (await createRpc(handle)
      .status()
      .catch((thrown: unknown) => thrown)) as RpcCallError;
    expect(error.code).toBe("DAEMON_DISCONNECTED");
    expect(isDisconnect(error)).toBe(true);
  });

  test("a stream that ends without a terminal frame is a disconnect", async () => {
    const { handle } = makeClient(() => []);
    const error = (await createRpc(handle)
      .status()
      .catch((thrown: unknown) => thrown)) as RpcCallError;
    expect(error.code).toBe("DAEMON_DISCONNECTED");
  });

  test("an ordinary failure is not mistaken for a disconnect", async () => {
    const { handle } = makeClient(() => [
      { id: "1", type: "error", code: "INVALID_PARAMS", message: "bad", detail: {} },
    ]);
    const error = await createRpc(handle)
      .noteBody("x")
      .catch((thrown: unknown) => thrown);
    expect(isDisconnect(error)).toBe(false);
  });
});

describe("result integrity", () => {
  const proposal = (overrides: Record<string, unknown> = {}) => ({
    id: PROPOSAL_ID,
    table: "supports",
    fromNotePath: "a.md",
    toNotePath: "b.md",
    confidence: 1,
    source: "user",
    agent: "claude-code",
    createdAt: 1_700_000_000_000,
    evidence: [],
    ...overrides,
  });

  test("accepts explicit user proposals with authenticated provenance and no invented evidence", async () => {
    const { handle } = makeClient(() => result({ ok: true, proposals: [proposal()] }));
    const listed = await createRpc(handle).proposalsList();
    expect(listed.proposals[0]).toMatchObject({
      source: "user",
      agent: "claude-code",
      confidence: 1,
      evidence: [],
    });
  });

  test("accepts an autonomous linker proposal only with matching authority", async () => {
    const { handle } = makeClient(() =>
      result({
        ok: true,
        proposals: [proposal({ source: "linker", agent: "linker", confidence: 0.8 })],
      }),
    );
    const listed = await createRpc(handle).proposalsList();
    expect(listed.proposals[0]).toMatchObject({
      source: "linker",
      agent: "linker",
      confidence: 0.8,
    });
  });

  test.each([
    proposal({ confidence: 0.99 }),
    proposal({ evidence: [{ chunkId: "chunk:bbbbbbbbbbbbbbbbbbbb", text: "invented" }] }),
    proposal({ agent: "Claude Code" }),
    proposal({ source: "linker", agent: "claude-code", confidence: 0.8 }),
    proposal({ source: "legacy", agent: "legacy", confidence: 0.8 }),
  ])("rejects malformed proposal provenance %#", async (malformed) => {
    const { handle } = makeClient(() => result({ ok: true, proposals: [malformed] }));
    await expect(createRpc(handle).proposalsList()).rejects.toMatchObject({
      code: "WIRE_INTEGRITY",
    });
  });

  test("rejects a partial success result instead of manufacturing zero counts", async () => {
    const partial = emptyStats(4);
    partial.blocks = undefined;
    const { handle } = makeClient(() => result(partial));
    const error = (await createRpc(handle)
      .vaultStats()
      .catch((thrown: unknown) => thrown)) as RpcCallError;
    expect(error.code).toBe("WIRE_INTEGRITY");
    expect(error.message).toContain("at blocks");
  });

  test("rejects unknown result keys instead of preserving a legacy alias", async () => {
    const { handle } = makeClient(() => result({ ...emptyStats(), noteCount: 0 }));
    const error = (await createRpc(handle)
      .vaultStats()
      .catch((thrown: unknown) => thrown)) as RpcCallError;
    expect(error.code).toBe("WIRE_INTEGRITY");
    expect(error.message).toContain("Unrecognized key");
  });

  test("rejects null where the result contract requires an array", async () => {
    const { handle } = makeClient(() => result({ ok: true, endpoints: null }));
    const error = (await createRpc(handle)
      .health()
      .catch((thrown: unknown) => thrown)) as RpcCallError;
    expect(error.code).toBe("WIRE_INTEGRITY");
    expect(error.message).toContain("at endpoints");
  });

  test("rejects a neighbor answer for a different requested note", async () => {
    const { handle } = makeClient(() => result(graphNeighborsFixture("other.md")));
    const error = (await createRpc(handle)
      .neighbors("asked.md")
      .catch((thrown: unknown) => thrown)) as RpcCallError;
    expect(error.code).toBe("WIRE_INTEGRITY");
    expect(error.message).toContain("connection source or proposal scope mismatch");
  });

  test("rejects null optional awaken fields rather than treating null as omission", async () => {
    const { handle } = makeClient(() =>
      result({
        ok: true,
        queued: null,
        tier: [1, 2, 3],
        runId: AWAKEN_ID,
        status: "running",
        background: true,
      }),
    );
    const error = (await createRpc(handle)
      .awaken({ background: true })
      .catch((thrown: unknown) => thrown)) as RpcCallError;
    expect(error.code).toBe("WIRE_INTEGRITY");
    expect(error.message).toContain("awaken.run wire integrity error");
  });
});

describe("editBuffer", () => {
  test("appends printable characters", () => {
    expect(editBuffer("ab", { name: "c" })).toBe("abc");
    expect(editBuffer("ab", { name: "unknown", sequence: "/" })).toBe("ab/");
  });

  test("space and backspace behave", () => {
    expect(editBuffer("ab", { name: "space" })).toBe("ab ");
    expect(editBuffer("ab", { name: "backspace" })).toBe("a");
  });

  test("Ctrl+U clears and Ctrl+W kills the last word", () => {
    expect(editBuffer("hello world", { name: "u", ctrl: true })).toBe("");
    expect(editBuffer("hello world", { name: "w", ctrl: true })).toBe("hello ");
  });

  test("non-printing keys leave the buffer untouched", () => {
    expect(editBuffer("ab", { name: "f5" })).toBeNull();
    expect(editBuffer("ab", { name: "x", ctrl: true })).toBeNull();
  });
});
