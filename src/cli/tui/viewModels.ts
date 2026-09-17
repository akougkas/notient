/**
 * Pure state -> rows functions.
 *
 * Every list, card, and label the TUI draws is computed here so the layout
 * components stay dumb and the behaviour stays testable. No React, no RPC,
 * no `Date.now()` without an injected clock.
 */

import { inspectMarkdown } from "../../api/notes";
import type { NoteSelector, NoteStructure, SourceReference } from "../../api/schema";
import { parseWikilinkInner } from "../../core/markdown/plugins/remarkWikilink";
import type {
  AgentEventWire,
  AwakenRunSummary,
  EndpointHealthWire,
  NeighborWire,
  PendingApprovalWire,
  ProposalWire,
  VaultStatsResult,
} from "../../daemon/wire";
import type { AppState, ViewId } from "./store";
import {
  VIEW_IDS,
  VIEW_TITLES,
  approvalMatchesInboxFilter,
  proposalMatchesInboxFilter,
} from "./store";

/* ------------------------------------------------------------------ */
/* Top bar                                                             */
/* ------------------------------------------------------------------ */

export interface TopBarModel {
  readonly vault: string;
  readonly daemon: string;
  readonly model: string | null;
  readonly awaken: string | null;
  readonly pending: number | null;
  readonly pendingStale: boolean;
  readonly tabs: ReadonlyArray<{ key: string; title: string; active: boolean }>;
}

export interface PendingCounts {
  readonly proposals: number;
  readonly approvals: number;
  readonly total: number;
  readonly status: "live" | "stale" | "unknown";
}

/**
 * The vault-wide pending-count reading used by every view.
 *
 * `vault.stats` is the sole count authority. The Inbox holds only the page
 * returned by its bounded list calls, so its array lengths can describe what
 * is rendered but can never replace the total for the vault. Before the first
 * successful read the total is unknown; after a failed refresh the last good
 * value remains explicitly marked stale.
 */
export function buildPendingCounts(state: AppState): PendingCounts {
  const proposals = state.stats?.typedEdgesPending ?? 0;
  const approvals = state.stats?.pendingApprovals ?? 0;
  const status =
    state.stats === null
      ? "unknown"
      : state.statsError === null && state.connection.connected
        ? "live"
        : "stale";
  return { proposals, approvals, total: proposals + approvals, status };
}

function daemonLabel(state: AppState): string {
  if (!state.connection.connected)
    return state.connection.reconnecting ? "reconnecting" : "disconnected";
  if (state.status === null) return "connecting";
  if (!state.status.sealed) return "starting";
  if (state.statusError !== null) return "status stale";
  if (state.status.indexing.state === "current") return "ready";
  if (state.status.indexing.state === "failed") return "index failed";
  return state.status.indexing.state;
}

export function buildTopBar(state: AppState): TopBarModel {
  const vault = state.vaultPath.split("/").filter(Boolean).pop() ?? state.vaultPath;
  const daemon = daemonLabel(state);
  const model = state.ask.model ?? state.status?.probe.configuredModel ?? null;
  const pendingCounts = buildPendingCounts(state);
  return {
    vault,
    daemon,
    model,
    awaken: formatAwakenCompact(state.stats?.awaken ?? null),
    pending: pendingCounts.status === "unknown" ? null : pendingCounts.total,
    pendingStale: pendingCounts.status === "stale",
    tabs: VIEW_IDS.map((id, index) => ({
      key: String(index + 1),
      title: VIEW_TITLES[id],
      active: state.view === id,
    })),
  };
}

/** `awaken 412/1200 34%` while a run is live; the terminal status otherwise. */
export function formatAwakenCompact(run: AwakenRunSummary | null): string | null {
  if (run === null) return null;
  if (run.status === "running" || run.status === "paused") {
    return `awaken ${run.status} ${run.processed}/${run.total} ${percent(run.processed, run.total)}%`;
  }
  return `awaken ${run.status}`;
}

