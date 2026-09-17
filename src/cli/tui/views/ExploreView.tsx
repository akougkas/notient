/**
 * A focused note reader with optional extraction evidence and related notes.
 * Source mode exposes the exact Markdown; preview only changes presentation.
 */

import type { ScrollBoxRenderable } from "@opentui/core";
import type React from "react";
import { useEffect, useMemo, useRef } from "react";
import type { NoteSelector } from "../../../api/schema";
import { locateFrontmatter } from "../../../core/markdown/frontmatter";
import type { ExtractionItemWire } from "../../../daemon/wire";
import { Markdown } from "../Markdown";
import type { ExploreLayout } from "../layout";
import type { AppState, ExplorePane } from "../store";
import type { NeighborRowModel } from "../viewModels";
import { noteOutline, sortNeighbors } from "../viewModels";
import { EmptyLine, Panel } from "./Chrome";
import {
  COLOR,
  HORIZONTAL_SCROLLBAR_OPTIONS,
  VERTICAL_SCROLLBAR_OPTIONS,
  basename,
  confidenceColor,
  connectionAssessment,
  connectionLabel,
  truncate,
  truncateMiddle,
  truncatePath,
} from "./theme";

export function ExploreView({
  state,
  layout,
  onOpenSection,
  onPane,
}: {
  state: AppState;
  layout: ExploreLayout;
  onOpenSection?: (selector: NoteSelector) => void;
  onPane?: (pane: ExplorePane) => void;
}): React.ReactNode {
  const explore = state.explore;
  if (explore.notePath === null) {
    return (
      <Panel title="explore" width={layout.width} height={layout.height} active>
        <EmptyLine text="press o to pick a note" />
      </Panel>
    );
  }
  const neighbors = sortNeighbors(explore.neighbors);
  return (
    <box
      width={layout.width}
      height={layout.height}
      paddingLeft={layout.inset}
      flexDirection="column"
    >
      <box width={layout.contentWidth} height={2} paddingTop={1}>
        <text fg={COLOR.bright} wrapMode="none">
          <b>{truncateMiddle(explore.notePath, layout.contentWidth)}</b>
        </text>
      </box>
      <box height={2} flexDirection="row" gap={3}>
        <text
          fg={explore.pane === "body" ? COLOR.accent : COLOR.dim}
          onMouseUp={() => onPane?.("body")}
        >
          {explore.raw ? "Source" : "Read"}
        </text>
        <text
          fg={explore.pane === "view" ? COLOR.accent : COLOR.dim}
          onMouseUp={() => onPane?.("view")}
        >
          Outline
        </text>
        <text
          fg={explore.pane === "neighbors" ? COLOR.accent : COLOR.dim}
          onMouseUp={() => onPane?.("neighbors")}
        >
          Links
        </text>
        <text fg={COLOR.dim}>
          {explore.error
            ? "f open current note"
            : explore.selected
              ? "Cited passage · f full note"
              : "←/→ switch"}
        </text>
      </box>
      <box width={layout.contentWidth} height={layout.scrollHeight} flexDirection="column">
        {explore.pane === "view" ? (
          <ReadingPane state={state} layout={layout} onOpenSection={onOpenSection} />
        ) : (
          renderPane(explore.pane, state, neighbors, layout)
        )}
      </box>
    </box>
  );
}

function renderPane(
  pane: ExplorePane,
  state: AppState,
  neighbors: ReadonlyArray<NeighborRowModel>,
  layout: ExploreLayout,
): React.ReactNode {
  if (pane === "body") return <BodyPane state={state} layout={layout} />;
  if (pane === "view") return <ReadingPane state={state} layout={layout} />;
  return <NeighborsPane state={state} neighbors={neighbors} layout={layout} />;
}

