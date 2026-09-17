import { describeIndexing } from "../../../api/indexing";
/**
 * Home: what the vault currently is, what the swarm just found, and what
 * the awaken run is doing.
 *
 * Every panel is driven by `vault.stats`, `health.probe`, and the
 * `agent.events` ledger. When a source has produced nothing, the panel says
 * so — there is no fixed roster of agents rendered as permanently idle.
 */

import type React from "react";
import type { HomeLayout } from "../layout";
import type { AppState } from "../store";
import {
  buildAwakenCard,
  buildDiscoveryRows,
  buildEdgeBreakdown,
  buildEndpointRows,
  buildPendingCounts,
  buildVitalsCards,
} from "../viewModels";
import { EmptyLine, Panel } from "./Chrome";
import {
  COLOR,
  HORIZONTAL_SCROLLBAR_OPTIONS,
  VERTICAL_SCROLLBAR_OPTIONS,
  truncate,
  truncatePath,
} from "./theme";

export function HomeView({
  state,
  layout,
}: {
  state: AppState;
  layout: HomeLayout;
}): React.ReactNode {
  const cards = buildVitalsCards(state.stats, buildPendingCounts(state));
  const breakdown = buildEdgeBreakdown(state.stats);
  const awaken = buildAwakenCard(state.stats, layout.awakenBarWidth);
  const endpoints = buildEndpointRows(state.endpoints);
  const discoveries = buildDiscoveryRows(state.stream.events);
  const vitalsTitle =
    state.stats === null
      ? state.statsError === null && state.connection.connected
        ? "vitals"
        : "vitals (unavailable)"
      : state.statsError === null && state.connection.connected
        ? "vitals"
        : "vitals (stale)";

  return (
    <box width={layout.width} flexDirection="column" flexGrow={1}>
      <IndexingStatus state={state} layout={layout} />
      <Panel title={vitalsTitle} width={layout.vitalsWidth} height={layout.vitalsHeight}>
        {cards.length === 0 ? (
          <EmptyLine text={state.statsError ?? "waiting for the first vault.stats reading…"} />
        ) : (
          <box flexDirection="row" flexWrap="wrap">
            {cards.map((card) => (
              <box key={card.label} width={layout.cardWidth} flexDirection="column">
                <text wrapMode="none">
                  <span fg={COLOR.bright}>{card.value}</span>
                </text>
                <text wrapMode="none">
                  <span fg={COLOR.dim}>{card.label}</span>
                </text>
              </box>
            ))}
          </box>
        )}
      </Panel>

      <box width={layout.width} height={layout.statusHeight} flexDirection="row">
        <Panel title="awaken" width={layout.awakenWidth} height={layout.statusHeight}>
          {awaken === null ? (
            <EmptyLine text="no run recorded · press w to awaken the vault" />
          ) : (
            <box flexDirection="column">
              <text wrapMode="none">
                <span fg={awakenColor(awaken.status)}>{awaken.status}</span>
                <span fg={COLOR.label}>{`  ${awaken.processed}/${awaken.total}  `}</span>
                <span fg={COLOR.accent}>{awaken.bar}</span>
                <span fg={COLOR.label}>{` ${awaken.percent}%`}</span>
              </text>
              <text wrapMode="none">
                <span fg={awaken.failed > 0 ? COLOR.bad : COLOR.dim}>
                  {truncate(awaken.detail, Math.max(8, layout.awakenWidth - 4))}
                </span>
              </text>
            </box>
          )}
        </Panel>
        <Panel title="endpoints" width={layout.endpointsWidth} height={layout.statusHeight}>
          {endpoints.length === 0 ? (
            <EmptyLine text="none configured" />
          ) : (
            endpoints.map((endpoint) => (
              <text key={endpoint.label} height={1} flexShrink={0} wrapMode="none">
                <span fg={endpoint.state === "ok" ? COLOR.ok : COLOR.bad}>
                  {endpoint.state === "ok" ? "● " : "○ "}
                </span>
                <span fg={COLOR.text}>{truncate(endpoint.label, layout.endpointLabelWidth)}</span>
              </text>
            ))
          )}
        </Panel>
      </box>

      <box width={layout.width} height={layout.bottomHeight} minHeight={0} flexDirection="row">
        <Panel title="typed edges" width={layout.typedEdgesWidth} height={layout.bottomHeight}>
          {breakdown.length === 0 ? (
            <EmptyLine text="no typed edges yet" />
          ) : (
            <scrollbox
              width={layout.edgeScrollWidth}
              height={layout.bottomScrollHeight}
              minHeight={0}
              stickyScroll={false}
              horizontalScrollbarOptions={HORIZONTAL_SCROLLBAR_OPTIONS}
              verticalScrollbarOptions={VERTICAL_SCROLLBAR_OPTIONS}
            >
              {breakdown.map((row) => {
                const approved = `${row.approved} ok`;
                const pending = `${row.pending} pending`;
                return (
                  <text key={row.table} wrapMode="none">
                    <span fg={COLOR.label}>
                      {truncate(row.table, layout.edgeTableWidth).padEnd(layout.edgeTableWidth)}
                    </span>
                    <span fg={COLOR.dim}> </span>
                    <span fg={COLOR.ok}>{approved}</span>
                    <span fg={COLOR.dim}> </span>
                    <span fg={row.pending > 0 ? COLOR.warn : COLOR.dim}>{pending}</span>
                  </text>
                );
              })}
            </scrollbox>
          )}
        </Panel>
        <Panel
          title="recent discoveries"
          width={layout.discoveriesWidth}
          height={layout.bottomHeight}
        >
          {discoveries.length === 0 ? (
            <EmptyLine
              text={truncate(
                "your notes have made no new connections yet",
                layout.discoveryRowsWidth,
              )}
            />
          ) : (
            <scrollbox
              width={layout.discoveryScrollWidth}
              height={layout.bottomScrollHeight}
              minHeight={0}
              stickyScroll={false}
              horizontalScrollbarOptions={HORIZONTAL_SCROLLBAR_OPTIONS}
              verticalScrollbarOptions={VERTICAL_SCROLLBAR_OPTIONS}
            >
              {discoveries.map((row) => (
                <text key={row.id} wrapMode="none">
                  <span fg={COLOR.proposal}>
                    {truncate(row.type, layout.discoveryTypeWidth).padEnd(
                      layout.discoveryTypeWidth,
                    )}
                  </span>
                  <span fg={COLOR.text}>
                    {truncate(row.summary, layout.discoverySummaryWidth).padEnd(
                      layout.discoverySummaryWidth,
                    )}
                  </span>
                  <span fg={COLOR.dim}>
                    {row.notePath === null
                      ? "".padEnd(layout.discoveryPathWidth)
                      : truncatePath(row.notePath, layout.discoveryPathWidth)}
                  </span>
                </text>
              ))}
            </scrollbox>
          )}
        </Panel>
      </box>
    </box>
  );
}

