/**
 * Frame around the five views: the top bar, the bottom key hints, the
 * command/filter prompt line, and the disconnected banner.
 */

import type React from "react";
import { type KeyHint, keyHints } from "../keymap";
import { type ChromeLayout, readingColumn } from "../layout";
import type { AppState } from "../store";
import { type TopBarModel, buildTopBar } from "../viewModels";
import { COLOR, truncate, truncateMiddle } from "./theme";

type SegmentTone = "accent" | "bright" | "label" | "dim" | "ok" | "warn" | "bad";

interface ChromeSegment {
  readonly id: string;
  readonly text: string;
  readonly tone: SegmentTone;
}

export interface TopBarDisplay {
  readonly left: ReadonlyArray<ChromeSegment>;
  readonly right: ReadonlyArray<ChromeSegment>;
  readonly leftWidth: number;
  readonly rightWidth: number;
}

function segmentsWidth(segments: ReadonlyArray<ChromeSegment>): number {
  return segments.reduce((sum, segment) => sum + segment.text.length, 0);
}

function daemonTone(daemon: string): SegmentTone {
  if (daemon === "ready") return "ok";
  if (daemon === "disconnected") return "bad";
  return "warn";
}

/** Compact navigation chrome; operational details live in Status and Review. */
export function buildTopBarDisplay(model: TopBarModel, layout: ChromeLayout): TopBarDisplay {
  const active = model.tabs.find((tab) => tab.active)?.title ?? "Chat";
  const right: ChromeSegment[] = [];
  if (model.pending === null || model.pending > 0 || model.pendingStale) {
    right.push({
      id: "pending",
      text: `Review ${model.pending === null ? "?" : `${model.pendingStale ? "~" : ""}${model.pending}`}  `,
      tone: model.pending === null ? "dim" : "warn",
    });
  }
  right.push({ id: "view", text: active, tone: "bright" });
  right.push({ id: "daemon", text: `  · ${model.daemon}`, tone: daemonTone(model.daemon) });
  const rightWidth = segmentsWidth(right);
  const vaultWidth = Math.max(1, Math.min(32, layout.innerWidth - rightWidth - 15));
  const left: ChromeSegment[] = [
    { id: "brand", text: "notient", tone: "accent" },
    { id: "separator", text: "  /  ", tone: "dim" },
    { id: "vault", text: truncateMiddle(model.vault, vaultWidth), tone: "label" },
  ];
  return { left, right, leftWidth: segmentsWidth(left), rightWidth };
}

export function TopBar({
  state,
  layout,
}: { state: AppState; layout: ChromeLayout }): React.ReactNode {
  const model = buildTopBar(state);
  const display = buildTopBarDisplay(model, layout);
  return (
    <box
      width={layout.width}
      height={1}
      flexShrink={0}
      backgroundColor={COLOR.panel}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="row"
      justifyContent="space-between"
    >
      <text wrapMode="none">
        {display.left.map((segment) => (
          <span key={segment.id} fg={COLOR[segment.tone]}>
            {segment.text}
          </span>
        ))}
      </text>
      <text wrapMode="none">
        {display.right.map((segment) => (
          <span key={segment.id} fg={COLOR[segment.tone]}>
            {segment.text}
          </span>
        ))}
      </text>
    </box>
  );
}

export function fitKeyHints(hints: ReadonlyArray<KeyHint>, maxWidth: number): KeyHint[] {
  const visible: KeyHint[] = [];
  let used = 0;
  for (const hint of hints) {
    const width = hint.keys.length + 1 + hint.label.length + (visible.length === 0 ? 0 : 3);
    if (visible.length > 0 && used + width > maxWidth) break;
    visible.push(hint);
    used += width;
  }
  return visible;
}

export function KeyHintBar({
  state,
  layout,
}: {
  state: AppState;
  layout: ChromeLayout;
}): React.ReactNode {
  const column = controlColumn(state, layout);
  const hints = fitKeyHints(keyHints(state), column.width);
  return (
    <box
      width={layout.width}
      height={1}
      flexShrink={0}
      paddingLeft={column.inset}
      paddingRight={1}
      flexDirection="row"
    >
      <text wrapMode="none">
        {hints.map((hint, index) => (
          <span key={hint.keys}>
            <span fg={COLOR.text}>{hint.keys}</span>
            <span fg={COLOR.dim}>{` ${hint.label}${index === hints.length - 1 ? "" : " · "}`}</span>
          </span>
        ))}
      </text>
    </box>
  );
}