function BodyPane({ state, layout }: { state: AppState; layout: ExploreLayout }): React.ReactNode {
  const explore = state.explore;
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const body = useMemo(() => {
    const text = explore.selected?.quote ?? explore.body ?? "";
    // A complete leading properties block belongs in Outline. Source mode
    // still shows every original byte; partial YAML selections stay visible.
    if (explore.selected && explore.selected.range.start !== 0) return text;
    const frontmatter = locateFrontmatter(text);
    return frontmatter ? text.slice(frontmatter.end).trimStart() : text;
  }, [explore.body, explore.selected]);
  const previous = useRef({ path: explore.notePath, offset: 0 });
  useEffect(() => {
    if (previous.current.path !== explore.notePath) scrollRef.current?.scrollTo({ x: 0, y: 0 });
    else scrollRef.current?.scrollBy(explore.bodyScroll - previous.current.offset);
    previous.current = { path: explore.notePath, offset: explore.bodyScroll };
  }, [explore.bodyScroll, explore.notePath]);
  if (explore.error !== null) return <EmptyLine text={explore.error} />;
  if (explore.body === null) {
    return <EmptyLine text={explore.loading ? "reading…" : "no body"} />;
  }
  return (
    <scrollbox
      ref={scrollRef}
      width={layout.bodyTextWidth}
      height={layout.scrollHeight}
      minHeight={0}
      stickyScroll={false}
      horizontalScrollbarOptions={HORIZONTAL_SCROLLBAR_OPTIONS}
      verticalScrollbarOptions={VERTICAL_SCROLLBAR_OPTIONS}
    >
      <box width={Math.max(1, layout.bodyTextWidth - 1)} flexDirection="column">
        {explore.raw ? (
          <text wrapMode="word" fg={COLOR.text}>
            {explore.selected?.quote ?? explore.body}
          </text>
        ) : (
          <Markdown text={body} />
        )}
      </box>
    </scrollbox>
  );
}

function ReadingPane({
  state,
  layout,
  onOpenSection,
}: {
  state: AppState;
  layout: ExploreLayout;
  onOpenSection?: (selector: NoteSelector) => void;
}): React.ReactNode {
  const explore = state.explore;
  const items = useMemo(() => noteOutline(explore.structure), [explore.structure]);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const previous = useRef({ cursor: explore.outlineCursor, offset: explore.bodyScroll });
  useEffect(() => {
    if (previous.current.cursor !== explore.outlineCursor)
      scrollRef.current?.scrollTo(
        Math.max(0, explore.outlineCursor - Math.floor(layout.scrollHeight / 2)),
      );
    else scrollRef.current?.scrollBy(explore.bodyScroll - previous.current.offset);
    previous.current = { cursor: explore.outlineCursor, offset: explore.bodyScroll };
  }, [explore.outlineCursor, explore.bodyScroll, layout.scrollHeight]);
  const properties = Object.entries(explore.structure?.frontmatter.properties ?? {});
  return (
    <scrollbox
      ref={scrollRef}
      width={layout.readingScrollWidth}
      height={layout.scrollHeight}
      minHeight={0}
      stickyScroll={false}
      horizontalScrollbarOptions={HORIZONTAL_SCROLLBAR_OPTIONS}
      verticalScrollbarOptions={VERTICAL_SCROLLBAR_OPTIONS}
    >
      <box flexDirection="column" width={Math.max(1, layout.readingScrollWidth - 1)}>
        <text fg={COLOR.dim} marginBottom={1}>
          On this note · ↑/↓ choose · Enter opens a section or block
        </text>
        {!items.length ? <EmptyLine text="No headings or explicit blocks in this note." /> : null}
        {items.map((item, index) => (
          <text
            key={`${item.line}-${index}`}
            height={1}
            wrapMode="none"
            fg={index === explore.outlineCursor ? COLOR.accent : COLOR.text}
            onMouseUp={() => onOpenSection?.(item.selector)}
          >
            {`${index === explore.outlineCursor ? "›" : " "} ${"  ".repeat(Math.min(3, item.level - 1))}${truncate(item.label, Math.max(1, layout.readingScrollWidth - 12 - 2 * item.level))}  · ${item.line}`}
          </text>
        ))}
        {explore.structure?.tasks.length ? (
          <text
            fg={COLOR.label}
            marginTop={1}
          >{`${explore.structure.tasks.filter((task) => !task.checked).length} open tasks · ${explore.structure.tasks.filter((task) => task.checked).length} completed`}</text>
        ) : null}
        {properties.length ? (
          <text fg={COLOR.accent} marginTop={2} marginBottom={1}>
            <b>Properties</b>
          </text>
        ) : null}
        {properties.map(([key, value]) => (
          <box key={key} flexDirection="row" gap={2} marginBottom={1}>
            <text
              width={Math.min(18, Math.floor(layout.readingScrollWidth / 3))}
              fg={COLOR.label}
              wrapMode="word"
            >
              {key}
            </text>
            <text flexGrow={1} flexShrink={1} fg={COLOR.text} wrapMode="word">
              {truncate(typeof value === "string" ? value : JSON.stringify(value), 240)}
            </text>
          </box>
        ))}
        {explore.structure?.frontmatter.error ? (
          <text fg={COLOR.warn}>
            Properties could not be parsed: {explore.structure.frontmatter.error}
          </text>
        ) : null}
        <ExtractionGroup label="concepts" items={explore.concepts} layout={layout} />
        <ExtractionGroup label="claims" items={explore.claims} layout={layout} />
        <ExtractionGroup label="questions" items={explore.questions} layout={layout} />
      </box>
    </scrollbox>
  );
}