export function percent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((done / total) * 100));
}

/* ------------------------------------------------------------------ */
/* Home                                                                */
/* ------------------------------------------------------------------ */

export interface HomeCard {
  readonly label: string;
  readonly value: string;
}

/**
 * Vitals cards. Returns an empty list when the daemon has not answered
 * `vault.stats` yet, so Home can say "no reading yet" instead of drawing a
 * grid of zeros that looks like an empty vault.
 */
export function buildVitalsCards(
  stats: VaultStatsResult | null,
  pending: PendingCounts,
): HomeCard[] {
  if (stats === null) return [];
  return [
    { label: "notes", value: String(stats.notes) },
    { label: "blocks", value: String(stats.blocks) },
    { label: "chunks", value: String(stats.chunks) },
    { label: "concepts", value: String(stats.concepts) },
    { label: "claims", value: String(stats.claims) },
    { label: "questions", value: String(stats.questions) },
    { label: "wikilinks", value: String(stats.wikilinks) },
    { label: "typed edges", value: `${stats.typedEdgesApproved} approved` },
    { label: "pending", value: `${pending.proposals} edges` },
    { label: "approvals", value: String(pending.approvals) },
  ];
}

export interface EdgeBreakdownRow {
  readonly table: string;
  readonly approved: number;
  readonly pending: number;
}

export function buildEdgeBreakdown(stats: VaultStatsResult | null): EdgeBreakdownRow[] {
  if (stats === null) return [];
  return stats.typedEdges.map((entry) => ({
    table: entry.table,
    approved: entry.approved,
    pending: entry.pending,
  }));
}

export interface AwakenCardModel {
  readonly status: AwakenRunSummary["status"];
  readonly processed: number;
  readonly total: number;
  readonly failed: number;
  readonly percent: number;
  readonly bar: string;
  readonly detail: string;
  readonly controllable: boolean;
}

export function buildAwakenCard(
  stats: VaultStatsResult | null,
  barWidth = 24,
): AwakenCardModel | null {
  const run = stats?.awaken ?? null;
  if (run === null) return null;
  const pct = percent(run.processed, run.total);
  const filled = Math.round((pct / 100) * barWidth);
  const active = run.status === "running" || run.status === "paused";
  const detail =
    run.error !== null && run.error.length > 0
      ? run.error
      : run.failed > 0
        ? `${run.failed} failed`
        : active
          ? `${run.total - run.processed} remaining`
          : "no run in flight";
  return {
    status: run.status,
    processed: run.processed,
    total: run.total,
    failed: run.failed,
    percent: pct,
    bar: "█".repeat(filled).padEnd(barWidth, "░"),
    detail,
    controllable: active,
  };
}

export function buildEndpointRows(
  endpoints: ReadonlyArray<EndpointHealthWire>,
): Array<{ label: string; state: "ok" | "down" }> {
  return endpoints.map((entry) => ({ label: entry.label, state: entry.ok ? "ok" : "down" }));
}

export interface DiscoveryRow {
  readonly id: string;
  readonly type: string;
  readonly summary: string;
  readonly notePath: string | null;
}

/**
 * Recent swarm discoveries, newest first. Only events the daemon actually
 * emitted appear; there is no placeholder row for an agent that has not run.
 */
