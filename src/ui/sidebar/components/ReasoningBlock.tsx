import { useState } from "preact/hooks";

export interface ReasoningBlockProps {
  /** The accumulated reasoning text. May be empty during the first tokens. */
  reasoning: string;
  /** When true, the block streams a "Thinking…" indicator while empty. */
  streaming?: boolean;
  /** Override the default collapsed state. Defaults to `true`. */
  defaultOpen?: boolean;
}

/**
 * Collapsible reasoning disclosure rendered inline in the chat. The block is
 * intentionally suppressed when both the reasoning is empty and the turn is
 * not streaming; mounting an always-on chip would clutter the conversation
 * once persistence is disabled. While a turn is in flight an empty block still
 * renders the "Thinking…" affordance so the user has a target to focus.
 */
export function ReasoningBlock({
  reasoning,
  streaming = false,
  defaultOpen = false,
}: ReasoningBlockProps) {
  const [open, setOpen] = useState(defaultOpen);
  const trimmed = reasoning.trim();
  if (trimmed.length === 0 && !streaming) {
    return null;
  }
  const summary = streaming && trimmed.length === 0 ? "Thinking..." : "Show reasoning";
  return (
    <details
      class="notient-chat-reasoning"
      open={open}
      onToggle={(toggleEvent) => {
        const target = toggleEvent.currentTarget as HTMLDetailsElement;
        setOpen(target.open);
      }}
    >
      <summary class="notient-chat-reasoning__summary">{summary}</summary>
      <pre class="notient-chat-reasoning__body">{trimmed}</pre>
    </details>
  );
}