function NeighborsPane({
  state,
  neighbors,
  layout,
}: {
  state: AppState;
  neighbors: ReadonlyArray<NeighborRowModel>;
  layout: ExploreLayout;
}): React.ReactNode {
  const listRef = useRef<ScrollBoxRenderable | null>(null);
  const listHeight = Math.max(3, Math.floor(layout.scrollHeight * 0.45));
  useEffect(() => {
    listRef.current?.scrollTo({
      x: 0,
      y: Math.max(0, state.explore.neighborCursor - listHeight + 2),
    });
  }, [state.explore.neighborCursor, listHeight]);
  const result = state.explore.connections;
  const selected = neighbors[state.explore.neighborCursor];
  const detail = result?.connections.find((edge) => edge.id === selected?.connectionId);
  if (state.explore.connectionsError) return <EmptyLine text={state.explore.connectionsError} />;
  return (
    <box width={layout.neighborsScrollWidth} height={layout.scrollHeight} flexDirection="column">
      <text fg={COLOR.dim} marginBottom={1} wrapMode="word">
        file · authored link idea · proposed 0–1 · relationship assessment
      </text>
      {result && (result.coverage.state !== "current" || result.truncated) && (
        <text fg={COLOR.warn} marginBottom={1} wrapMode="word">
          {result.coverage.message ?? "Showing a bounded set of connections; more may exist."}
        </text>
      )}
      {neighbors.length === 0 && (
        <EmptyLine
          text={
            result?.coverage.state === "current"
              ? "No indexed connections for this note."
              : "No verified connections available yet."
          }
        />
      )}
      <scrollbox
        ref={listRef}
        height={detail ? listHeight : undefined}
        flexGrow={detail ? 0 : 1}
        minHeight={0}
        horizontalScrollbarOptions={HORIZONTAL_SCROLLBAR_OPTIONS}
        verticalScrollbarOptions={VERTICAL_SCROLLBAR_OPTIONS}
      >
        {neighbors.map((row, index) => (
          <NeighborRow
            key={`${row.table}:${row.direction}:${row.notePath}:${index}`}
            row={row}
            active={index === state.explore.neighborCursor && state.explore.pane === "neighbors"}
            layout={layout}
          />
        ))}
      </scrollbox>
      {detail && (
        <scrollbox
          marginTop={1}
          flexGrow={1}
          minHeight={0}
          horizontalScrollbarOptions={HORIZONTAL_SCROLLBAR_OPTIONS}
          verticalScrollbarOptions={VERTICAL_SCROLLBAR_OPTIONS}
        >
          <text fg={COLOR.accent} wrapMode="word">
            {basename(detail.note.path)}
          </text>
          <text fg={COLOR.dim} wrapMode="word">
            {detail.state === "authored"
              ? "Authored reference · checked against saved files"
              : `${detail.state} relationship · ${detail.author}`}
          </text>
          {detail.rationale && <Markdown text={detail.rationale} />}
          {detail.state !== "authored" && (
            <text fg={COLOR.dim} wrapMode="word">
              {detail.evidenceState === "current"
                ? `${detail.evidence.length} current evidence passage(s)`
                : detail.evidenceState === "stale"
                  ? "Evidence has changed since this relationship was assessed. Review it before relying on the claim."
                  : "Revision-bound evidence is unavailable for this relationship."}
            </text>
          )}
          {detail.evidence.slice(0, 3).map((source, index) => (
            <box key={`${source.path}:${index}`} marginTop={1} flexDirection="column">
              <text fg={COLOR.dim} wrapMode="word">
                {basename(source.path)} · L{source.range.startLine}–{source.range.endLine}
              </text>
              <Markdown text={source.quote} />
            </box>
          ))}
        </scrollbox>
      )}
    </box>
  );
}

