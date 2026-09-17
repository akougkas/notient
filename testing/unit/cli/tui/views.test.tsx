import { currentIndexingFixture } from "../../../indexingFixture";
/**
 * Smoke coverage for the five views plus the chrome.
 *
 * The views are pure functions of the store, so they are called directly
 * rather than mounted into a terminal renderer: the assertion is that every
 * view builds an element tree for both an empty store and a fully populated
 * one, which is where the "no dead panel" rule actually bites.
 */

import { describe, expect, test } from "bun:test";
import type React from "react";
import { deriveTuiLayout } from "../../../../src/cli/tui/layout";
import {
  type Action,
  type AppState,
  type ViewId,
  initialState,
  reducer,
} from "../../../../src/cli/tui/store";
import { buildTopBar } from "../../../../src/cli/tui/viewModels";
import { AskView } from "../../../../src/cli/tui/views/AskView";
import {
  DisconnectedBanner,
  KeyHintBar,
  NoticeLine,
  PromptLine,
  TopBar,
} from "../../../../src/cli/tui/views/Chrome";
import { ExploreView } from "../../../../src/cli/tui/views/ExploreView";
import { HomeView } from "../../../../src/cli/tui/views/HomeView";
import { InboxView } from "../../../../src/cli/tui/views/InboxView";
import { StreamView } from "../../../../src/cli/tui/views/StreamView";
import type {
  AgentEventWire,
  DaemonStatusResult,
  PendingApprovalWire,
  ProposalWire,
  VaultStatsResult,
} from "../../../../src/daemon/wire";

const STATUS: DaemonStatusResult = {
  indexing: currentIndexingFixture(),
  httpEndpoint: "http://127.0.0.1:12345",
  vaultId: "0123456789abcdef",
  ok: true,
  vault: "/tmp/vault",
  pid: 42,
  socketPath: "/tmp/sock",
  startedAt: 0,
  version: "0.1.0-alpha",
  sealed: true,
  visionReady: false,
  probe: {
    endpoint: "http://localhost:1234/v1",
    configuredModel: "qwen3",
    loadedModel: "qwen3",
    configuredContextTokens: 8192,
    parallelSlots: 2,
    requestedTotalContextTokens: 16384,
    loadedContextLength: 16384,
    status: "ok",
    message: "ok",
  },
};

const STATS: VaultStatsResult = {
  ok: true,
  notes: 120,
  blocks: 900,
  chunks: 2400,
  concepts: 88,
  claims: 41,
  questions: 12,
  wikilinks: 300,
  typedEdges: [
    { table: "supports", approved: 12, pending: 3 },
    { table: "contradicts", approved: 1, pending: 1 },
    { table: "extends", approved: 0, pending: 0 },
    { table: "exemplifies", approved: 0, pending: 0 },
    { table: "synthesizes", approved: 0, pending: 0 },
    { table: "related_to", approved: 40, pending: 5 },
  ],
  typedEdgesApproved: 53,
  typedEdgesPending: 9,
  pendingApprovals: 1,
  awaken: {
    runId: 'awaken_run:u"00000000-0000-4000-8000-000000000001"',
    status: "running",
    processed: 55,
    total: 120,
    failed: 1,
    startedAt: 0,
    finishedAt: null,
    error: null,
  },
};

const PROPOSAL: ProposalWire = {
  id: "supports:aaaaaaaaaaaaaaaaaaaa",
  table: "supports",
  fromNotePath: "notes/a.md",
  toNotePath: "notes/b.md",
  confidence: 0.91,
  source: "linker",
  agent: "linker",
  createdAt: 1_700_000_000_000,
  evidence: [{ chunkId: "chunk:1", text: "the supporting sentence" }],
};

const APPROVAL: PendingApprovalWire = {
  callId: "call-1",
  tool: "notes.append",
  preview: "+ appended line",
  path: "notes/b.md",
  requestedBy: "human",
  requestedAt: 1_700_000_000_000,
};

const EVENTS: AgentEventWire[] = [
  {
    id: 'agent_event:u"00000000-0000-4000-8000-000000000001"',
    ts: 1_700_000_000_000,
    type: "indexer:note-indexed",
    payload: { notePath: "a.md" },
  },
  {
    id: 'agent_event:u"00000000-0000-4000-8000-000000000002"',
    ts: 1_700_000_001_000,
    type: "swarm:link_proposed",
    payload: { fromNotePath: "a.md", toNotePath: "b.md" },
  },
];

