/**
 * Inbox: everything waiting on a human decision, grouped by the note it
 * lands on. Two kinds of row share the list because they share the
 * question — blocked tool writes (`approvals.pending`, resolved with
 * `chat.approve`) and pending typed-edge proposals (`proposals.*`).
 */

import type { ScrollBoxRenderable } from "@opentui/core";
import type React from "react";
import type { InboxLayout } from "../layout";
import type { AppState } from "../store";
import type { InboxEntry, InboxGroup, PendingCounts, ProposalDetailModel } from "../viewModels";
import {
  buildInboxDetail,
  buildPendingCounts,
  flattenInbox,
  groupInbox,
  selectedInboxEntry,
} from "../viewModels";
import { EmptyLine, Panel } from "./Chrome";
import {
  COLOR,
  HORIZONTAL_SCROLLBAR_OPTIONS,
  VERTICAL_SCROLLBAR_OPTIONS,
  basename,
  confidenceColor,
  truncate,
  truncateMiddle,
  truncatePath,
} from "./theme";

export function InboxView({
  state,
  layout,
  scrollRef,
}: {
  state: AppState;
  layout: InboxLayout;
  scrollRef: React.MutableRefObject<ScrollBoxRenderable | null>;
}): React.ReactNode {
  const groups = groupInbox(state.inbox.proposals, state.inbox.approvals, state.inbox.filter);
  const flat = flattenInbox(groups);
  const selected = selectedInboxEntry(groups, state.inbox.cursor);
  const detail = buildInboxDetail(selected);
  const selectedId = selected?.id ?? null;
  const pending = buildPendingCounts(state);
  const queueTitle = inboxQueueTitle(flat.length, pending);

  return (
    <box width={layout.width} height={layout.height} flexDirection="row">
      <Panel title={queueTitle} width={layout.queueWidth} height={layout.height} active>
        <QueueContent
          state={state}
          groups={groups}
          rowCount={flat.length}
          selectedId={selectedId}
          layout={layout}
          scrollRef={scrollRef}
        />
      </Panel>

      <Panel
        title={truncateMiddle(detail?.title ?? "detail", layout.detailRowsWidth)}
        width={layout.detailWidth}
        height={layout.height}
      >
        <DetailContent detail={detail} layout={layout} />
      </Panel>
    </box>
  );
}

/** Distinguish an exact total from an unknown or retained stale reading. */
export function inboxQueueTitle(visible: number, pending: PendingCounts): string {
  if (pending.status === "unknown") return `queue (${visible}/?)`;
  if (pending.status === "stale") return `queue (${visible}/~${pending.total})`;
  return visible === pending.total
    ? `queue (${pending.total})`
    : `queue (${visible}/${pending.total})`;
}

function emptyQueueText(state: AppState): string {
  if (!state.inbox.loaded) return "loading…";
  if (state.inbox.filter.length > 0) return "no rows match the filter";
  return "nothing waiting on you";
}

function QueueContent({
  state,
  groups,
  rowCount,
  selectedId,
  layout,
  scrollRef,
}: {
  state: AppState;
  groups: ReadonlyArray<InboxGroup>;
  rowCount: number;
  selectedId: string | null;
  layout: InboxLayout;
  scrollRef: React.MutableRefObject<ScrollBoxRenderable | null>;
}): React.ReactNode {
  if (state.inbox.error !== null) return <EmptyLine text={state.inbox.error} />;
  if (rowCount === 0) return <EmptyLine text={emptyQueueText(state)} />;
  return (
    <scrollbox
      ref={scrollRef}
      width={layout.queueScrollWidth}
      height={layout.scrollHeight}
      minHeight={0}
      stickyScroll={false}
      horizontalScrollbarOptions={HORIZONTAL_SCROLLBAR_OPTIONS}
      verticalScrollbarOptions={VERTICAL_SCROLLBAR_OPTIONS}
    >
      {groups.map((group) => (
        <box key={group.notePath} flexDirection="column">
          <text wrapMode="none">
            <span fg={COLOR.accent}>
              {truncatePath(
                group.notePath,
                Math.max(8, layout.queueRowsWidth - ` (${group.entries.length})`.length - 1),
              )}
            </span>
            <span fg={COLOR.dim}>{` (${group.entries.length})`}</span>
          </text>
          {group.entries.map((entry) => (
            <InboxRow
              key={entry.id}
              entry={entry}
              active={entry.id === selectedId}
              layout={layout}
            />
          ))}
        </box>
      ))}
    </scrollbox>
  );
}

function DetailContent({
  detail,
  layout,
}: {
  detail: ProposalDetailModel | null;
  layout: InboxLayout;
}): React.ReactNode {
  if (detail === null) return <EmptyLine text="select a row" />;
  return (
    <scrollbox
      width={layout.detailScrollWidth}
      height={layout.scrollHeight}
      minHeight={0}
      stickyScroll={false}
      horizontalScrollbarOptions={HORIZONTAL_SCROLLBAR_OPTIONS}
      verticalScrollbarOptions={VERTICAL_SCROLLBAR_OPTIONS}
    >
      <box flexDirection="column">
        {detail.rows.map((row) => (
          <text key={row.label} wrapMode="none">
            <span fg={COLOR.label}>
              {truncate(row.label, layout.detailLabelWidth).padEnd(layout.detailLabelWidth)}
            </span>
            <span fg={COLOR.dim}> </span>
            <span fg={COLOR.text}>{truncateMiddle(row.value, layout.detailValueWidth)}</span>
          </text>
        ))}
        <text> </text>
        <text wrapMode="none">
          <span fg={COLOR.label}>evidence</span>
        </text>
        {detail.evidence.length === 0 ? (
          <EmptyLine text="  (none recorded)" />
        ) : (
          detail.evidence.map((snippet) => (
            <text key={snippet} wrapMode="word">
              <span fg={COLOR.dim}>{"  "}</span>
              <span fg={COLOR.text}>{snippet}</span>
            </text>
          ))
        )}
      </box>
    </scrollbox>
  );
}

function InboxRow({
  entry,
  active,
  layout,
}: {
  entry: InboxEntry;
  active: boolean;
  layout: InboxLayout;
}): React.ReactNode {
  const marker = active ? "› " : "  ";
  if (entry.kind === "approval") {
    return (
      <text wrapMode="none">
        <span fg={COLOR.accent}>{marker}</span>
        <span fg={active ? COLOR.bright : COLOR.warn}>
          {truncate(`write ${entry.approval.tool}`, layout.approvalToolWidth).padEnd(
            layout.approvalToolWidth,
          )}
        </span>
        <span fg={COLOR.dim}> </span>
        <span fg={COLOR.dim}>
          {truncate(entry.approval.requestedBy, layout.approvalRequesterWidth)}
        </span>
      </text>
    );
  }
  return (
    <text wrapMode="none">
      <span fg={COLOR.accent}>{marker}</span>
      <span fg={COLOR.proposal}>
        {truncate(entry.proposal.table, layout.proposalTableWidth).padEnd(
          layout.proposalTableWidth,
        )}
      </span>
      <span fg={COLOR.dim}> </span>
      <span fg={active ? COLOR.bright : COLOR.text}>
        {truncatePath(basename(entry.proposal.fromNotePath), layout.proposalSourceWidth).padEnd(
          layout.proposalSourceWidth,
        )}
      </span>
      <span fg={COLOR.dim}> </span>
      <span fg={confidenceColor(entry.proposal.confidence)}>
        {`${Math.round(entry.proposal.confidence * 100)}%`.padStart(4)}
      </span>
    </text>
  );
}
