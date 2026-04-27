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
}

export function ChatView({ lines }: ChatViewProps): React.ReactNode {
  return (
    <scrollbox flexGrow={1} paddingLeft={1} paddingRight={1}>
      {lines.map((line, index) => (
        <text key={`${line.kind}-${index}-${line.text.slice(0, 16)}`} fg={COLORS[line.kind]}>
          {PREFIXES[line.kind]}
          {line.text}
        </text>
      ))}
    </scrollbox>
  );
}
