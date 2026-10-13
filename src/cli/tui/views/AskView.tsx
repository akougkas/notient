/**
 * Ask: the chat pane. Same `chat.start` / `chat.send` flow as before, with
 * the streamed answer above and the composer below. Passages from domain
 * reads are listed under it; `o` in navigate mode opens the exact revision
 * and passage in Explore. Older unverified links are labelled separately.
 */

import type { ScrollBoxRenderable } from "@opentui/core";
import type React from "react";
import type { CultivationDigestItem } from "../../../api/cultivation";
import type { SourceReference } from "../../../api/schema";
import { ChatView } from "../ChatView";
import { InputBar } from "../InputBar";
import {
  buildDevelopmentsStrip,
  capabilityRows,
  capabilitySegments,
  developmentRowLimit,
  threadLine,
  welcomeText,
} from "../entryChrome";
import { computeInputHeight } from "../inputBindings";
import type { AskLayout } from "../layout";
import { sourceLabel } from "../sources";
import type { AppState } from "../store";
import { citationLabel } from "../viewModels";
import { COLOR, truncate } from "./theme";

export interface AskViewProps {
  state: AppState;
  layout: AskLayout;
  elapsedSeconds?: number;
  scrollRef: React.MutableRefObject<ScrollBoxRenderable | null>;
  onBufferChange: (next: string) => void;
  onSubmit: (final: string) => void;
  onOpenCitation?: (target: string) => void;
  onOpenSource?: (source: SourceReference) => void;
  onToggleActivity?: () => void;
  onOpenDevelopment?: (item: CultivationDigestItem) => void;
}

export function AskView({
  state,
  layout,
  scrollRef,
  onBufferChange,
  onSubmit,
  onOpenCitation,
  onOpenSource,
  onToggleActivity,
  onOpenDevelopment,
  elapsedSeconds = 0,
}: AskViewProps): React.ReactNode {
  const inputHeight = computeInputHeight(state.ask.buffer, layout.inputTextWidth, 6);
  const items = sourceItems(state, layout.citationPathWidth);
  const page = sourcePage(items, state.ask.citationCursor);
  const heading = sourceHeading(state, items.length);
  const citationRows = citationBarRows(
    page.map((item) => item.label),
    layout,
    `${heading}  `,
    false,
  );
  const toolCalls = state.ask.lines.filter(
    (line) => line.kind === "tool" && !line.text.startsWith("done "),
  ).length;
  const activityRows = toolCalls > 0 || state.ask.busy ? 1 : 0;
  const compact = layout.height < 12;
  const readScope = compact ? null : state.ask.readScope;
  const readScopeRows = readScope ? Math.max(1, Math.ceil(readScope.length / layout.conversationWidth)) : 0;
  const strip = compact
    ? null
    : buildDevelopmentsStrip(state, developmentRowLimit(layout.height), layout.conversationWidth);
  const stripRows = strip === null ? 0 : 1 + strip.rows.length;
  const capability = capabilitySegments(state, layout.conversationWidth);
  const capabilityHeight = capabilityRows(capability, layout.conversationWidth);
  const headerRows = 2 + capabilityHeight + stripRows;
  const chatHeight = Math.max(
    1,
    layout.height - inputHeight - 2 - headerRows - citationRows - activityRows - readScopeRows,
  );
  const focused = state.ask.composerMode !== "navigation" && state.prompt.kind === null;
  return (
    <box
      width={layout.width}
      height={layout.height}
      paddingLeft={layout.inset}
      flexDirection="column"
    >
      <box width={layout.conversationWidth} height={1} />
      <text height={1} fg={COLOR.dim} wrapMode="none">
        {truncate(threadLine(state), layout.conversationWidth - 1)}
      </text>
      <text height={capabilityHeight} wrapMode="word">
        {capability.map((segment, index) => (
          <span key={segment.text} fg={COLOR[segment.tone]}>
            {`${index === 0 ? "" : " · "}${segment.text}`}
          </span>
        ))}
      </text>
      {strip === null ? null : (
        <box width={layout.conversationWidth} height={stripRows} flexDirection="column">
          <text height={1} fg={COLOR.label} wrapMode="none">
            {truncate(strip.heading, layout.conversationWidth - 1)}
          </text>
          {strip.rows.map((row) => (
            <text
              key={row.id}
              height={1}
              fg={COLOR.text}
              wrapMode="none"
              onMouseUp={() => (row.item ? onOpenDevelopment?.(row.item) : undefined)}
            >
              {`  ${row.text}`}
            </text>
          ))}
        </box>
      )}
      <ChatView
        lines={
          state.ask.lines.length
            ? [...state.ask.lines]
            : [
                {
                  kind: "system",
                  text: welcomeText(state),
                },
              ]
        }
        layout={layout}
        height={chatHeight}
        busy={state.ask.busy}
        showActivity={state.ask.showActivity}
        scrollRef={scrollRef}
      />
      {toolCalls > 0 || state.ask.busy ? (
        <text height={1} fg={COLOR.dim} onMouseUp={() => onToggleActivity?.()}>
          {state.ask.busy
            ? `Working · ${elapsedSeconds}s · Esc stops this turn · Ctrl+T activity`
            : `${state.ask.showActivity ? "▾" : "▸"} ${toolCalls} tool ${toolCalls === 1 ? "call" : "calls"} · Ctrl+T ${state.ask.showActivity ? "hide details" : "details"}`}
        </text>
      ) : null}
      {readScope ? (
        <text height={readScopeRows} fg={COLOR.dim} wrapMode="word">
          {readScope}
        </text>
      ) : null}
      <CitationBar
        state={state}
        layout={layout}
        rows={citationRows}
        onOpen={onOpenCitation}
        onOpenSource={onOpenSource}
      />
      <InputBar
        width={layout.conversationWidth}
        busy={state.ask.busy}
        value={state.ask.buffer}
        height={inputHeight}
        focused={focused && !state.ask.busy}
        onChange={onBufferChange}
        onSubmit={onSubmit}
      />
    </box>
  );
}