function build(actions: Action[]): AppState {
  return actions.reduce(reducer, initialState("/tmp/vault"));
}

const POPULATED = build([
  { type: "status/loaded", status: STATUS },
  {
    type: "health/loaded",
    endpoints: [
      { label: "primary", ok: true },
      { label: "deep", ok: true },
      { label: "embed", ok: false },
    ],
  },
  { type: "stats/loaded", stats: STATS },
  {
    type: "stream/events",
    events: EVENTS,
    cursor: 'agent_event:u"00000000-0000-4000-8000-000000000002"',
  },
  { type: "inbox/loaded", proposals: [PROPOSAL], approvals: [APPROVAL] },
  { type: "explore/open", notePath: "notes/a.md" },
  { type: "explore/body", body: "# Heading\n\nbody text" },
  {
    type: "explore/extraction",
    concepts: [
      {
        id: "concept:1",
        text: "vector search",
        kind: "topic",
        confidence: 0.9,
        evidence: [{ chunkId: "chunk:1", text: "we index with HNSW" }],
      },
    ],
    claims: [],
    questions: [],
  },
  {
    type: "explore/neighbors",
    neighbors: [
      {
        notePath: "notes/b.md",
        table: "supports",
        direction: "outgoing",
        agent: "linker",
        confidence: 0.8,
        proposed: false,
      },
      {
        notePath: "notes/c.md",
        table: "related_to",
        direction: "incoming",
        agent: "linker",
        confidence: 0.4,
        proposed: true,
      },
    ],
  },
  { type: "ask/assistantDelta", text: "See [[notes/a]] for the answer." },
  { type: "ask/turnDone", tokens: 12, citations: ["notes/a"] },
]);

const EMPTY = initialState("/tmp/vault");

function renderView(
  view: ViewId,
  state: AppState,
  dimensions: readonly [number, number] = [120, 40],
): React.ReactNode {
  const layout = deriveTuiLayout(...dimensions);
  switch (view) {
    case "home":
      return HomeView({ state, layout: layout.home });
    case "inbox":
      return InboxView({ state, layout: layout.inbox, scrollRef: { current: null } });
    case "ask":
      return AskView({
        state,
        layout: layout.ask,
        scrollRef: { current: null },
        onBufferChange: () => {},
        onSubmit: () => {},
      });
    case "explore":
      return ExploreView({ state, layout: layout.explore });
    case "stream":
      return StreamView({ state, layout: layout.stream, scrollRef: { current: null } });
  }
}

const VIEWS: ViewId[] = ["home", "inbox", "ask", "explore", "stream"];

describe("view smoke", () => {
  for (const [width, height] of [
    [80, 24],
    [120, 40],
    [200, 60],
  ] as const) {
    for (const view of VIEWS) {
      test(`${view} renders empty and populated at ${width}x${height}`, () => {
        expect(renderView(view, { ...EMPTY, view }, [width, height])).toBeTruthy();
        expect(renderView(view, { ...POPULATED, view }, [width, height])).toBeTruthy();
      });
    }
  }
});

describe("chrome smoke", () => {
  test("the top bar and key hints render in every view", () => {
    const layout = deriveTuiLayout(120, 40).chrome;
    for (const view of VIEWS) {
      expect(TopBar({ state: { ...POPULATED, view }, layout })).toBeTruthy();
      expect(KeyHintBar({ state: { ...POPULATED, view }, layout })).toBeTruthy();
    }
  });

  test("the prompt line is absent unless a prompt is open", () => {
    const layout = deriveTuiLayout(80, 24).chrome;
    expect(PromptLine({ state: EMPTY, layout })).toBeNull();
    const open = build([
      { type: "prompt/open", kind: "note-picker" },
      { type: "prompt/matches", matches: ["a.md", "b.md"] },
    ]);
    expect(PromptLine({ state: open, layout })).toBeTruthy();
  });

  test("the disconnected banner appears only while the daemon is gone", () => {
    const layout = deriveTuiLayout(80, 24).chrome;
    expect(DisconnectedBanner({ state: EMPTY, layout })).toBeNull();
    const lost = build([{ type: "conn/lost", reason: "socket closed" }]);
    expect(DisconnectedBanner({ state: lost, layout })).toBeTruthy();
    expect(
      DisconnectedBanner({ state: reducer(lost, { type: "conn/reconnecting" }), layout }),
    ).toBeTruthy();
  });

  test("the notice line is absent without a notice", () => {
    const layout = deriveTuiLayout(80, 24).chrome;
    expect(NoticeLine({ state: EMPTY, layout })).toBeNull();
    expect(NoticeLine({ state: build([{ type: "notice", text: "hi" }]), layout })).toBeTruthy();
  });
});

