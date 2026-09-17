import type { GraphNeighbors } from "../../api/graph";
import type { NoteStructure, SourceReference } from "../../api/schema";
import type { WritingRequest } from "./draft";
/**
 * The TUI's single source of truth.
 *
 * One state object, one reducer, typed actions. Views are pure functions of
 * this state; every mutation is an action, so a behaviour can be tested
 * without a terminal, a daemon, or React. Nothing in here performs IO —
 * `rpc.ts` does the calls and dispatches the results.
 *
 * The rule the reducer enforces for the whole product: state may only hold
 * what the daemon actually reported. There is no "expected" shape padded
 * with zeros, so a panel that has no data renders as absent rather than as
 * a plausible-looking lie.
 */

import type { Conversation } from "../../core/chat/types";
import type {
  AgentEventWire,
  DaemonStatusResult,
  EndpointHealthWire,
  ExtractionItemWire,
  NeighborWire,
  PendingApprovalWire,
  ProposalWire,
  VaultStatsResult,
} from "../../daemon/wire";
import type { ChatLine } from "./ChatView";
import { conversationLines, conversationTitle, lastPreparedDraft } from "./conversations";
import { conversationSources } from "./sources";
import { extractCitations } from "./viewModels";

export const VIEW_IDS = ["home", "inbox", "ask", "explore", "stream"] as const;
export type ViewId = (typeof VIEW_IDS)[number];

export const VIEW_TITLES: Record<ViewId, string> = {
  home: "Status",
  inbox: "Review",
  ask: "Chat",
  explore: "Notes",
  stream: "Activity",
};

/** Which column of Explore has the keyboard. */
export type ExplorePane = "body" | "view" | "neighbors";

export const EXPLORE_PANES: ExplorePane[] = ["body", "view", "neighbors"];

export interface ConnectionState {
  /** False after a `DAEMON_DISCONNECTED`; a keypress attempts a reconnect. */
  readonly connected: boolean;
  readonly reason: string | null;
  readonly reconnecting: boolean;
}

export interface InboxState {
  readonly proposals: ReadonlyArray<ProposalWire>;
  readonly approvals: ReadonlyArray<PendingApprovalWire>;
  readonly cursor: number;
  readonly filter: string;
  readonly loaded: boolean;
  readonly error: string | null;
}

export interface AskState {
  readonly showActivity: boolean;
  readonly conversationId: string | null;
  readonly notePath: string | null;
  readonly topic: string;
  readonly lines: ReadonlyArray<ChatLine>;
  readonly buffer: string;
  readonly busy: boolean;
  readonly model: string | null;
  readonly lastTurnTokens: number | null;
  /** callId -> tool name, for approvals raised inside the current session. */
  readonly pendingApprovals: ReadonlyMap<string, string>;
  /** Raw wikilink/path tokens cited by the last answer, in citation order. */
  readonly citations: ReadonlyArray<string>;
  /** Revision-bound passages observed in successful tools in the current turn. */
  readonly sources: ReadonlyArray<SourceReference>;
  readonly citationCursor: number;
  /** Text stays text until Esc explicitly enters navigation. */
  readonly composerMode: "editing" | "navigation";
}

export interface ExploreState {
  readonly connections: GraphNeighbors | null;
  readonly connectionsError: string | null;
  readonly structure: NoteStructure | null;
  readonly revision: string | null;
  readonly outlineCursor: number;
  readonly selected: SourceReference | null;
  readonly raw: boolean;
  readonly notePath: string | null;
  readonly body: string | null;
  readonly concepts: ReadonlyArray<ExtractionItemWire>;
  readonly claims: ReadonlyArray<ExtractionItemWire>;
  readonly questions: ReadonlyArray<ExtractionItemWire>;
  readonly neighbors: ReadonlyArray<NeighborWire & { connectionId?: string }>;
  readonly pane: ExplorePane;
  readonly bodyScroll: number;
  readonly neighborCursor: number;
  readonly loading: boolean;
  readonly error: string | null;
}

export interface StreamState {
  readonly events: ReadonlyArray<AgentEventWire>;
  readonly cursor: string | null;
  readonly filter: string;
}