export function citationBarRows(
  paths: ReadonlyArray<string>,
  layout: AskLayout,
  heading = "Sources  ",
  parse = true,
): number {
  if (paths.length === 0) return 0;
  const available = Math.max(1, layout.conversationWidth - 2);
  let rows = 1;
  let used = heading.length;
  for (const path of paths.slice(0, 6)) {
    const width =
      5 + Math.min((parse ? citationLabel(path) : path).length, layout.citationPathWidth) + 2;
    if (used + width > available) {
      rows += 1;
      used = width;
    } else used += width;
  }
  return rows;
}

function sourceHeading(state: AppState, count: number): string {
  return `${state.ask.sources.length ? "Read sources" : "Mentioned notes"}${count > 6 ? ` · ${count}` : ""}`;
}
function sourceItems(
  state: AppState,
  width: number,
): { label: string; source: SourceReference | null; target: string }[] {
  return state.ask.sources.length
    ? state.ask.sources.map((source) => ({
        label: sourceLabel(source, width),
        source,
        target: source.path,
      }))
    : state.ask.citations.map((target) => ({ label: citationLabel(target), source: null, target }));
}
function sourcePage<T>(items: readonly T[], cursor: number): readonly T[] {
  const start = Math.floor(cursor / 6) * 6;
  return items.slice(start, start + 6);
}

function CitationBar({
  state,
  layout,
  rows,
  onOpen,
  onOpenSource,
}: {
  state: AppState;
  layout: AskLayout;
  rows: number;
  onOpen?: (target: string) => void;
  onOpenSource?: (source: SourceReference) => void;
}): React.ReactNode {
  const items = sourceItems(state, layout.citationPathWidth);
  if (items.length === 0) return null;
  const start = Math.floor(state.ask.citationCursor / 6) * 6;
  return (
    <box
      width={layout.conversationWidth}
      height={rows}
      flexShrink={0}
      flexDirection="row"
      flexWrap="wrap"
    >
      <text wrapMode="none">
        <span fg={COLOR.label}>{`${sourceHeading(state, items.length)}  `}</span>
      </text>
      {sourcePage(items, state.ask.citationCursor).map((item, index) => (
        <text
          key={`${start + index}:${item.target}`}
          wrapMode="none"
          onMouseUp={() => (item.source ? onOpenSource?.(item.source) : onOpen?.(item.target))}
        >
          <span fg={start + index === state.ask.citationCursor ? COLOR.accent : COLOR.dim}>
            {`[${start + index + 1}] `}
          </span>
          <span fg={start + index === state.ask.citationCursor ? COLOR.bright : COLOR.text}>
            {`${truncate(item.label, layout.citationPathWidth)}  `}
          </span>
        </text>
      ))}
    </box>
  );
}