describe("Stream layout", () => {
  test("puts the row count in a header and timestamps in a dedicated column", () => {
    const scrollRef = { current: null };
    const layout = deriveTuiLayout(80, 24).stream;
    const view = StreamView({ state: { ...POPULATED, view: "stream" }, layout, scrollRef }) as {
      props: {
        title: string;
        children: Array<{ type: string; props: Record<string, unknown> }>;
      };
    };
    const [header, scrollbox] = view.props.children;
    expect(view.props.title).toBe("events");
    expect(header?.type).toBe("box");
    expect(header?.props.height).toBe(1);
    expect(scrollbox?.type).toBe("scrollbox");
    expect(scrollbox?.props.ref).toBe(scrollRef);

    const rows = scrollbox?.props.children as Array<{
      props: { children: Array<{ props: Record<string, unknown> }> };
    }>;
    const timestampColumn = rows[0]?.props.children[0];
    expect(timestampColumn?.props.width).toBe(layout.timestampWidth);
  });
});

describe("Home endpoint rows", () => {
  test("three endpoint roles cannot shrink into an overpainted compact row", () => {
    const layout = deriveTuiLayout(80, 24).home;
    const home = HomeView({ state: { ...POPULATED, view: "home" }, layout }) as {
      props: {
        children: Array<{
          props: {
            children: Array<{
              props: { children: Array<{ props: Record<string, unknown> }> };
            }>;
          };
        }>;
      };
    };
    const statusPanels = home.props.children[2]?.props.children;
    const endpointRows = statusPanels?.[1]?.props.children;
    expect(endpointRows).toHaveLength(3);
    for (const row of endpointRows ?? []) {
      expect(row.props.height).toBe(1);
      expect(row.props.flexShrink).toBe(0);
    }
  });
});

describe("vault-wide pending count", () => {
  test("Inbox labels its bounded page against the vault.stats total", () => {
    const layout = deriveTuiLayout(80, 24).inbox;
    const inbox = InboxView({
      state: { ...POPULATED, view: "inbox" },
      layout,
      scrollRef: { current: null },
    }) as {
      props: { children: Array<{ props: { title: string } }> };
    };

    expect(inbox.props.children[0]?.props.title).toBe("queue (2/10)");
  });

  test("Inbox marks unknown and stale totals without using its capped page as authority", () => {
    const layout = deriveTuiLayout(80, 24).inbox;
    const renderTitle = (state: AppState): string => {
      const inbox = InboxView({
        state,
        layout,
        scrollRef: { current: null },
      }) as { props: { children: Array<{ props: { title: string } }> } };
      return inbox.props.children[0]?.props.title ?? "";
    };

    expect(renderTitle({ ...POPULATED, view: "inbox", stats: null })).toBe("queue (2/?)");
    expect(renderTitle({ ...POPULATED, view: "inbox", statsError: "stats unavailable" })).toBe(
      "queue (2/~10)",
    );
  });
});

test("connected TUI reports ready only for a current structural index and detects stale status", () => {
  let state = build([
    {
      type: "status/loaded",
      status: {
        ...STATUS,
        indexing: currentIndexingFixture({ state: "indexing", current: 0, pending: 1 }),
      },
    },
  ]);
  expect(buildTopBar(state).daemon).toBe("indexing");
  state = reducer(state, { type: "status/loaded", status: STATUS });
  expect(buildTopBar(state).daemon).toBe("ready");
  state = reducer(state, { type: "status/failed", message: "status timed out" });
  expect(buildTopBar(state).daemon).toBe("status stale");
  state = reducer(state, {
    type: "status/loaded",
    status: {
      ...STATUS,
      indexing: currentIndexingFixture({
        state: "failed",
        current: 0,
        failed: 1,
        failures: [{ path: "a.md", message: "transaction failed" }],
      }),
    },
  });
  expect(buildTopBar(state).daemon).toBe("index failed");
  expect(state.statusError).toBeNull();
});