/**
 * The one modal surface in the app. Exactly one prompt can be open, and
 * while it is open every keystroke belongs to it: that is the whole focus
 * model, so no view needs its own "am I typing?" flag.
 *
 *   command       `:` — the slash verbs
 *   inbox-filter  `/` in Inbox
 *   stream-filter `/` in Stream
 *   note-picker   `o` in Explore
 */
export type PromptKind =
  | "navigation"
  | "command"
  | "inbox-filter"
  | "stream-filter"
  | "note-picker"
  | "conversation-picker";

export interface PromptState {
  readonly kind: PromptKind | null;
  readonly buffer: string;
  /** Completion candidates for the note picker. */
  readonly matches: ReadonlyArray<string>;
  readonly cursor: number;
}

export interface AppState {
  readonly writing: WritingRequest | null;
  readonly vaultPath: string;
  readonly view: ViewId;
  readonly connection: ConnectionState;
  readonly status: DaemonStatusResult | null;
  readonly statusError: string | null;
  readonly endpoints: ReadonlyArray<EndpointHealthWire>;
  readonly stats: VaultStatsResult | null;
  readonly statsError: string | null;
  readonly inbox: InboxState;
  readonly ask: AskState;
  readonly explore: ExploreState;
  readonly stream: StreamState;
  readonly prompt: PromptState;
  /** Output of the last `:` command, newest last. */
  readonly commandOutput: ReadonlyArray<string>;
  readonly notice: string | null;
  readonly exiting: boolean;
}

export const STREAM_MAX_EVENTS = 500;

export function initialState(vaultPath: string): AppState {
  return {
    vaultPath,
    writing: null,
    view: "ask",
    connection: { connected: true, reason: null, reconnecting: false },
    status: null,
    statusError: null,
    endpoints: [],
    stats: null,
    statsError: null,
    inbox: { proposals: [], approvals: [], cursor: 0, filter: "", loaded: false, error: null },
    ask: {
      showActivity: false,
      conversationId: null,
      notePath: null,
      topic: "",
      lines: [],
      buffer: "",
      busy: false,
      model: null,
      lastTurnTokens: null,
      pendingApprovals: new Map(),
      citations: [],
      sources: [],
      citationCursor: 0,
      composerMode: "editing",
    },
    explore: {
      structure: null,
      revision: null,
      outlineCursor: 0,
      selected: null,
      raw: false,
      notePath: null,
      body: null,
      concepts: [],
      claims: [],
      questions: [],
      neighbors: [],
      connections: null,
      connectionsError: null,
      pane: "body",
      bodyScroll: 0,
      neighborCursor: 0,
      loading: false,
      error: null,
    },
    stream: { events: [], cursor: null, filter: "" },
    prompt: { kind: null, buffer: "", matches: [], cursor: 0 },
    commandOutput: [],
    notice: null,
    exiting: false,
  };
}

