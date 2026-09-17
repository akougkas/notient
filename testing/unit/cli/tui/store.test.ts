import { describe, expect, test } from "bun:test";
import {
  type Action,
  type AppState,
  STREAM_MAX_EVENTS,
  initialState,
  isTyping,
  reducer,
} from "../../../../src/cli/tui/store";
import type {
  AgentEventWire,
  DaemonStatusResult,
  ExtractionItemWire,
  NeighborWire,
  PendingApprovalWire,
  ProposalWire,
  VaultStatsResult,
} from "../../../../src/daemon/wire";
import { currentIndexingFixture } from "../../../indexingFixture";

const VAULT = "/tmp/vault";

function apply(actions: Action[], from: AppState = initialState(VAULT)): AppState {
  return actions.reduce(reducer, from);
}

function proposal(overrides: Partial<ProposalWire> = {}): ProposalWire {
  return {
    id: "supports:aaaaaaaaaaaaaaaaaaaa",
    table: "supports",
    fromNotePath: "a.md",
    toNotePath: "b.md",
    confidence: 0.8,
    source: "linker",
    agent: "linker",
    createdAt: 1,
    evidence: [],
    ...overrides,
  };
}

function approval(overrides: Partial<PendingApprovalWire> = {}): PendingApprovalWire {
  return {
    callId: "call-1",
    tool: "notes.append",
    preview: "+ hello",
    path: "b.md",
    requestedBy: "human",
    requestedAt: 10,
    ...overrides,
  };
}

const STATUS: DaemonStatusResult = {
  indexing: currentIndexingFixture(),
  httpEndpoint: "http://127.0.0.1:12345",
  vaultId: "0123456789abcdef",
  ok: true,
  vault: VAULT,
  pid: 1,
  socketPath: "/tmp/sock",
  startedAt: 0,
  version: "0.1.0-alpha",
  sealed: true,
  visionReady: false,
  probe: {
    endpoint: "http://localhost:1234/v1",
    configuredModel: "m",
    loadedModel: "m",
    configuredContextTokens: 8000,
    parallelSlots: 1,
    requestedTotalContextTokens: 8000,
    loadedContextLength: 8000,
    status: "ok",
    message: "ok",
  },
};

const STATS: VaultStatsResult = {
  ok: true,
  notes: 3,
  blocks: 9,
  chunks: 12,
  concepts: 4,
  claims: 2,
  questions: 1,
  wikilinks: 5,
  typedEdges: [
    { table: "supports", approved: 1, pending: 2 },
    { table: "contradicts", approved: 0, pending: 0 },
    { table: "extends", approved: 0, pending: 0 },
    { table: "exemplifies", approved: 0, pending: 0 },
    { table: "synthesizes", approved: 0, pending: 0 },
    { table: "related_to", approved: 3, pending: 1 },
  ],
  typedEdgesApproved: 4,
  typedEdgesPending: 3,
  pendingApprovals: 1,
  awaken: null,
};

describe("initialState", () => {
  test("starts on Ask with the composer focused and nothing loaded", () => {
    const state = initialState(VAULT);
    expect(state.view).toBe("ask");
    expect(state.stats).toBeNull();
    expect(state.status).toBeNull();
    expect(state.ask.composerMode).toBe("editing");
    expect(state.connection.connected).toBe(true);
    expect(state.prompt.kind).toBeNull();
  });
});

