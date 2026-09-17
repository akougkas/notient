import type { ScrollBoxRenderable } from "@opentui/core";
import { type ReactNode, memo } from "react";
import type { PreparedNoteDraft } from "../../core/chat/tools/draft";
import { Markdown } from "./Markdown";
import { visibleAssistantText } from "./assistantText";
import type { AskLayout } from "./layout";
import {
  COLOR,
  HORIZONTAL_SCROLLBAR_OPTIONS,
  VERTICAL_SCROLLBAR_OPTIONS,
  connectionLabel,
} from "./views/theme";

export type ChatLine =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming?: boolean }
  | { kind: "draft"; draft: PreparedNoteDraft }
  | { kind: "tool"; text: string }
  | { kind: "error"; text: string }
  | { kind: "system"; text: string }
  | { kind: "approval"; text: string; callId: string }
  | {
      kind: "proposal_card";
      proposalId: string;
      table: string;
      source: string;
      target: string;
      confidence: number;
    };

export interface ChatViewProps {
  lines: ChatLine[];
  layout: AskLayout;
  height: number;
  busy?: boolean;
  showActivity?: boolean;
  scrollRef?: React.MutableRefObject<ScrollBoxRenderable | null>;
}

export function ChatView({
  lines,
  layout,
  height,
  busy = false,
  showActivity = false,
  scrollRef,
}: ChatViewProps): ReactNode {
  return (
    <scrollbox
      ref={scrollRef ?? undefined}
      width={layout.conversationScrollWidth}
      height={height}
      minHeight={0}
      stickyScroll
      stickyStart="bottom"
      horizontalScrollbarOptions={HORIZONTAL_SCROLLBAR_OPTIONS}
      verticalScrollbarOptions={VERTICAL_SCROLLBAR_OPTIONS}
    >
      <box width={layout.conversationRowsWidth} flexDirection="column" paddingTop={1}>
        {lines.map((line, index) => {
          if (
            !showActivity &&
            (line.kind === "tool" ||
              (line.kind === "system" && line.text.startsWith("tool-mode for ")))
          )
            return null;
          return (
            <ChatLineRow
              key={`${line.kind}-${index}`}
              line={line}
              streaming={busy && index === lines.length - 1}
            />
          );
        })}
        {busy ? (
          <text fg={COLOR.dim} marginBottom={1}>
            Working with your notes…
          </text>
        ) : null}
      </box>
    </scrollbox>
  );
}

const ChatLineRow = memo(function ChatLineRow({
  line,
  streaming,
}: { line: ChatLine; streaming: boolean }): ReactNode {
  if (line.kind === "draft") {
    return (
      <box
        backgroundColor={COLOR.panel}
        border={["left"]}
        borderColor={COLOR.accent}
        padding={1}
        marginBottom={2}
        flexDirection="column"
      >
        <text fg={COLOR.accent}>
          <b>{line.draft.title}</b>
        </text>
        <text fg={COLOR.dim} marginBottom={1}>
          Unsaved draft · Ctrl+S to edit and review
        </text>
        <Markdown text={line.draft.markdown} />
      </box>
    );
  }
  if (line.kind === "proposal_card") {
    return (
      <box backgroundColor={COLOR.panel} padding={1} marginBottom={1} flexDirection="column">
        <text fg={COLOR.warn}>Relationship to review</text>
        <text
          wrapMode="word"
          fg={COLOR.text}
        >{`${line.source} → ${line.target} · ${connectionLabel(line.table)} · assessment ${line.confidence.toFixed(2)}`}</text>
        <text
          fg={COLOR.label}
          wrapMode="word"
        >{`/approve-edge ${line.proposalId}   /reject-edge ${line.proposalId}`}</text>
      </box>
    );
  }
  if (line.kind === "approval") {
    return (
      <box backgroundColor={COLOR.panel} padding={1} marginBottom={1} flexDirection="column">
        <text fg={COLOR.warn}>Needs your decision</text>
        <text fg={COLOR.text} wrapMode="word">
          {line.text}
        </text>
        <text
          fg={COLOR.label}
          wrapMode="word"
        >{`/approve ${line.callId}   /deny ${line.callId}`}</text>
      </box>
    );
  }
  if (line.kind === "assistant") {
    return (
      <box flexDirection="column" marginBottom={2}>
        <text fg={COLOR.accent} marginBottom={1}>
          <b>Notient</b>
        </text>
        <Markdown text={visibleAssistantText(line.text)} streaming={streaming} />
      </box>
    );
  }
  if (line.kind === "user") {
    return (
      <box
        flexDirection="column"
        border={["left"]}
        borderColor={COLOR.border}
        paddingLeft={2}
        marginBottom={2}
      >
        <text fg={COLOR.dim}>You</text>
        <text fg={COLOR.bright} wrapMode="word">
          {line.text}
        </text>
      </box>
    );
  }
  return (
    <box marginBottom={1}>
      <text fg={line.kind === "error" ? COLOR.bad : COLOR.dim} wrapMode="word">
        {line.text}
      </text>
    </box>
  );
});
