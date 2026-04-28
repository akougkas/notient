import type { ScrollBoxRenderable } from "@opentui/core";
import { Fragment, type ReactNode } from "react";
import { type ChatLineKind, chatLineMeta, shouldRenderSpacer } from "./chatLineStyles";

export type ChatLine =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming?: boolean }
  | { kind: "tool"; text: string }
  | { kind: "error"; text: string }
  | { kind: "system"; text: string }
  | { kind: "approval"; text: string; callId: string };

export interface ChatViewProps {
  lines: ChatLine[];
  scrollRef?: React.MutableRefObject<ScrollBoxRenderable | null>;
}

export function ChatView({ lines, scrollRef }: ChatViewProps): ReactNode {
  const kinds = lines.map((line) => line.kind);
  return (
    <scrollbox
      ref={scrollRef ?? undefined}
      flexGrow={1}
      border
      borderStyle="rounded"
      borderColor="#1E293B"
      paddingLeft={1}
      paddingRight={1}
      stickyScroll
      stickyStart="bottom"
    >
      {lines.map((line, index) => (
        <Fragment key={`${line.kind}-${index}`}>
          {shouldRenderSpacer(kinds as ChatLineKind[], index) ? <text> </text> : null}
          <ChatLineRow line={line} />
        </Fragment>
      ))}
    </scrollbox>
  );
}

function ChatLineRow({ line }: { line: ChatLine }): ReactNode {
  const meta = chatLineMeta(line.kind);
  if (line.kind === "approval") {
    return (
      <text>
        <span fg={meta.labelColor}>{`${meta.label} ▸ `}</span>
        <span fg={meta.bodyColor}>{"Tool wants to run. Reply "}</span>
        <span fg="#F8FAFC">{`/approve ${line.callId}`}</span>
        <span fg={meta.bodyColor}>{" or "}</span>
        <span fg="#F8FAFC">{`/deny ${line.callId}`}</span>
        <span fg={meta.bodyColor}>{"."}</span>
      </text>
    );
  }
  return (
    <text>
      <span fg={meta.labelColor}>{`${meta.label} ▸ `}</span>
      <span fg={meta.bodyColor}>{line.text}</span>
    </text>
  );
}