describe("view actions", () => {
  test("view/set switches and closes any open prompt", () => {
    const state = apply([
      { type: "prompt/open", kind: "command" },
      { type: "view/set", view: "inbox" },
    ]);
    expect(state.view).toBe("inbox");
    expect(state.prompt.kind).toBeNull();
  });

  test("view/set to the same view is a no-op identity", () => {
    const before = initialState(VAULT);
    expect(reducer(before, { type: "view/set", view: "ask" })).toBe(before);
  });

  test("view/set to ask focuses the composer; leaving ask blurs it", () => {
    const inAsk = apply([{ type: "view/set", view: "ask" }]);
    expect(inAsk.ask.composerMode).toBe("editing");
    expect(reducer(inAsk, { type: "view/set", view: "stream" }).ask.composerMode).toBe(
      "navigation",
    );
  });

  test("view/cycle wraps forwards and backwards", () => {
    const forward = apply([
      { type: "view/set", view: "stream" },
      { type: "view/cycle", delta: 1 },
    ]);
    expect(forward.view).toBe("home");
    expect(reducer(forward, { type: "view/cycle", delta: -1 }).view).toBe("stream");
  });

  test("Home to Inbox to Home preserves vault stats independently of the bounded queue", () => {
    const home = apply([
      { type: "stats/loaded", stats: STATS },
      { type: "inbox/loaded", proposals: [proposal()], approvals: [] },
    ]);
    const inbox = reducer(home, { type: "view/set", view: "inbox" });
    const returned = reducer(inbox, { type: "view/set", view: "home" });

    expect(inbox.stats).toBe(STATS);
    expect(inbox.inbox.proposals).toHaveLength(1);
    expect(returned.stats).toBe(STATS);
    expect(returned.inbox.proposals).toHaveLength(1);
  });
});

describe("connection actions", () => {
  test("conn/lost records the reason and clears the reconnecting flag", () => {
    const state = apply([{ type: "conn/lost", reason: "socket closed" }]);
    expect(state.connection).toEqual({
      connected: false,
      reason: "socket closed",
      reconnecting: false,
    });
  });

  test("conn/reconnecting then conn/restored clears the banner", () => {
    const mid = apply([{ type: "conn/lost", reason: "x" }, { type: "conn/reconnecting" }]);
    expect(mid.connection.reconnecting).toBe(true);
    expect(reducer(mid, { type: "conn/restored" }).connection).toEqual({
      connected: true,
      reason: null,
      reconnecting: false,
    });
  });
});

describe("status, health and stats", () => {
  test("status/loaded stores the daemon status", () => {
    expect(apply([{ type: "status/loaded", status: STATUS }]).status).toEqual(STATUS);
  });

  test("health/loaded stores endpoints", () => {
    const state = apply([{ type: "health/loaded", endpoints: [{ label: "primary", ok: true }] }]);
    expect(state.endpoints).toEqual([{ label: "primary", ok: true }]);
  });

  test("stats/loaded clears a previous stats error", () => {
    const state = apply([
      { type: "stats/failed", message: "boom" },
      { type: "stats/loaded", stats: STATS },
    ]);
    expect(state.stats).toEqual(STATS);
    expect(state.statsError).toBeNull();
  });

  test("stats/failed leaves the last good stats on screen", () => {
    const state = apply([
      { type: "stats/loaded", stats: STATS },
      { type: "stats/failed", message: "no substrate" },
    ]);
    expect(state.stats).toEqual(STATS);
    expect(state.statsError).toBe("no substrate");
  });
});