const PROMPT_LABEL: Record<string, string> = {
  navigation: "Go to  ",
  command: ":",
  "inbox-filter": "filter ",
  "stream-filter": "filter ",
  "note-picker": "open ",
  "conversation-picker": "threads ",
};

export function PromptLine({
  state,
  layout,
}: {
  state: AppState;
  layout: ChromeLayout;
}): React.ReactNode {
  if (state.prompt.kind === null) return null;
  const label = PROMPT_LABEL[state.prompt.kind] ?? ":";
  const offset = Math.max(0, state.prompt.cursor - 5);
  const matches = state.prompt.matches.slice(offset, offset + 6);
  const column = controlColumn(state, layout);
  return (
    <box width={layout.width} paddingLeft={column.inset} flexDirection="column" flexShrink={0}>
      <box
        width={column.width}
        height={1}
        flexShrink={0}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={COLOR.panel}
      >
        <text wrapMode="none">
          <span fg={COLOR.accent}>{label}</span>
          <span fg={COLOR.bright}>{state.prompt.buffer}</span>
          <span fg={COLOR.accent}>▏</span>
        </text>
      </box>
      {matches.map((match, index) => (
        <box key={match} height={1} paddingLeft={2}>
          <text wrapMode="none">
            <span fg={index + offset === state.prompt.cursor ? COLOR.accent : COLOR.dim}>
              {index + offset === state.prompt.cursor ? "› " : "  "}
            </span>
            <span fg={index + offset === state.prompt.cursor ? COLOR.bright : COLOR.label}>
              {truncateMiddle(match, Math.max(1, column.width - 4))}
            </span>
          </text>
        </box>
      ))}
    </box>
  );
}

export function DisconnectedBanner({
  state,
  layout,
}: {
  state: AppState;
  layout: ChromeLayout;
}): React.ReactNode {
  if (state.connection.connected) return null;
  return (
    <box
      width={layout.width}
      height={1}
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor="#3F1D1D"
    >
      <text wrapMode="none">
        <span fg={COLOR.bad}>{"daemon disconnected "}</span>
        <span fg={COLOR.label}>
          {state.connection.reconnecting
            ? "· reconnecting…"
            : truncate(
                `· ${state.connection.reason ?? "connection lost"} · press any key to reconnect`,
                Math.max(1, layout.messageWidth - 20),
              )}
        </span>
      </text>
    </box>
  );
}

export function NoticeLine({
  state,
  layout,
}: {
  state: AppState;
  layout: ChromeLayout;
}): React.ReactNode {
  if (state.notice === null) return null;
  const column = controlColumn(state, layout);
  const routine =
    state.notice === "Conversation restored." ||
    state.notice.startsWith("New thread.") ||
    state.notice.startsWith("Reconnected.");
  return (
    <box width={layout.width} height={1} flexShrink={0} paddingLeft={column.inset} paddingRight={1}>
      <text wrapMode="none">
        <span fg={routine ? COLOR.dim : COLOR.warn}>{truncate(state.notice, column.width)}</span>
      </text>
    </box>
  );
}

function controlColumn(state: AppState, layout: ChromeLayout) {
  return state.view === "ask" || state.view === "explore"
    ? readingColumn(layout.width)
    : { width: layout.innerWidth, inset: 1 };
}

/** Section frame shared by the view panels. */
export function Panel({
  title,
  active,
  grow,
  width,
  height,
  children,
}: {
  title: string;
  active?: boolean;
  grow?: number;
  width: number;
  height?: number;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <box
      flexDirection="column"
      flexGrow={grow ?? 0}
      flexShrink={height === undefined ? 1 : 0}
      minHeight={0}
      width={width}
      {...(height === undefined ? {} : { height })}
      border
      borderStyle="rounded"
      borderColor={active === true ? COLOR.borderActive : COLOR.border}
      paddingLeft={1}
      paddingRight={1}
    >
      <text height={1} flexShrink={0} wrapMode="none">
        <span fg={active === true ? COLOR.accent : COLOR.label}>{title}</span>
      </text>
      {children}
    </box>
  );
}

export function EmptyLine({ text }: { text: string }): React.ReactNode {
  return (
    <text wrapMode="none">
      <span fg={COLOR.dim}>{text}</span>
    </text>
  );
}