export function buildDiscoveryRows(
  events: ReadonlyArray<AgentEventWire>,
  limit = 10,
): DiscoveryRow[] {
  return [...events]
    .filter((event) => event.type.startsWith("swarm:"))
    .sort((left, right) => right.id.localeCompare(left.id))
    .slice(0, limit)
    .map((event) => ({
      id: event.id,
      type: event.type.replace(/^swarm:/, ""),
      summary: summarizePayload(event.payload),
      notePath: notePathFromPayload(event.payload),
    }));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function notePathFromPayload(payload: unknown): string | null {
  const record = asRecord(payload);
  if (record === null) return null;
  for (const key of ["notePath", "fromNotePath", "sourcePath", "path", "note"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export function summarizePayload(payload: unknown): string {
  const record = asRecord(payload);
  if (record === null) return typeof payload === "string" ? payload : "";
  const edgeType = record.edgeType;
  const targetPath = record.targetPath;
  if (typeof edgeType === "string" && typeof targetPath === "string") {
    const confidence = record.confidence;
    const score = typeof confidence === "number" ? ` (${confidence.toFixed(2)})` : "";
    return `${edgeType} → ${targetPath}${score}`;
  }
  for (const key of ["summary", "message", "label", "text", "toNotePath", "notePath"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return Object.keys(record).slice(0, 3).join(" ");
}

/* ------------------------------------------------------------------ */
/* Inbox                                                               */
/* ------------------------------------------------------------------ */

export type InboxEntry =
  | { readonly kind: "proposal"; readonly id: string; readonly proposal: ProposalWire }
  | { readonly kind: "approval"; readonly id: string; readonly approval: PendingApprovalWire };

export interface InboxGroup {
  readonly notePath: string;
  readonly entries: ReadonlyArray<InboxEntry>;
}

const NO_TARGET = "(no target note)";

/** Target note a row is filed under: the edge's `to` side, or the write's path. */
export function inboxTarget(entry: InboxEntry): string {
  if (entry.kind === "proposal") {
    return entry.proposal.toNotePath;
  }
  return entry.approval.path ?? NO_TARGET;
}

function matchesFilter(entry: InboxEntry, filter: string): boolean {
  return entry.kind === "proposal"
    ? proposalMatchesInboxFilter(entry.proposal, filter)
    : approvalMatchesInboxFilter(entry.approval, filter);
}

/**
 * Groups pending work by the note it lands on. Note-write approvals sort
 * ahead of edge proposals inside a group because a blocked tool call is
 * holding a chat turn open, while a proposal is not blocking anything.
 * Groups are ordered by target path so the list does not reshuffle between
 * polls.
 */
export function groupInbox(
  proposals: ReadonlyArray<ProposalWire>,
  approvals: ReadonlyArray<PendingApprovalWire>,
  filter = "",
): InboxGroup[] {
  const entries: InboxEntry[] = [
    ...approvals.map(
      (approval): InboxEntry => ({ kind: "approval", id: approval.callId, approval }),
    ),
    ...proposals.map((proposal): InboxEntry => ({ kind: "proposal", id: proposal.id, proposal })),
  ].filter((entry) => matchesFilter(entry, filter));

  const byTarget = new Map<string, InboxEntry[]>();
  for (const entry of entries) {
    const target = inboxTarget(entry);
    const bucket = byTarget.get(target);
    if (bucket === undefined) byTarget.set(target, [entry]);
    else bucket.push(entry);
  }
  return [...byTarget.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([notePath, bucket]) => ({
      notePath,
      entries: [...bucket].sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "approval" ? -1 : 1;
        if (left.kind === "proposal" && right.kind === "proposal") {
          return right.proposal.confidence - left.proposal.confidence;
        }
        return 0;
      }),
    }));
}

/** Selection order: the groups flattened, which is what the cursor indexes. */
export function flattenInbox(groups: ReadonlyArray<InboxGroup>): InboxEntry[] {
  return groups.flatMap((group) => [...group.entries]);
}

export function selectedInboxEntry(
  groups: ReadonlyArray<InboxGroup>,
  cursor: number,
): InboxEntry | null {
  return flattenInbox(groups)[cursor] ?? null;
}

/** Rendered row occupied by the selected entry, including group headings. */
export function inboxSelectionVisualRow(
  groups: ReadonlyArray<InboxGroup>,
  cursor: number,
): number | null {
  if (cursor < 0) return null;
  let entryOffset = 0;
  let visualRow = 0;
  for (const group of groups) {
    visualRow += 1;
    const indexInGroup = cursor - entryOffset;
    if (indexInGroup >= 0 && indexInGroup < group.entries.length) {
      return visualRow + indexInGroup;
    }
    entryOffset += group.entries.length;
    visualRow += group.entries.length;
  }
  return null;
}

/** Every id in the selected entry's group, for the "approve all here" key. */
export function inboxGroupIds(
  groups: ReadonlyArray<InboxGroup>,
  cursor: number,
): { notePath: string; proposalIds: string[] } | null {
  const selected = selectedInboxEntry(groups, cursor);
  if (selected === null) return null;
  const target = inboxTarget(selected);
  const group = groups.find((entry) => entry.notePath === target);
  if (group === undefined) return null;
  return {
    notePath: target,
    proposalIds: group.entries
      .filter((entry): entry is Extract<InboxEntry, { kind: "proposal" }> => {
        return entry.kind === "proposal";
      })
      .map((entry) => entry.id),
  };
}

export interface ProposalDetailModel {
  readonly title: string;
  readonly rows: ReadonlyArray<{ label: string; value: string }>;
  readonly evidence: ReadonlyArray<string>;
}

export function buildInboxDetail(entry: InboxEntry | null): ProposalDetailModel | null {
  if (entry === null) return null;
  if (entry.kind === "approval") {
    const approval = entry.approval;
    return {
      title: `tool write · ${approval.tool}`,
      rows: [
        { label: "callId", value: approval.callId },
        { label: "path", value: approval.path ?? "(none)" },
        { label: "requested by", value: approval.requestedBy },
        { label: "requested at", value: new Date(approval.requestedAt).toISOString() },
      ],
      evidence: approval.preview.length > 0 ? approval.preview.split("\n").slice(0, 20) : [],
    };
  }
  const proposal = entry.proposal;
  return {
    title: `edge · ${proposal.table}`,
    rows: [
      { label: "id", value: proposal.id },
      { label: "from", value: proposal.fromNotePath },
      { label: "to", value: proposal.toNotePath },
      { label: "confidence", value: `${Math.round(proposal.confidence * 100)}%` },
      { label: "agent", value: proposal.agent },
      {
        label: "created",
        value: new Date(proposal.createdAt).toISOString(),
      },
    ],
    evidence: proposal.evidence.map((snippet) => snippet.text),
  };
}

/* ------------------------------------------------------------------ */
/* Explore                                                             */
/* ------------------------------------------------------------------ */

export interface NeighborRow {
  readonly connectionId?: string;
  readonly notePath: string;
  readonly table: string;
  readonly direction: "outgoing" | "incoming";
  readonly confidence: number;
  readonly proposed: boolean;
}

/**
 * Live edges before proposals, then strongest first, then a stable
 * alphabetical tiebreak so a re-poll never reorders the list under the
 * cursor.
 */
export type NeighborRowModel = NeighborRow;

export function sortNeighbors(
  neighbors: ReadonlyArray<NeighborWire & { connectionId?: string }>,
): NeighborRow[] {
  return [...neighbors]
    .map((entry) => ({
      ...(entry.connectionId ? { connectionId: entry.connectionId } : {}),
      notePath: entry.notePath,
      table: entry.table,
      direction: entry.direction,
      confidence: entry.confidence,
      proposed: entry.proposed,
    }))
    .sort((left, right) => {
      if (left.proposed !== right.proposed) return left.proposed ? 1 : -1;
      if (right.confidence !== left.confidence) return right.confidence - left.confidence;
      if (left.table !== right.table) return left.table.localeCompare(right.table);
      return left.notePath.localeCompare(right.notePath);
    });
}

/* ------------------------------------------------------------------ */
/* Stream                                                              */
/* ------------------------------------------------------------------ */

export interface StreamRow {
  readonly id: string;
  readonly time: string;
  readonly type: string;
  readonly summary: string;
}

export function streamCountLabel(visible: number, total: number): string {
  return visible === total ? `${total} rows` : `${visible}/${total} rows`;
}

export function buildStreamRows(
  events: ReadonlyArray<AgentEventWire>,
  filter = "",
  limit = 200,
): StreamRow[] {
  const needle = filter.trim().toLowerCase();
  return [...events]
    .sort((left, right) => right.id.localeCompare(left.id))
    .filter((event) => {
      if (needle.length === 0) return true;
      return (
        event.type.toLowerCase().includes(needle) ||
        summarizePayload(event.payload).toLowerCase().includes(needle)
      );
    })
    .slice(0, limit)
    .map((event) => ({
      id: event.id,
      time: new Date(event.ts).toISOString().slice(11, 19),
      type: event.type,
      summary: summarizePayload(event.payload),
    }));
}

/* ------------------------------------------------------------------ */
/* Ask                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Citation tokens in first-mention order. Wikilink syntax is intentionally
 * retained: `vault.resolve_link` owns parsing and path resolution, while the
 * TUI only identifies which token the user selected.
 */
export function extractCitations(text: string): string[] {
  const found: string[] = [];
  const push = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length > 0 && !found.includes(trimmed)) found.push(trimmed);
  };
  // Use actual Markdown links. Bare filenames, code samples and suggested
  // destinations are not evidence citations merely because they end in .md.
  for (const link of inspectMarkdown(text).links.sort((a, b) => a.range.start - b.range.start)) {
    if (link.embed) continue;
    if (link.kind === "wiki") {
      push(text.slice(link.range.start, link.range.end));
    } else if (!/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(link.target)) {
      try {
        const target = decodeURIComponent(link.target);
        if (/\.md(?:#|$)/i.test(target) && !/[\[\]|\r\n]/.test(target)) push(`[[${target}]]`);
      } catch {
        /* Malformed URL escapes do not become local file targets. */
      }
    }
  }
  return found;
}

export function citationLabel(citation: string): string {
  const parsed = parseWikilinkInner(citation.replace(/^\[\[|\]\]$/g, ""));
  return parsed.alias ?? (parsed.target.split("/").at(-1) || parsed.target).replace(/\.md$/, "");
}

export function noteOutline(
  structure: NoteStructure | null,
): Array<{ label: string; level: number; line: number; selector: NoteSelector }> {
  if (!structure) return [];
  return [
    ...structure.headings.map((heading) => ({
      label: heading.text,
      level: heading.level,
      line: heading.range.startLine,
      selector: { kind: "heading" as const, text: heading.text, occurrence: heading.occurrence },
    })),
    ...structure.blocks.map((block) => ({
      label: `^${block.id}`,
      level: 2,
      line: block.range.startLine,
      selector: { kind: "block" as const, id: block.id },
    })),
  ].sort((a, b) => a.line - b.line);
}

export type ExploreOpenTarget =
  | { readonly kind: "source"; readonly source: SourceReference }
  | { readonly kind: "citation"; readonly target: string }
  | { readonly kind: "path"; readonly target: string };

/** What the current selection points at, and whether it needs server resolution. */
export function exploreOpenTarget(state: AppState): ExploreOpenTarget | null {
  if (state.view === "inbox") {
    const entry = selectedInboxEntry(
      groupInbox(state.inbox.proposals, state.inbox.approvals, state.inbox.filter),
      state.inbox.cursor,
    );
    return entry === null ? null : { kind: "path", target: inboxTarget(entry) };
  }
  if (state.view === "ask") {
    const source = state.ask.sources[state.ask.citationCursor];
    if (source) return { kind: "source", source };
    const target = state.ask.citations[state.ask.citationCursor];
    return target === undefined ? null : { kind: "citation", target };
  }
  if (state.view === "explore") {
    const target = sortNeighbors(state.explore.neighbors)[state.explore.neighborCursor]?.notePath;
    return target === undefined ? null : { kind: "path", target };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Key hints                                                           */
/* ------------------------------------------------------------------ */

export function viewIndex(view: ViewId): number {
  return VIEW_IDS.indexOf(view);
}