describe("inbox actions", () => {
  test("inbox/loaded marks the list loaded and clamps the cursor", () => {
    const state = apply([
      {
        type: "inbox/loaded",
        proposals: [proposal(), proposal({ id: "supports:bbbbbbbbbbbbbbbbbbbb" })],
        approvals: [],
      },
      { type: "inbox/move", delta: 5 },
      { type: "inbox/loaded", proposals: [proposal()], approvals: [] },
    ]);
    expect(state.inbox.loaded).toBe(true);
    expect(state.inbox.cursor).toBe(0);
  });

  test("inbox/move clamps to the row count and never goes negative", () => {
    const loaded = apply([
      { type: "inbox/loaded", proposals: [proposal()], approvals: [approval()] },
    ]);
    expect(reducer(loaded, { type: "inbox/move", delta: 9 }).inbox.cursor).toBe(1);
    expect(reducer(loaded, { type: "inbox/move", delta: -9 }).inbox.cursor).toBe(0);
  });

  test("inbox cursor is bounded by the filtered queue", () => {
    const filtered = apply([
      {
        type: "inbox/loaded",
        proposals: [
          proposal({ id: "supports:vvvvvvvvvvvvvvvvvvvv", toNotePath: "rare-target.md" }),
          proposal({ id: "supports:hhhhhhhhhhhhhhhhhhhh", toNotePath: "ordinary.md" }),
        ],
        approvals: [approval({ path: "ordinary.md" })],
      },
      { type: "inbox/filter", filter: "rare-target" },
      { type: "inbox/move", delta: 99 },
    ]);

    expect(filtered.inbox.cursor).toBe(0);
  });

  test("inbox/filter resets the cursor", () => {
    const state = apply([
      {
        type: "inbox/loaded",
        proposals: [proposal(), proposal({ id: "supports:bbbbbbbbbbbbbbbbbbbb" })],
        approvals: [],
      },
      { type: "inbox/move", delta: 1 },
      { type: "inbox/filter", filter: "supports" },
    ]);
    expect(state.inbox.filter).toBe("supports");
    expect(state.inbox.cursor).toBe(0);
  });

  test("inbox/drop removes a proposal or an approval by id", () => {
    const loaded = apply([
      { type: "inbox/loaded", proposals: [proposal()], approvals: [approval()] },
    ]);
    expect(
      reducer(loaded, { type: "inbox/drop", id: "supports:aaaaaaaaaaaaaaaaaaaa" }).inbox.proposals,
    ).toHaveLength(0);
    expect(reducer(loaded, { type: "inbox/drop", id: "call-1" }).inbox.approvals).toHaveLength(0);
  });

  test("inbox/failed records the message", () => {
    expect(apply([{ type: "inbox/failed", message: "down" }]).inbox.error).toBe("down");
  });
});

describe("ask actions", () => {
  test("ask/session stores the conversation", () => {
    const state = apply([{ type: "ask/session", conversationId: "c1", topic: "TUI session" }]);
    expect(state.ask.conversationId).toBe("c1");
    expect(state.ask.topic).toBe("TUI session");
  });

  test("ask/assistantDelta grows one streaming line instead of appending many", () => {
    const state = apply([
      { type: "ask/assistantDelta", text: "hel" },
      { type: "ask/assistantDelta", text: "lo" },
    ]);
    expect(state.ask.lines).toEqual([{ kind: "assistant", text: "hello", streaming: true }]);
  });

  test("ask/line after a delta starts a new row", () => {
    const state = apply([
      { type: "ask/assistantDelta", text: "hi" },
      { type: "ask/line", line: { kind: "user", text: "again" } },
      { type: "ask/assistantDelta", text: "yo" },
    ]);
    expect(state.ask.lines).toHaveLength(3);
  });

  test("ask/reset clears the transcript and citations", () => {
    const state = apply([
      { type: "ask/assistantDelta", text: "hi" },
      { type: "ask/turnDone", tokens: 1, citations: ["a.md"] },
      { type: "ask/reset", line: { kind: "system", text: "cleared" } },
    ]);
    expect(state.ask.lines).toEqual([{ kind: "system", text: "cleared" }]);
    expect(state.ask.citations).toEqual([]);
  });

  test("ask/busy and ask/turnDone bracket a turn", () => {
    const busy = apply([{ type: "ask/busy", busy: true }]);
    expect(busy.ask.busy).toBe(true);
    const done = reducer(busy, { type: "ask/turnDone", tokens: 42, citations: ["a.md", "b.md"] });
    expect(done.ask.busy).toBe(false);
    expect(done.ask.lastTurnTokens).toBe(42);
    expect(done.ask.citations).toEqual(["a.md", "b.md"]);
    expect(done.ask.citationCursor).toBe(0);
    expect(done.ask.composerMode).toBe("editing");
  });

  test("ask/model records the model the loop reported", () => {
    expect(apply([{ type: "ask/model", model: "qwen" }]).ask.model).toBe("qwen");
  });

  test("approval pending and resolved add and remove the call id", () => {
    const pending = apply([{ type: "ask/approvalPending", callId: "c", tool: "notes.append" }]);
    expect(pending.ask.pendingApprovals.get("c")).toBe("notes.append");
    expect(
      reducer(pending, { type: "ask/approvalResolved", callId: "c" }).ask.pendingApprovals.size,
    ).toBe(0);
  });

  test("ask/citationMove clamps to the citation list", () => {
    const withCitations = apply([{ type: "ask/turnDone", tokens: 1, citations: ["a.md", "b.md"] }]);
    expect(reducer(withCitations, { type: "ask/citationMove", delta: 5 }).ask.citationCursor).toBe(
      1,
    );
  });

  test("editing after a turn keeps the composer focused", () => {
    const done = apply([{ type: "ask/turnDone", tokens: 1, citations: [] }]);
    const typed = reducer(done, { type: "ask/buffer", buffer: "w" });
    const erased = reducer(typed, { type: "ask/buffer", buffer: "" });
    expect(typed.ask.buffer).toBe("w");
    expect(typed.ask.composerMode).toBe("editing");
    expect(erased.ask.composerMode).toBe("editing");
  });

  test("ask/composer switches explicitly between editing and navigation", () => {
    const navigating = apply([{ type: "ask/composer", mode: "navigation" }]);
    expect(navigating.ask.composerMode).toBe("navigation");
    expect(reducer(navigating, { type: "ask/composer", mode: "editing" }).ask.composerMode).toBe(
      "editing",
    );
  });
});

