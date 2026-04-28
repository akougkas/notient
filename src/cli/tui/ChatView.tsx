import type { ScrollBoxRenderable } from "@opentui/core";
import { Fragment, type ReactNode } from "react";
import { type AssistantSegment, parseAssistantText } from "./assistantText";
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
  if (line.kind === "assistant") {
    return (
      <AssistantLine text={line.text} labelColor={meta.labelColor} bodyColor={meta.bodyColor} />
    );
  }
  return (
    <text wrapMode="word">
      <span fg={meta.labelColor}>{`${meta.label} ▸ `}</span>
      <span fg={meta.bodyColor}>{line.text}</span>
    </text>
  );
}

interface AssistantLineProps {
  text: string;
  labelColor: string;
  bodyColor: string;
}

function AssistantLine({ text, labelColor, bodyColor }: AssistantLineProps): ReactNode {
  const segments = parseAssistantText(text);
  if (segments.length === 0) {
    return (
      <text>
        <span fg={labelColor}>{"notient ▸ "}</span>
      </text>
    );
  }
  let labelEmitted = false;
  return (
    <box flexDirection="column">
      {segments.map((segment, index) => {
        if (segment.type === "prose") {
          const showLabel = !labelEmitted;
          if (showLabel) labelEmitted = true;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are deterministically derived from the line text and never reorder.
            <text key={`prose-${index}`} wrapMode="word">
              {showLabel ? (
                <span fg={labelColor}>{"notient ▸ "}</span>
              ) : (
                <span fg={bodyColor}>{"  "}</span>
              )}
              <span fg={bodyColor}>{segment.text}</span>
            </text>
          );
        }
        // biome-ignore lint/suspicious/noArrayIndexKey: segments are deterministically derived from the line text and never reorder.
        return <CodeSegment key={`code-${index}`} segment={segment} />;
      })}
    </box>
  );
}

function CodeSegment({ segment }: { segment: AssistantSegment }): ReactNode {
  if (segment.type !== "code") return null;
  return (
    <box backgroundColor="#0F172A" paddingLeft={1} paddingRight={1}>
      <text wrapMode="none">
        {segment.lang.length > 0 ? <span fg="#64748B">{`${segment.lang}\n`}</span> : null}
        <span fg="#E2E8F0">{segment.text}</span>
      </text>
    </box>
  );
}
