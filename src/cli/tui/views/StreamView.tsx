/**
 * Stream: a tail of the `agent_event` ledger — indexer, swarm, and search
 * traffic — with a substring filter on `/`.
 */

import type { ScrollBoxRenderable } from "@opentui/core";
import type React from "react";
import type { StreamLayout } from "../layout";
import type { AppState } from "../store";
import { buildStreamRows, streamCountLabel } from "../viewModels";
import { EmptyLine, Panel } from "./Chrome";
import { COLOR, HORIZONTAL_SCROLLBAR_OPTIONS, VERTICAL_SCROLLBAR_OPTIONS, truncate } from "./theme";

export interface StreamViewProps {
  state: AppState;
  layout: StreamLayout;
  scrollRef: React.MutableRefObject<ScrollBoxRenderable | null>;
}

export function StreamView({ state, layout, scrollRef }: StreamViewProps): React.ReactNode {
  const rows = buildStreamRows(state.stream.events, state.stream.filter);
  const filter = state.stream.filter.trim();
  const count = streamCountLabel(rows.length, state.stream.events.length);
  const headerLeftWidth = Math.max(1, layout.rowsWidth - count.length);
  return (
    <Panel title="events" width={layout.width} height={layout.height} active>
      <box width={layout.rowsWidth} height={1} flexDirection="row">
        <text width={headerLeftWidth} wrapMode="none">
          <span fg={COLOR.dim}>
            {truncate(filter.length === 0 ? "latest first" : `filter: ${filter}`, headerLeftWidth)}
          </span>
        </text>
        <text wrapMode="none">
          <span fg={COLOR.label}>{count}</span>
        </text>
      </box>
      {rows.length === 0 ? (
        <EmptyLine
          text={
            state.stream.events.length === 0
              ? "no events recorded yet"
              : "no events match the filter"
          }
        />
      ) : (
        <scrollbox
          ref={scrollRef}
          width={layout.scrollWidth}
          height={layout.scrollHeight}
          minHeight={0}
          stickyScroll
          stickyStart="top"
          horizontalScrollbarOptions={HORIZONTAL_SCROLLBAR_OPTIONS}
          verticalScrollbarOptions={VERTICAL_SCROLLBAR_OPTIONS}
        >
          {rows.map((row) => (
            <box key={row.id} width={layout.rowsWidth} height={1} flexDirection="row">
              <box width={layout.timestampWidth}>
                <text wrapMode="none">
                  <span fg={COLOR.dim}>{row.time}</span>
                </text>
              </box>
              <box width={layout.typeWidth}>
                <text wrapMode="none">
                  <span fg={eventColor(row.type)}>{truncate(row.type, layout.typeWidth - 1)}</span>
                </text>
              </box>
              <box width={layout.summaryWidth}>
                <text wrapMode="none">
                  <span fg={COLOR.text}>{truncate(row.summary, layout.summaryWidth)}</span>
                </text>
              </box>
            </box>
          ))}
        </scrollbox>
      )}
    </Panel>
  );
}

function eventColor(type: string): string {
  if (type.startsWith("swarm:")) return COLOR.proposal;
  if (type.includes("error")) return COLOR.bad;
  if (type.includes("warn")) return COLOR.warn;
  return COLOR.accent;
}