describe("explore actions", () => {
  const item: ExtractionItemWire = {
    id: "concept:1",
    text: "vector search",
    kind: "topic",
    confidence: 0.9,
    evidence: [],
  };
  const neighbor: NeighborWire = {
    notePath: "b.md",
    table: "supports",
    direction: "outgoing",
    agent: "linker",
    confidence: 0.7,
    proposed: false,
  };

  test("explore/open resets the previous note entirely", () => {
    const state = apply([
      { type: "explore/open", notePath: "a.md" },
      { type: "explore/body", body: "old" },
      { type: "explore/open", notePath: "b.md" },
    ]);
    expect(state.explore.notePath).toBe("b.md");
    expect(state.explore.body).toBeNull();
    expect(state.explore.loading).toBe(true);
  });

  test("explore/body clears the loading flag", () => {
    const state = apply([
      { type: "explore/open", notePath: "a.md" },
      { type: "explore/body", body: "# hi" },
    ]);
    expect(state.explore.body).toBe("# hi");
    expect(state.explore.loading).toBe(false);
  });

  test("explore/extraction stores the three groups", () => {
    const state = apply([
      { type: "explore/extraction", concepts: [item], claims: [], questions: [item] },
    ]);
    expect(state.explore.concepts).toHaveLength(1);
    expect(state.explore.questions).toHaveLength(1);
  });

  test("explore/neighbors clamps a stale cursor", () => {
    const state = apply([
      { type: "explore/neighbors", neighbors: [neighbor, { ...neighbor, notePath: "c.md" }] },
      { type: "explore/move", delta: 1 },
      { type: "explore/neighbors", neighbors: [neighbor] },
    ]);
    expect(state.explore.neighborCursor).toBe(0);
  });

  test("explore/pane cycles the three columns both ways", () => {
    const right = apply([{ type: "explore/pane", delta: 1 }]);
    expect(right.explore.pane).toBe("view");
    expect(reducer(initialState(VAULT), { type: "explore/pane", delta: -1 }).explore.pane).toBe(
      "neighbors",
    );
  });

  test("explore/scroll never goes above the top of the body", () => {
    expect(apply([{ type: "explore/scroll", delta: -4 }]).explore.bodyScroll).toBe(0);
    expect(apply([{ type: "explore/scroll", delta: 7 }]).explore.bodyScroll).toBe(7);
  });

  test("explore/failed surfaces the message and stops loading", () => {
    const state = apply([
      { type: "explore/open", notePath: "a.md" },
      { type: "explore/failed", message: "not found" },
    ]);
    expect(state.explore.error).toBe("not found");
    expect(state.explore.loading).toBe(false);
  });

  test("an unresolved Ask citation shows a notice without blanking populated Explore", () => {
    const populated = apply([
      { type: "explore/open", notePath: "notes/kept.md" },
      { type: "explore/body", body: "# Keep me" },
      { type: "view/set", view: "ask" },
    ]);
    const state = reducer(populated, {
      type: "ask/citationUnresolved",
      target: "[[Missing]]",
    });

    expect(state.notice).toBe("citation did not resolve: [[Missing]]");
    expect(state.view).toBe("ask");
    expect(state.explore).toBe(populated.explore);
    expect(state.explore.notePath).toBe("notes/kept.md");
    expect(state.explore.body).toBe("# Keep me");
  });
});