function ExtractionGroup({
  label,
  items,
  layout,
}: {
  label: string;
  items: ReadonlyArray<ExtractionItemWire>;
  layout: ExploreLayout;
}): React.ReactNode {
  if (items.length === 0) return null;
  return (
    <box flexDirection="column">
      <text wrapMode="none">
        <span fg={COLOR.accent}>{`${label} (${items.length})`}</span>
      </text>
      {items.slice(0, 12).map((item) => (
        <box key={item.id} flexDirection="column">
          <text wrapMode="word">
            <span fg={confidenceColor(item.confidence)}>
              {`${String(Math.round(item.confidence * 100)).padStart(3)}% `}
            </span>
            <span fg={COLOR.text}>{item.text}</span>
            {item.kind === null ? null : <span fg={COLOR.dim}>{` · ${item.kind}`}</span>}
          </text>
          {item.evidence.slice(0, 1).map((snippet) => (
            <text key={snippet.chunkId} wrapMode="none">
              <span
                fg={COLOR.dim}
              >{`      ${truncate(snippet.text.replace(/\s+/g, " "), layout.evidenceWidth)}`}</span>
            </text>
          ))}
        </box>
      ))}
    </box>
  );
}

function NeighborRow({
  row,
  active,
  layout,
}: {
  row: NeighborRowModel;
  active: boolean;
  layout: ExploreLayout;
}): React.ReactNode {
  return (
    <text wrapMode="none">
      <span fg={COLOR.accent}>{active ? "›" : " "}</span>
      <span fg={COLOR.dim}>{row.direction === "outgoing" ? "→" : "←"}</span>
      <span fg={COLOR.dim}> </span>
      <span fg={row.proposed ? COLOR.proposal : COLOR.label}>
        {truncate(connectionLabel(row.table), layout.neighborTableWidth).padEnd(
          layout.neighborTableWidth,
        )}
      </span>
      <span fg={COLOR.dim}> </span>
      <span fg={COLOR.text}>
        {truncatePath(basename(row.notePath), layout.neighborPathWidth).padEnd(
          layout.neighborPathWidth,
        )}
      </span>
      <span fg={row.proposed ? COLOR.warn : confidenceColor(row.confidence)}>
        {` ${connectionAssessment(row.table, row.proposed, row.confidence).padStart(4)}`}
      </span>
    </text>
  );
}
