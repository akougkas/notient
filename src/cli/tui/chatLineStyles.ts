export type ChatLineKind = "user" | "assistant" | "tool" | "error" | "system" | "approval";

export interface ChatLineMeta {
  /** Short label rendered before the body text. */
  readonly label: string;
  /** Color for the label token. */
  readonly labelColor: string;
  /** Color for the body text. */
  readonly bodyColor: string;
}

const META: Record<ChatLineKind, ChatLineMeta> = {
  user: { label: "you", labelColor: "#7DD3FC", bodyColor: "#E2E8F0" },
  assistant: { label: "notient", labelColor: "#34D399", bodyColor: "#F8FAFC" },
  tool: { label: "tool", labelColor: "#FBBF24", bodyColor: "#FCD34D" },
  error: { label: "err", labelColor: "#F87171", bodyColor: "#FCA5A5" },
  system: { label: "·", labelColor: "#475569", bodyColor: "#94A3B8" },
  approval: { label: "approval", labelColor: "#FBBF24", bodyColor: "#FDE68A" },
};

export function chatLineMeta(kind: ChatLineKind): ChatLineMeta {
  return META[kind];
}

/**
 * Indicates whether a blank spacer row should render before the line at
 * `index` to give breathing room around assistant turns. We separate
 * assistant blocks from any preceding non-assistant line, and the line that
 * follows an assistant turn from the assistant block itself.
 */
export function shouldRenderSpacer(kinds: ReadonlyArray<ChatLineKind>, index: number): boolean {
  if (index <= 0) return false;
  const previous = kinds[index - 1];
  const current = kinds[index];
  if (current === "assistant" && previous !== "assistant") return true;
  if (previous === "assistant" && current !== "assistant") return true;
  return false;
}