export type Action =
  | { type: "writing/open"; request: WritingRequest }
  | { type: "writing/close" }
  | { type: "view/set"; view: ViewId }
  | { type: "view/cycle"; delta: number }
  | { type: "conn/lost"; reason: string }
  | { type: "conn/reconnecting" }
  | { type: "conn/restored" }
  | { type: "status/failed"; message: string }
  | { type: "status/loaded"; status: DaemonStatusResult }
  | { type: "health/loaded"; endpoints: EndpointHealthWire[] }
  | { type: "stats/loaded"; stats: VaultStatsResult }
  | { type: "stats/failed"; message: string }
  | { type: "inbox/loaded"; proposals: ProposalWire[]; approvals: PendingApprovalWire[] }
  | { type: "inbox/failed"; message: string }
  | { type: "inbox/move"; delta: number }
  | { type: "inbox/filter"; filter: string }
  | { type: "inbox/drop"; id: string }
  | { type: "ask/session"; conversationId: string; topic: string }
  | { type: "ask/restore"; conversation: Conversation }
  | { type: "ask/new" }
  | { type: "ask/activity" }
  | { type: "ask/buffer"; buffer: string }
  | { type: "ask/line"; line: ChatLine }
  | { type: "ask/reset"; line?: ChatLine }
  | { type: "ask/assistantDelta"; text: string }
  | { type: "ask/assistantFinal"; text: string }
  | { type: "ask/busy"; busy: boolean }
  | { type: "ask/turnDone"; tokens: number; citations: string[] }
  | { type: "ask/sources"; sources: SourceReference[] }
  | { type: "ask/model"; model: string }
  | { type: "ask/approvalPending"; callId: string; tool: string }
  | { type: "ask/approvalResolved"; callId: string }
  | { type: "ask/citationMove"; delta: number }
  | { type: "ask/citationUnresolved"; target: string }
  | { type: "explore/open"; notePath: string; keepPane?: boolean }
  | { type: "explore/raw" }
  | { type: "explore/full" }
  | {
      type: "explore/body";
      body: string;
      selected?: SourceReference | null;
      structure?: NoteStructure;
      revision?: string;
    }
  | { type: "explore/outlineMove"; delta: number }
  | {
      type: "explore/extraction";
      concepts: ExtractionItemWire[];
      claims: ExtractionItemWire[];
      questions: ExtractionItemWire[];
    }
  | {
      type: "explore/neighbors";
      neighbors: (NeighborWire & { connectionId?: string })[];
      connections?: GraphNeighbors;
    }
  | { type: "explore/connectionsFailed"; message: string }
  | { type: "explore/failed"; message: string }
  | { type: "explore/pane"; delta: number }
  | { type: "explore/scroll"; delta: number }
  | { type: "explore/move"; delta: number }
  | { type: "stream/events"; events: AgentEventWire[]; cursor: string | null }
  | { type: "stream/filter"; filter: string }
  | { type: "prompt/open"; kind: PromptKind; buffer?: string }
  | { type: "prompt/buffer"; buffer: string }
  | { type: "prompt/matches"; matches: string[] }
  | { type: "prompt/move"; delta: number }
  | { type: "prompt/close" }
  | { type: "command/output"; text: string }
  | { type: "ask/composer"; mode: "editing" | "navigation" }
  | { type: "notice"; text: string | null }
  | { type: "exit" };

function clamp(value: number, max: number): number {
  if (max <= 0) return 0;
  if (value < 0) return 0;
  if (value > max) return max;
  return value;
}

function matchesInboxText(fields: readonly string[], filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  return needle.length === 0 || fields.some((field) => field.toLowerCase().includes(needle));
}

export function proposalMatchesInboxFilter(proposal: ProposalWire, filter: string): boolean {
  return matchesInboxText(
    [proposal.table, proposal.fromNotePath, proposal.toNotePath, proposal.agent],
    filter,
  );
}

export function approvalMatchesInboxFilter(approval: PendingApprovalWire, filter: string): boolean {
  return matchesInboxText([approval.tool, approval.path ?? "", approval.requestedBy], filter);
}

export function visibleInboxCount(
  proposals: ReadonlyArray<ProposalWire>,
  approvals: ReadonlyArray<PendingApprovalWire>,
  filter: string,
): number {
  return (
    proposals.filter((proposal) => proposalMatchesInboxFilter(proposal, filter)).length +
    approvals.filter((approval) => approvalMatchesInboxFilter(approval, filter)).length
  );
}

function cycleView(current: ViewId, delta: number): ViewId {
  const index = VIEW_IDS.indexOf(current);
  const next = (index + delta + VIEW_IDS.length) % VIEW_IDS.length;
  return VIEW_IDS[next] ?? current;
}

function switchView(state: AppState, view: ViewId): AppState {
  return {
    ...state,
    view,
    ask: { ...state.ask, composerMode: view === "ask" ? "editing" : "navigation" },
    prompt: { kind: null, buffer: "", matches: [], cursor: 0 },
    notice: null,
  };
}

function editAskBuffer(ask: AskState, buffer: string): AskState {
  return {
    ...ask,
    buffer,
    composerMode: ask.composerMode,
  };
}

function mergeStreamEvents(
  current: ReadonlyArray<AgentEventWire>,
  incoming: ReadonlyArray<AgentEventWire>,
): AgentEventWire[] {
  const byId = new Map<string, AgentEventWire>();
  for (const event of current) byId.set(event.id, event);
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(-STREAM_MAX_EVENTS);
}