describe("stream actions", () => {
  const event = (id: number): AgentEventWire => ({
    id: eventId(id),
    ts: id * 1000,
    type: "swarm:link_proposed",
    payload: {},
  });

  const eventId = (id: number): string =>
    `agent_event:u"00000000-0000-4000-8000-${id.toString().padStart(12, "0")}"`;

  test("stream/events appends and advances the cursor", () => {
    const state = apply([
      { type: "stream/events", events: [event(1), event(2)], cursor: eventId(2) },
    ]);
    expect(state.stream.events).toHaveLength(2);
    expect(state.stream.cursor).toBe(eventId(2));
  });

  test("an empty batch still moves the cursor", () => {
    const state = apply([{ type: "stream/events", events: [], cursor: eventId(9) }]);
    expect(state.stream.events).toHaveLength(0);
    expect(state.stream.cursor).toBe(eventId(9));
  });

  test("repeated and overlapping batches deduplicate by event id", () => {
    const state = apply([
      { type: "stream/events", events: [event(1), event(2)], cursor: eventId(2) },
      {
        type: "stream/events",
        events: [event(2), { ...event(3), type: "indexer:note-indexed" }, event(3)],
        cursor: eventId(3),
      },
    ]);
    expect(state.stream.events.map((entry) => entry.id)).toEqual([
      eventId(1),
      eventId(2),
      eventId(3),
    ]);
    expect(state.stream.events[2]?.type).toBe("swarm:link_proposed");
  });

  test("out-of-order responses neither reorder storage nor move the cursor backwards", () => {
    const state = apply([
      { type: "stream/events", events: [event(5)], cursor: eventId(5) },
      { type: "stream/events", events: [event(3), event(4)], cursor: eventId(4) },
    ]);
    expect(state.stream.events.map((entry) => entry.id)).toEqual([
      eventId(3),
      eventId(4),
      eventId(5),
    ]);
    expect(state.stream.cursor).toBe(eventId(5));
  });

  test("the tail is capped so a long session cannot grow without bound", () => {
    const events = Array.from({ length: STREAM_MAX_EVENTS + 25 }, (_unused, index) =>
      event(index + 1),
    );
    const state = apply([{ type: "stream/events", events, cursor: eventId(events.length) }]);
    expect(state.stream.events).toHaveLength(STREAM_MAX_EVENTS);
    expect(state.stream.events[0]?.id).toBe(eventId(26));
  });

  test("stream/filter stores the needle", () => {
    expect(apply([{ type: "stream/filter", filter: "indexer" }]).stream.filter).toBe("indexer");
  });
});

