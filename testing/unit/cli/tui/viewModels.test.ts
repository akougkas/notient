import { describe, expect, test } from "bun:test";
import { initialState, reducer } from "../../../../src/cli/tui/store";
import {
  buildAwakenCard,
  buildDiscoveryRows,
  buildEdgeBreakdown,
  buildInboxDetail,
  buildPendingCounts,
  buildStreamRows,
  buildTopBar,
  buildVitalsCards,
  exploreOpenTarget,
  extractCitations,
  flattenInbox,
  groupInbox,
  inboxGroupIds,
  inboxTarget,
  selectedInboxEntry,
  sortNeighbors,
  streamCountLabel,
} from "../../../../src/cli/tui/viewModels";
import type {
  AgentEventWire,
  NeighborWire,
  PendingApprovalWire,
  ProposalWire,
  VaultStatsResult,
} from "../../../../src/daemon/wire";

const AGENT_RUN_ID = 'agent_run:u"00000000-0000-4000-8000-000000000001"';

function proposal(overrides: Partial<ProposalWire> = {}): ProposalWire {
  return {
    id: "supports:aaaaaaaaaaaaaaaaaaaa",
    table: "supports",
    fromNotePath: "a.md",
    toNotePath: "target.md",
    confidence: 0.8,
    source: "linker",
    agent: "linker",
    createdAt: 1_700_000_000_000,
    evidence: [],
    ...overrides,
  };
}

