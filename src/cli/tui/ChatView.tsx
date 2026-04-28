import type { ScrollBoxRenderable } from "@opentui/core";
import type React from "react";

export type ChatLine =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming?: boolean }
  | { kind: "tool"; text: string }
  | { kind: "error"; text: string }
  | { kind: "system"; text: string }
  | { kind: "approval"; text: string; callId: string };

const COLORS: Record<ChatLine["kind"], string> = {
  user: "#7DD3FC",
  assistant: "#FFFFFF",
  tool: "#A78BFA",
  error: "#F87171",
  system: "#94A3B8",
  approval: "#FBBF24",
};

const PREFIXES: Record<ChatLine["kind"], string> = {
  user: "› ",
  assistant: "  ",
  tool: "↻ ",
  error: "✗ ",
  system: "· ",
  approval: "? ",
};

export interface ChatViewProps {
  lines: ChatLine[];
  scrollRef?: React.MutableRefObject<ScrollBoxRenderable | null>;
}

export function ChatView({ lines, scrollRef }: ChatViewProps): React.ReactNode {
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
        <text key={`${line.kind}-${index}`} fg={COLORS[line.kind]}>
          {PREFIXES[line.kind]}
          {line.text}
        </text>
      ))}
    </scrollbox>
  );
}
