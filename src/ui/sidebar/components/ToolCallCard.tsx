import { useState } from "preact/hooks";
import type { ToolCall, ToolResult } from "../../../core/chat/types";
import { chatActions } from "../chat-state";

export interface ToolCallCardProps {
  call: ToolCall;
  result?: ToolResult;
}

/**
 * Renders a single tool invocation as a collapsible disclosure. Summary
 * carries the tool name and a short result count; expanding reveals the
 * pretty-printed arguments and either the result payload or the error
 * message returned by the tool registry.
 */
export function ToolCallCard({ call, result }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const actions = chatActions.value;
  const status = resolveStatus(result);
  const duration = result ? `${result.durationMs}ms` : "...";
  const historyId = readHistoryId(result);
  const summary = summariseResult(call.name, result);
  return (
    <details
      class={`notient-tool notient-chat-tool notient-chat-tool--${status}`}
      open={expanded}
      data-call-id={call.id}
      onToggle={(toggleEvent) => {
        const target = toggleEvent.currentTarget as HTMLDetailsElement;
        setExpanded(target.open);
      }}
    >
      <summary class="notient-chat-tool__header">
        <span class="notient-tool__head">
          <span class="notient-tool__name notient-chat-tool__name">{call.name}</span>
          <span class="notient-tool__count notient-chat-tool__duration">
            ({summary} · {duration})
          </span>
        </span>
      </summary>
      {historyId ? (
        <button
          type="button"
          class="notient-chat-tool__undo"
          onClick={() => {
            void actions?.undoLastWrite(historyId);
          }}
        >
          Auto-approved · undo
        </button>
      ) : null}
      <div class="notient-tool__body notient-chat-tool__body">
        <h5 class="notient-chat-tool__heading">Arguments</h5>
        <pre class="notient-chat-tool__pre">{formatJson(call.args)}</pre>
        <h5 class="notient-chat-tool__heading">Result</h5>
        <pre class="notient-chat-tool__pre">{formatResult(result)}</pre>
      </div>
    </details>
  );
}

function readHistoryId(result: ToolResult | undefined): string | null {
  if (!result || result.status !== "ok") return null;
  if (!result.data || typeof result.data !== "object") return null;
  const historyId = (result.data as Record<string, unknown>).historyId;
  if (typeof historyId === "number" && Number.isFinite(historyId)) return String(historyId);
  if (typeof historyId === "string" && historyId.length > 0) return historyId;
  return null;
}

function resolveStatus(result: ToolResult | undefined): "pending" | "ok" | "error" {
  if (!result) return "pending";
  return result.status === "ok" ? "ok" : "error";
}

function summariseResult(name: string, result: ToolResult | undefined): string {
  if (!result) return "pending";
  if (result.status === "error") return "error";
  if (!result.data || typeof result.data !== "object") return "ok";
  const data = result.data as Record<string, unknown>;
  if (Array.isArray(data.results)) return `${data.results.length} results`;
  if (Array.isArray(data.hits)) return `${data.hits.length} hits`;
  if (typeof data.lines === "number") return `${data.lines} lines`;
  if (typeof data.applied === "boolean") return data.applied ? "applied" : "no-op";
  void name;
  return "ok";
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