function newestEventCursor(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left.localeCompare(right) >= 0 ? left : right;
}

/**
 * Appends an assistant delta by rewriting the trailing streaming line rather
 * than pushing a new one, so a token stream renders as one growing paragraph.
 */
function appendAssistantDelta(
  lines: ReadonlyArray<ChatLine>,
  text: string,
): ReadonlyArray<ChatLine> {
  const last = lines[lines.length - 1];
  if (last !== undefined && last.kind === "assistant" && last.streaming === true) {
    return [...lines.slice(0, -1), { kind: "assistant", text: last.text + text, streaming: true }];
  }
  return [...lines, { kind: "assistant", text, streaming: true }];
}

function withoutKey(map: ReadonlyMap<string, string>, key: string): ReadonlyMap<string, string> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

/**
 * A filter prompt updates its view's filter as it is typed, so the list
 * narrows live rather than only on Enter.
 */
function mirrorPromptBuffer(state: AppState): AppState {
  if (state.prompt.kind === "inbox-filter") {
    return { ...state, inbox: { ...state.inbox, filter: state.prompt.buffer, cursor: 0 } };
  }
  if (state.prompt.kind === "stream-filter") {
    return { ...state, stream: { ...state.stream, filter: state.prompt.buffer } };
  }
  return state;
}