function awakenColor(status: string): string {
  switch (status) {
    case "running":
      return COLOR.accent;
    case "paused":
      return COLOR.warn;
    case "completed":
      return COLOR.ok;
    case "failed":
      return COLOR.bad;
    default:
      return COLOR.dim;
  }
}

function IndexingStatus({
  state,
  layout,
}: { state: AppState; layout: HomeLayout }): React.ReactNode {
  const indexing = state.status?.indexing;
  const indexingStale = state.statusError !== null || !state.connection.connected;
  const failure = indexing?.failures[0];
  return (
    <box height={layout.indexingHeight} flexShrink={0} flexDirection="column">
      <text height={1} wrapMode="none">
        <span
          fg={
            indexingStale || indexing?.failed
              ? COLOR.bad
              : indexing?.state === "current"
                ? COLOR.ok
                : COLOR.warn
          }
        >
          {truncate(
            indexingStale
              ? "Search indexing status unavailable (last reading is stale)"
              : indexing
                ? describeIndexing(indexing)
                : "Waiting for search indexing status…",
            layout.width,
          )}
        </span>
      </text>
      <text height={1} wrapMode="none">
        <span fg={failure ? COLOR.bad : COLOR.dim}>
          {truncate(
            failure
              ? `${failure.path}: ${failure.message}`
              : "Structural and lexical index · semantic embeddings and AI extraction are separate",
            layout.width,
          )}
        </span>
      </text>
    </box>
  );
}