function approval(overrides: Partial<PendingApprovalWire> = {}): PendingApprovalWire {
  return {
    callId: "call-1",
    tool: "notes.append",
    preview: "line one\nline two",
    path: "target.md",
    requestedBy: "human",
    requestedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function neighbor(overrides: Partial<NeighborWire> = {}): NeighborWire {
  return {
    notePath: "b.md",
    table: "supports",
    direction: "outgoing",
    agent: "linker",
    confidence: 0.5,
    proposed: false,
    ...overrides,
  };
}

const STATS: VaultStatsResult = {
  ok: true,
  notes: 12,
  blocks: 40,
  chunks: 90,
  concepts: 7,
  claims: 3,
  questions: 2,
  wikilinks: 21,
  typedEdges: [
    { table: "supports", approved: 2, pending: 1 },
    { table: "contradicts", approved: 0, pending: 0 },
    { table: "extends", approved: 0, pending: 0 },
    { table: "exemplifies", approved: 0, pending: 0 },
    { table: "synthesizes", approved: 0, pending: 0 },
    { table: "related_to", approved: 4, pending: 0 },
  ],
  typedEdgesApproved: 6,
  typedEdgesPending: 1,
  pendingApprovals: 2,
  awaken: null,
};

describe("buildVitalsCards", () => {
  test("returns nothing before the first reading rather than a grid of zeros", () => {
    expect(
      buildVitalsCards(null, { proposals: 0, approvals: 0, total: 0, status: "unknown" }),
    ).toEqual([]);
  });

  test("renders one card per counted table", () => {
    const cards = buildVitalsCards(STATS, {
      proposals: 1,
      approvals: 2,
      total: 3,
      status: "live",
    });
    expect(cards.map((card) => card.label)).toEqual([
      "notes",
      "blocks",
      "chunks",
      "concepts",
      "claims",
      "questions",
      "wikilinks",
      "typed edges",
      "pending",
      "approvals",
    ]);
    expect(cards[0]?.value).toBe("12");
    expect(cards.find((card) => card.label === "typed edges")?.value).toBe("6 approved");
  });
});

describe("buildEdgeBreakdown", () => {
  test("retains the canonical edge rows, including zero-count contradicts", () => {
    expect(buildEdgeBreakdown(STATS).map((row) => row.table)).toEqual([
      "supports",
      "contradicts",
      "extends",
      "exemplifies",
      "synthesizes",
      "related_to",
    ]);
    expect(buildEdgeBreakdown(STATS).find((row) => row.table === "contradicts")).toEqual({
      table: "contradicts",
      approved: 0,
      pending: 0,
    });
  });

  test("is empty without stats", () => {
    expect(buildEdgeBreakdown(null)).toEqual([]);
  });
});

describe("buildAwakenCard", () => {
  test("is null when no run has ever been recorded", () => {
    expect(buildAwakenCard(STATS)).toBeNull();
    expect(buildAwakenCard(null)).toBeNull();
  });

  test("renders a progress bar and marks a live run controllable", () => {
    const card = buildAwakenCard(
      {
        ...STATS,
        awaken: {
          runId: 'awaken_run:u"00000000-0000-4000-8000-000000000001"',
          status: "running",
          processed: 25,
          total: 100,
          failed: 0,
          startedAt: 0,
          finishedAt: null,
          error: null,
        },
      },
      8,
    );
    expect(card?.percent).toBe(25);
    expect(card?.bar).toBe("██░░░░░░");
    expect(card?.controllable).toBe(true);
    expect(card?.detail).toBe("75 remaining");
  });

  test("a finished run is not controllable and reports failures", () => {
    const card = buildAwakenCard({
      ...STATS,
      awaken: {
        runId: 'awaken_run:u"00000000-0000-4000-8000-000000000002"',
        status: "completed",
        processed: 10,
        total: 10,
        failed: 2,
        startedAt: 0,
        finishedAt: 1,
        error: null,
      },
    });
    expect(card?.controllable).toBe(false);
    expect(card?.detail).toBe("2 failed");
    expect(card?.percent).toBe(100);
  });

  test("an error message wins over the remaining-count detail", () => {
    const card = buildAwakenCard({
      ...STATS,
      awaken: {
        runId: 'awaken_run:u"00000000-0000-4000-8000-000000000003"',
        status: "failed",
        processed: 1,
        total: 10,
        failed: 1,
        startedAt: 0,
        finishedAt: 1,
        error: "embedding endpoint unreachable",
      },
    });
    expect(card?.detail).toBe("embedding endpoint unreachable");
  });
});

describe("buildTopBar", () => {
  test("labels the five tabs and marks the active one", () => {
    const bar = buildTopBar(initialState("/tmp/my-vault"));
    expect(bar.vault).toBe("my-vault");
    expect(bar.tabs.map((tab) => tab.title)).toEqual([
      "Status",
      "Review",
      "Chat",
      "Notes",
      "Activity",
    ]);
    expect(bar.tabs[2]?.active).toBe(true);
  });

  test("daemon reads connecting before the first status and disconnected after a drop", () => {
    expect(buildTopBar(initialState("/v")).daemon).toBe("connecting");
    const lost = reducer(initialState("/v"), { type: "conn/lost", reason: "gone" });
    expect(buildTopBar(lost).daemon).toBe("disconnected");
  });

  test("pending combines edge proposals and blocked writes", () => {
    const state = reducer(initialState("/v"), { type: "stats/loaded", stats: STATS });
    expect(buildTopBar(state).pending).toBe(3);
    expect(buildTopBar(state).pendingStale).toBe(false);
  });

  test("pending stays explicitly unknown before the first stats reading", () => {
    const state = initialState("/v");
    expect(buildPendingCounts(state)).toEqual({
      proposals: 0,
      approvals: 0,
      total: 0,
      status: "unknown",
    });
    expect(buildTopBar(state)).toMatchObject({ pending: null, pendingStale: false });
  });

  test("a failed refresh marks the last good pending total stale", () => {
    let state = reducer(initialState("/v"), { type: "stats/loaded", stats: STATS });
    state = reducer(state, { type: "stats/failed", message: "stats unavailable" });
    expect(buildPendingCounts(state)).toEqual({
      proposals: 1,
      approvals: 2,
      total: 3,
      status: "stale",
    });
    expect(buildTopBar(state)).toMatchObject({ pending: 3, pendingStale: true });
  });

  test("a disconnect marks the last good pending total stale", () => {
    let state = reducer(initialState("/v"), { type: "stats/loaded", stats: STATS });
    state = reducer(state, { type: "conn/lost", reason: "daemon stopped" });
    expect(buildPendingCounts(state)).toEqual({
      proposals: 1,
      approvals: 2,
      total: 3,
      status: "stale",
    });
    expect(buildTopBar(state)).toMatchObject({
      daemon: "disconnected",
      pending: 3,
      pendingStale: true,
    });
  });

  test("pending remains vault-wide across Home to Inbox to Home navigation", () => {
    const vaultStats: VaultStatsResult = {
      ...STATS,
      typedEdges: STATS.typedEdges.map((entry) =>
        entry.table === "supports" ? { ...entry, pending: 1_693 } : entry,
      ),
      typedEdgesPending: 1_693,
      pendingApprovals: 0,
    };
    const cappedPage = Array.from({ length: 100 }, (_, index) =>
      proposal({ id: `supports:${String(index).padStart(20, "0")}` }),
    );
    let state = reducer(initialState("/v"), { type: "stats/loaded", stats: vaultStats });
    state = reducer(state, {
      type: "inbox/loaded",
      proposals: cappedPage,
      approvals: [],
    });

    expect(buildPendingCounts(state)).toEqual({
      proposals: 1_693,
      approvals: 0,
      total: 1_693,
      status: "live",
    });
    expect(buildTopBar(state).pending).toBe(1_693);

    state = reducer(state, { type: "view/set", view: "inbox" });
    expect(state.inbox.proposals).toHaveLength(100);
    expect(buildPendingCounts(state)).toEqual({
      proposals: 1_693,
      approvals: 0,
      total: 1_693,
      status: "live",
    });
    expect(buildTopBar(state).pending).toBe(1_693);

    state = reducer(state, { type: "view/set", view: "home" });
    expect(buildPendingCounts(state)).toEqual({
      proposals: 1_693,
      approvals: 0,
      total: 1_693,
      status: "live",
    });
    expect(buildTopBar(state).pending).toBe(1_693);
    expect(buildVitalsCards(state.stats, buildPendingCounts(state))).toContainEqual({
      label: "pending",
      value: "1693 edges",
    });
  });

  test("awaken segment is absent when no run exists", () => {
    const state = reducer(initialState("/v"), { type: "stats/loaded", stats: STATS });
    expect(buildTopBar(state).awaken).toBeNull();
  });
});

describe("groupInbox", () => {
  test("files each row under the note it lands on, groups sorted by path", () => {
    const groups = groupInbox(
      [
        proposal({ id: "supports:aaaaaaaaaaaaaaaaaaaa", toNotePath: "z.md" }),
        proposal({ id: "supports:bbbbbbbbbbbbbbbbbbbb" }),
      ],
      [approval()],
    );
    expect(groups.map((group) => group.notePath)).toEqual(["target.md", "z.md"]);
    expect(groups[0]?.entries).toHaveLength(2);
  });

  test("a blocked write sorts ahead of an edge proposal in the same group", () => {
    const groups = groupInbox([proposal()], [approval()]);
    expect(groups[0]?.entries[0]?.kind).toBe("approval");
    expect(groups[0]?.entries[1]?.kind).toBe("proposal");
  });

  test("proposals inside a group sort strongest first", () => {
    const groups = groupInbox(
      [
        proposal({ id: "supports:wwwwwwwwwwwwwwwwwwww", confidence: 0.3 }),
        proposal({ id: "supports:ssssssssssssssssssss", confidence: 0.95 }),
      ],
      [],
    );
    expect(groups[0]?.entries.map((entry) => entry.id)).toEqual([
      "supports:ssssssssssssssssssss",
      "supports:wwwwwwwwwwwwwwwwwwww",
    ]);
  });

  test("a write approval without a path lands in one explicit bucket", () => {
    const groups = groupInbox([], [approval({ path: null })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.notePath).toBe("(no target note)");
  });

  test("the filter matches edge table, either path, and agent", () => {
    const proposals = [
      proposal(),
      proposal({ id: "related_to:rrrrrrrrrrrrrrrrrrrr", table: "related_to" }),
    ];
    expect(groupInbox(proposals, [], "related")).toHaveLength(1);
    expect(flattenInbox(groupInbox(proposals, [], "linker"))).toHaveLength(2);
    expect(groupInbox(proposals, [], "nothing-here")).toEqual([]);
  });

  test("the filter matches an approval's tool and requester", () => {
    expect(groupInbox([], [approval()], "notes.append")).toHaveLength(1);
    expect(groupInbox([], [approval({ requestedBy: "mcp" })], "mcp")).toHaveLength(1);
  });
});

describe("inbox selection", () => {
  test("the cursor indexes the flattened group order", () => {
    const groups = groupInbox(
      [proposal({ toNotePath: "z.md" }), proposal({ id: "supports:bbbbbbbbbbbbbbbbbbbb" })],
      [approval()],
    );
    expect(flattenInbox(groups).map((entry) => entry.id)).toEqual([
      "call-1",
      "supports:bbbbbbbbbbbbbbbbbbbb",
      "supports:aaaaaaaaaaaaaaaaaaaa",
    ]);
    expect(selectedInboxEntry(groups, 1)?.id).toBe("supports:bbbbbbbbbbbbbbbbbbbb");
    expect(selectedInboxEntry(groups, 99)).toBeNull();
  });

  test("inboxGroupIds returns only the proposal ids of the selected note", () => {
    const groups = groupInbox(
      [
        proposal({ id: "supports:bbbbbbbbbbbbbbbbbbbb" }),
        proposal({ id: "supports:cccccccccccccccccccc", toNotePath: "z.md" }),
      ],
      [approval()],
    );
    expect(inboxGroupIds(groups, 0)).toEqual({
      notePath: "target.md",
      proposalIds: ["supports:bbbbbbbbbbbbbbbbbbbb"],
    });
    expect(inboxGroupIds(groups, 99)).toBeNull();
  });

  test("inboxTarget agrees with the group a row was filed under", () => {
    expect(inboxTarget({ kind: "proposal", id: "x", proposal: proposal() })).toBe("target.md");
    expect(inboxTarget({ kind: "approval", id: "y", approval: approval() })).toBe("target.md");
  });
});

describe("buildInboxDetail", () => {
  test("null selection has no detail", () => {
    expect(buildInboxDetail(null)).toBeNull();
  });

  test("an edge proposal shows both endpoints and its confidence", () => {
    const detail = buildInboxDetail({
      kind: "proposal",
      id: "supports:aaaaaaaaaaaaaaaaaaaa",
      proposal: proposal({ evidence: [{ chunkId: "chunk:1", text: "because" }] }),
    });
    expect(detail?.title).toBe("edge · supports");
    expect(detail?.rows.find((row) => row.label === "confidence")?.value).toBe("80%");
    expect(detail?.evidence).toEqual(["because"]);
  });

  test("a blocked write shows its preview as evidence lines", () => {
    const detail = buildInboxDetail({ kind: "approval", id: "call-1", approval: approval() });
    expect(detail?.title).toBe("tool write · notes.append");
    expect(detail?.evidence).toEqual(["line one", "line two"]);
  });
});

describe("sortNeighbors", () => {
  test("live edges come before proposals", () => {
    const rows = sortNeighbors([
      neighbor({ notePath: "p.md", proposed: true, confidence: 0.99 }),
      neighbor({ notePath: "live.md", proposed: false, confidence: 0.1 }),
    ]);
    expect(rows.map((row) => row.notePath)).toEqual(["live.md", "p.md"]);
  });

  test("within a class, strongest first", () => {
    const rows = sortNeighbors([
      neighbor({ notePath: "weak.md", confidence: 0.2 }),
      neighbor({ notePath: "strong.md", confidence: 0.9 }),
    ]);
    expect(rows.map((row) => row.notePath)).toEqual(["strong.md", "weak.md"]);
  });

  test("ties break on table then path so a re-poll never reshuffles", () => {
    const rows = sortNeighbors([
      neighbor({ notePath: "b.md", table: "related_to", confidence: 0.5 }),
      neighbor({ notePath: "a.md", table: "related_to", confidence: 0.5 }),
      neighbor({ notePath: "c.md", table: "extends", confidence: 0.5 }),
    ]);
    expect(rows.map((row) => row.notePath)).toEqual(["c.md", "a.md", "b.md"]);
  });

  test("an empty neighbourhood stays empty", () => {
    expect(sortNeighbors([])).toEqual([]);
  });
});

describe("buildDiscoveryRows and buildStreamRows", () => {
  const events: AgentEventWire[] = [
    {
      id: 'agent_event:u"00000000-0000-4000-8000-000000000001"',
      ts: 0,
      type: "indexer:note-indexed",
      payload: { notePath: "a.md" },
    },
    {
      id: 'agent_event:u"00000000-0000-4000-8000-000000000002"',
      ts: 1000,
      type: "swarm:link_proposed",
      payload: { fromNotePath: "a.md", toNotePath: "b.md" },
    },
    {
      id: 'agent_event:u"00000000-0000-4000-8000-000000000003"',
      ts: 2000,
      type: "swarm:contradiction_discovered",
      payload: { summary: "clash" },
    },
  ];

  test("discoveries are swarm-only, newest first", () => {
    const rows = buildDiscoveryRows(events);
    expect(rows.map((row) => row.id)).toEqual([
      'agent_event:u"00000000-0000-4000-8000-000000000003"',
      'agent_event:u"00000000-0000-4000-8000-000000000002"',
    ]);
    expect(rows[0]?.type).toBe("contradiction_discovered");
    expect(rows[0]?.summary).toBe("clash");
  });

  test("a discovery carries the note it concerns when the payload names one", () => {
    expect(buildDiscoveryRows(events)[1]?.notePath).toBe("a.md");
  });

  test("no swarm activity means no rows, not a placeholder roster", () => {
    expect(buildDiscoveryRows([events[0] as AgentEventWire])).toEqual([]);
  });

  test("stream rows use a case-insensitive substring over type and summary", () => {
    expect(buildStreamRows(events)).toHaveLength(3);
    expect(buildStreamRows(events, "XER:NOTE").map((row) => row.id)).toEqual([
      'agent_event:u"00000000-0000-4000-8000-000000000001"',
    ]);
    expect(buildStreamRows(events, "LAS").map((row) => row.id)).toEqual([
      'agent_event:u"00000000-0000-4000-8000-000000000003"',
    ]);
    expect(buildStreamRows(events, "nope")).toHaveLength(0);
  });

  test("stream filtering is not token-fuzzy", () => {
    expect(buildStreamRows(events, "swrm")).toEqual([]);
    expect(buildStreamRows(events, "link proposed")).toEqual([]);
  });

  test("stream rows format the timestamp as wall-clock time", () => {
    expect(buildStreamRows(events)[0]?.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  test("stream row counts distinguish a filtered or capped subset", () => {
    expect(streamCountLabel(5, 5)).toBe("5 rows");
    expect(streamCountLabel(2, 5)).toBe("2/5 rows");
  });
});

describe("extractCitations", () => {
  test("excludes code, embeds, external links and suggested filenames, preserving Markdown URL fragments", () => {
    expect(
      extractCitations(
        "Save as Thought.md. `[[Code]]`\n```md\n[[Example]]\n```\n![[Image.png]] [web](https://example.com/Note.md) [source](Research/Note%20one.md#^proof)",
      ),
    ).toEqual(["[[Research/Note one.md#^proof]]"]);
  });
  test("picks up wikilinks and Markdown links in first-mention order", () => {
    expect(extractCitations("see [[Alpha]] and [Beta](notes/beta.md)")).toEqual([
      "[[Alpha]]",
      "[[notes/beta.md]]",
    ]);
  });

  test("retains complete wikilink syntax for server-side parsing", () => {
    expect(extractCitations("[[notes/gamma#Section|Gamma]]")).toEqual([
      "[[notes/gamma#Section|Gamma]]",
    ]);
  });

  test("deduplicates repeats", () => {
    expect(extractCitations("[[a.md]] and [[a.md]] again")).toEqual(["[[a.md]]"]);
  });

  test("keeps spaced Unicode filenames intact and preserves mixed first-mention order", () => {
    const citation = "[[Research/Single Writer (SWMR) — documentation.md]]";
    expect(extractCitations(`[First](notes/first.md) then ${citation} and ${citation}`)).toEqual([
      "[[notes/first.md]]",
      citation,
    ]);
  });

  test("text with no citations yields none", () => {
    expect(extractCitations("just prose")).toEqual([]);
  });
});

describe("exploreOpenTarget", () => {
  test("marks a selected wikilink as a citation requiring server resolution", () => {
    const state = reducer(reducer(initialState("/v"), { type: "view/set", view: "ask" }), {
      type: "ask/turnDone",
      tokens: 1,
      citations: ["[[Alpha]]"],
    });
    expect(exploreOpenTarget(state)).toEqual({ kind: "citation", target: "[[Alpha]]" });
  });

  test("marks a selected bare Markdown citation for the same server resolution", () => {
    const state = reducer(reducer(initialState("/v"), { type: "view/set", view: "ask" }), {
      type: "ask/turnDone",
      tokens: 1,
      citations: ["notes/beta.md"],
    });
    expect(exploreOpenTarget(state)).toEqual({
      kind: "citation",
      target: "notes/beta.md",
    });
  });

  test("returns null when Ask has no citation to resolve", () => {
    const state = reducer(initialState("/v"), { type: "view/set", view: "ask" });
    expect(exploreOpenTarget(state)).toBeNull();
  });
});

describe("buildDiscoveryRows with link_proposed paths", () => {
  test("renders edge type, target path, and confidence from the payload", async () => {
    const { buildDiscoveryRows } = await import("../../../../src/cli/tui/viewModels");
    const rows = buildDiscoveryRows([
      {
        id: 'agent_event:u"00000000-0000-4000-8000-000000000007"',
        ts: 1,
        type: "swarm:link_proposed",
        payload: {
          edgeId: "supports:dddddddddddddddddddd",
          sourceId: "note:a",
          targetId: "note:b",
          sourcePath: "a.md",
          targetPath: "b.md",
          edgeType: "supports",
          confidence: 0.85,
          runId: AGENT_RUN_ID,
        },
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("link_proposed");
    expect(rows[0].notePath).toBe("a.md");
    expect(rows[0].summary).toBe("supports → b.md (0.85)");
  });
});
