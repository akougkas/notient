import { useState } from "preact/hooks";
import type { ToolCall, ToolResult } from "../../../core/chat/types";

export interface ToolCallCardProps {
  call: ToolCall;
  result?: ToolResult;
}

/**
 * Renders a single tool invocation as a collapsible card. The header carries
 * the tool name, the duration, and a status icon. Expanding the card reveals
 * the pretty-printed arguments and either the result payload or the error
 * message returned by the tool registry.
 */
export function ToolCallCard({ call, result }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const status = resolveStatus(result);
  const duration = result ? `${result.durationMs}ms` : "...";
  return (
    <article class={`notient-chat-tool notient-chat-tool--${status}`} data-call-id={call.id}>
      <button
        type="button"
        class="notient-chat-tool__header"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        <span class="notient-chat-tool__icon" aria-hidden="true">
          {iconFor(status)}
        </span>
        <span class="notient-chat-tool__name">{call.name}</span>
        <span class="notient-chat-tool__duration">{duration}</span>
      </button>
      {expanded ? (
        <div class="notient-chat-tool__body">
          <h5 class="notient-chat-tool__heading">Arguments</h5>
          <pre class="notient-chat-tool__pre">{formatJson(call.args)}</pre>
          <h5 class="notient-chat-tool__heading">Result</h5>
          <pre class="notient-chat-tool__pre">{formatResult(result)}</pre>
        </div>
      ) : null}
    </article>
  );
}

function resolveStatus(result: ToolResult | undefined): "pending" | "ok" | "error" {
  if (!result) return "pending";
  return result.status === "ok" ? "ok" : "error";
}

function iconFor(status: "pending" | "ok" | "error"): string {
  switch (status) {
    case "ok":
      return "OK";
    case "error":
      return "ERR";
    default:
      return "...";
  }
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatResult(result: ToolResult | undefined): string {
  if (!result) return "(pending)";
  if (result.status === "error") {
    return result.error ?? "tool failed";
  }
  return formatJson(result.data ?? null);
}