/** True while a prompt or the Ask composer owns the keyboard. */
export function isTyping(state: AppState): boolean {
  if (state.prompt.kind !== null) return true;
  return state.view === "ask" && state.ask.composerMode !== "navigation";
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "writing/open":
      return {
        ...state,
        writing: action.request,
        prompt: { kind: null, buffer: "", matches: [], cursor: 0 },
      };
    case "writing/close":
      return { ...state, writing: null };
    case "view/set":
      return state.view === action.view ? state : switchView(state, action.view);
    case "view/cycle": {
      const view = cycleView(state.view, action.delta);
      return switchView(state, view);
    }
    case "conn/lost":
      return {
        ...state,
        connection: { connected: false, reason: action.reason, reconnecting: false },
      };
    case "conn/reconnecting":
      return { ...state, connection: { ...state.connection, reconnecting: true } };
    case "conn/restored":
      return { ...state, connection: { connected: true, reason: null, reconnecting: false } };
    case "status/loaded":
      return { ...state, status: action.status, statusError: null };
    case "status/failed":
      return { ...state, statusError: action.message };
    case "health/loaded":
      return { ...state, endpoints: action.endpoints };
    case "stats/loaded":
      return { ...state, stats: action.stats, statsError: null };
    case "stats/failed":
      return { ...state, statsError: action.message };
    case "inbox/loaded": {
      const total = visibleInboxCount(action.proposals, action.approvals, state.inbox.filter);
      return {
        ...state,
        inbox: {
          ...state.inbox,
          proposals: action.proposals,
          approvals: action.approvals,
          cursor: clamp(state.inbox.cursor, Math.max(0, total - 1)),
          loaded: true,
          error: null,
        },
      };
    }
    case "inbox/failed":
      return { ...state, inbox: { ...state.inbox, loaded: true, error: action.message } };
    case "inbox/move": {
      const total = visibleInboxCount(
        state.inbox.proposals,
        state.inbox.approvals,
        state.inbox.filter,
      );
      return {
        ...state,
        inbox: { ...state.inbox, cursor: clamp(state.inbox.cursor + action.delta, total - 1) },
      };
    }
    case "inbox/filter":
      return { ...state, inbox: { ...state.inbox, filter: action.filter, cursor: 0 } };
    case "inbox/drop": {
      const proposals = state.inbox.proposals.filter((entry) => entry.id !== action.id);
      const approvals = state.inbox.approvals.filter((entry) => entry.callId !== action.id);
      const total = visibleInboxCount(proposals, approvals, state.inbox.filter);
      return {
        ...state,
        inbox: {
          ...state.inbox,
          proposals,
          approvals,
          cursor: clamp(state.inbox.cursor, Math.max(0, total - 1)),
        },
      };
    }
    case "ask/session":
      return {
        ...state,
        ask: { ...state.ask, conversationId: action.conversationId, topic: action.topic },
      };
    case "ask/restore": {
      const lines = conversationLines(action.conversation);
      const answer = [...lines].reverse().find((line) => line.kind === "assistant")?.text ?? "";
      return {
        ...state,
        view: "ask",
        prompt: { kind: null, buffer: "", matches: [], cursor: 0 },
        ask: {
          ...initialState(state.vaultPath).ask,
          conversationId: action.conversation.id,
          notePath: action.conversation.notePath,
          topic: conversationTitle(action.conversation),
          model: action.conversation.model,
          lines,
          citations: extractCitations(`${answer}\n${lastPreparedDraft(lines)?.markdown ?? ""}`),
          sources: conversationSources(action.conversation.messages),
        },
      };
    }
    case "ask/new":
      return {
        ...state,
        view: "ask",
        prompt: { kind: null, buffer: "", matches: [], cursor: 0 },
        ask: initialState(state.vaultPath).ask,
      };
    case "ask/activity":
      return { ...state, ask: { ...state.ask, showActivity: !state.ask.showActivity } };
    case "ask/buffer":
      return { ...state, ask: editAskBuffer(state.ask, action.buffer) };
    case "ask/line":
      return {
        ...state,
        ask: {
          ...state.ask,
          ...(action.line.kind === "user" ? { sources: [], citations: [], citationCursor: 0 } : {}),
          lines: [...state.ask.lines, action.line],
        },
      };
    case "ask/sources":
      return { ...state, ask: { ...state.ask, sources: action.sources, citationCursor: 0 } };
    case "ask/reset":
      return {
        ...state,
        ask: {
          ...state.ask,
          lines: action.line === undefined ? [] : [action.line],
          citations: [],
          sources: [],
          citationCursor: 0,
          composerMode: "editing",
        },
      };
    case "ask/assistantDelta":
      return {
        ...state,
        ask: { ...state.ask, lines: appendAssistantDelta(state.ask.lines, action.text) },
      };
    case "ask/assistantFinal": {
      const lines = [...state.ask.lines];
      const final: ChatLine = { kind: "assistant", text: action.text };
      if (lines.at(-1)?.kind === "assistant") lines[lines.length - 1] = final;
      else lines.push(final);
      return { ...state, ask: { ...state.ask, lines } };
    }
    case "ask/busy":
      return { ...state, ask: { ...state.ask, busy: action.busy } };
    case "ask/turnDone":
      return {
        ...state,
        ask: {
          ...state.ask,
          busy: false,
          lastTurnTokens: action.tokens,
          citations: [
            ...new Set([
              ...action.citations,
              ...extractCitations(lastPreparedDraft(state.ask.lines)?.markdown ?? ""),
            ]),
          ],
          citationCursor: 0,
          composerMode: "editing",
        },
      };
    case "ask/model":
      return { ...state, ask: { ...state.ask, model: action.model } };
    case "ask/approvalPending": {
      const next = new Map(state.ask.pendingApprovals);
      next.set(action.callId, action.tool);
      return { ...state, ask: { ...state.ask, pendingApprovals: next } };
    }
    case "ask/approvalResolved":
      return {
        ...state,
        ask: {
          ...state.ask,
          pendingApprovals: withoutKey(state.ask.pendingApprovals, action.callId),
        },
      };
    case "ask/citationMove":
      return {
        ...state,
        ask: {
          ...state.ask,
          citationCursor: clamp(
            state.ask.citationCursor + action.delta,
            (state.ask.sources.length || state.ask.citations.length) - 1,
          ),
        },
      };
    case "ask/citationUnresolved":
      return { ...state, notice: `citation did not resolve: ${action.target}` };
    case "explore/open":
      return {
        ...state,
        explore: {
          ...state.explore,
          raw: false,
          selected: null,
          structure: null,
          revision: null,
          outlineCursor: 0,
          pane:
            action.keepPane && state.explore.notePath === action.notePath
              ? state.explore.pane
              : "body",
          notePath: action.notePath,
          body: null,
          concepts: [],
          claims: [],
          questions: [],
          neighbors: [],
          connections: null,
          connectionsError: null,
          bodyScroll: 0,
          neighborCursor: 0,
          loading: true,
          error: null,
        },
      };
    case "explore/raw":
      return { ...state, explore: { ...state.explore, raw: !state.explore.raw, bodyScroll: 0 } };
    case "explore/full":
      return { ...state, explore: { ...state.explore, selected: null, bodyScroll: 0 } };
    case "explore/body":
      return {
        ...state,
        explore: {
          ...state.explore,
          body: action.body,
          structure: action.structure ?? null,
          revision: action.revision ?? null,
          selected: action.selected ?? null,
          loading: false,
        },
      };
    case "explore/outlineMove":
      return {
        ...state,
        explore: {
          ...state.explore,
          outlineCursor: clamp(
            state.explore.outlineCursor + action.delta,
            (state.explore.structure?.headings.length ?? 0) +
              (state.explore.structure?.blocks.length ?? 0) -
              1,
          ),
        },
      };
    case "explore/extraction":
      return {
        ...state,
        explore: {
          ...state.explore,
          concepts: action.concepts,
          claims: action.claims,
          questions: action.questions,
        },
      };
    case "explore/connectionsFailed":
      return { ...state, explore: { ...state.explore, connectionsError: action.message } };
    case "explore/neighbors":
      return {
        ...state,
        explore: {
          ...state.explore,
          neighbors: action.neighbors,
          connections: action.connections ?? null,
          connectionsError: null,
          neighborCursor: clamp(state.explore.neighborCursor, action.neighbors.length - 1),
        },
      };
    case "explore/failed":
      return {
        ...state,
        explore: { ...state.explore, loading: false, error: action.message },
      };
    case "explore/pane": {
      const index = EXPLORE_PANES.indexOf(state.explore.pane);
      const next = (index + action.delta + EXPLORE_PANES.length) % EXPLORE_PANES.length;
      return {
        ...state,
        explore: { ...state.explore, pane: EXPLORE_PANES[next] ?? state.explore.pane },
      };
    }
    case "explore/scroll":
      return {
        ...state,
        explore: {
          ...state.explore,
          bodyScroll: Math.max(0, state.explore.bodyScroll + action.delta),
        },
      };
    case "explore/move":
      return {
        ...state,
        explore: {
          ...state.explore,
          neighborCursor: clamp(
            state.explore.neighborCursor + action.delta,
            state.explore.neighbors.length - 1,
          ),
        },
      };
    case "stream/events": {
      return {
        ...state,
        stream: {
          ...state.stream,
          events: mergeStreamEvents(state.stream.events, action.events),
          cursor: newestEventCursor(state.stream.cursor, action.cursor),
        },
      };
    }
    case "stream/filter":
      return { ...state, stream: { ...state.stream, filter: action.filter } };
    case "prompt/open":
      return {
        ...state,
        prompt: { kind: action.kind, buffer: action.buffer ?? "", matches: [], cursor: 0 },
      };
    case "prompt/buffer":
      return mirrorPromptBuffer({
        ...state,
        prompt: {
          ...state.prompt,
          buffer: action.buffer,
          ...(state.prompt.kind === "note-picker" ? { matches: [], cursor: 0 } : {}),
        },
      });
    case "prompt/matches":
      return {
        ...state,
        prompt: {
          ...state.prompt,
          matches: action.matches,
          cursor: clamp(state.prompt.cursor, action.matches.length - 1),
        },
      };
    case "prompt/move":
      return {
        ...state,
        prompt: {
          ...state.prompt,
          cursor: clamp(state.prompt.cursor + action.delta, state.prompt.matches.length - 1),
        },
      };
    case "prompt/close":
      return { ...state, prompt: { kind: null, buffer: "", matches: [], cursor: 0 } };
    case "command/output":
      return { ...state, commandOutput: [...state.commandOutput, action.text].slice(-40) };
    case "ask/composer":
      return { ...state, ask: { ...state.ask, composerMode: action.mode } };
    case "notice":
      return { ...state, notice: action.text };
    case "exit":
      return { ...state, exiting: true };
  }
}