describe("prompt actions", () => {
  test("prompt/open sets the kind and an optional seed buffer", () => {
    const state = apply([{ type: "prompt/open", kind: "inbox-filter", buffer: "sup" }]);
    expect(state.prompt.kind).toBe("inbox-filter");
    expect(state.prompt.buffer).toBe("sup");
  });

  test("a filter prompt mirrors its buffer into the view as it is typed", () => {
    const inbox = apply([
      { type: "prompt/open", kind: "inbox-filter" },
      { type: "prompt/buffer", buffer: "contra" },
    ]);
    expect(inbox.inbox.filter).toBe("contra");
    const stream = apply([
      { type: "prompt/open", kind: "stream-filter" },
      { type: "prompt/buffer", buffer: "err" },
    ]);
    expect(stream.stream.filter).toBe("err");
  });

  test("a command prompt does not touch any view filter", () => {
    const state = apply([
      { type: "prompt/open", kind: "command" },
      { type: "prompt/buffer", buffer: "proposals" },
    ]);
    expect(state.inbox.filter).toBe("");
    expect(state.stream.filter).toBe("");
  });

  test("prompt/matches clamps the candidate cursor", () => {
    const state = apply([
      { type: "prompt/open", kind: "note-picker" },
      { type: "prompt/matches", matches: ["a.md", "b.md", "c.md"] },
      { type: "prompt/move", delta: 2 },
      { type: "prompt/matches", matches: ["a.md"] },
    ]);
    expect(state.prompt.cursor).toBe(0);
  });

  test("prompt/move clamps to the candidate list", () => {
    const state = apply([
      { type: "prompt/open", kind: "note-picker" },
      { type: "prompt/matches", matches: ["a.md", "b.md"] },
      { type: "prompt/move", delta: 9 },
    ]);
    expect(state.prompt.cursor).toBe(1);
  });

  test("prompt/close clears everything about the prompt", () => {
    const state = apply([
      { type: "prompt/open", kind: "command", buffer: "help" },
      { type: "prompt/close" },
    ]);
    expect(state.prompt).toEqual({ kind: null, buffer: "", matches: [], cursor: 0 });
  });
});

describe("command output, notice and exit", () => {
  test("command/output keeps the newest 40 lines", () => {
    const actions: Action[] = Array.from({ length: 45 }, (_unused, index) => ({
      type: "command/output" as const,
      text: `line-${index}`,
    }));
    const state = apply(actions);
    expect(state.commandOutput).toHaveLength(40);
    expect(state.commandOutput[0]).toBe("line-5");
  });

  test("notice sets and clears", () => {
    const set = apply([{ type: "notice", text: "hi" }]);
    expect(set.notice).toBe("hi");
    expect(reducer(set, { type: "notice", text: null }).notice).toBeNull();
  });

  test("switching views clears a stale notice", () => {
    const state = apply([
      { type: "notice", text: "hi" },
      { type: "view/set", view: "stream" },
    ]);
    expect(state.notice).toBeNull();
  });

  test("exit flags the app", () => {
    expect(apply([{ type: "exit" }]).exiting).toBe(true);
  });
});

describe("isTyping", () => {
  test("an open prompt owns the keyboard in every view", () => {
    const state = apply([
      { type: "view/set", view: "inbox" },
      { type: "prompt/open", kind: "inbox-filter" },
    ]);
    expect(isTyping(state)).toBe(true);
  });

  test("Ask owns the keyboard after answering until explicit navigation", () => {
    const focused = apply([{ type: "view/set", view: "ask" }]);
    expect(isTyping(focused)).toBe(true);
    const postTurn = reducer(focused, { type: "ask/turnDone", tokens: 1, citations: [] });
    expect(isTyping(postTurn)).toBe(true);
    expect(isTyping(reducer(postTurn, { type: "ask/composer", mode: "navigation" }))).toBe(false);
  });

  test("Home never types", () => {
    expect(isTyping(apply([{ type: "view/set", view: "home" }]))).toBe(false);
  });
});
