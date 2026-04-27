import { useState } from "preact/hooks";
import type { PendingApproval } from "../../../core/chat/approvalGate";
import { chatActions } from "../chat-state";

export interface ApprovalCardProps {
  pending: PendingApproval;
  /**
   * When true the card renders the post-execution auto-approved pill (yolo
   * mode). The optional `historyId` lets the undo button target the right
   * history row through {@link ChatActions.undoLastWrite}.
   */
  autoApproved?: boolean;
  historyId?: string;
}

interface DiffSegment {
  kind: "context" | "add" | "del";
  text: string;
}

function splitDiff(preview: string): DiffSegment[] {
  if (preview.length === 0) return [];
  const lines = preview.split(/\r?\n/);
  const segments: DiffSegment[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const newline = lineIndex < lines.length - 1 ? "\n" : "";
    if (line.startsWith("+") && !line.startsWith("+++")) {
      segments.push({ kind: "add", text: `${line}${newline}` });
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      segments.push({ kind: "del", text: `${line}${newline}` });
    } else {
      segments.push({ kind: "context", text: `${line}${newline}` });
    }
  }
  return segments;
}

/**
 * Renders a write-tool approval request inline in the chat. In safe mode the
 * card surfaces the unified diff returned by the tool's preview and offers
 * approve/reject buttons. In yolo mode the same component renders a compact
 * "auto-approved" pill that exposes a single-click undo.
 */
export function ApprovalCard({ pending, autoApproved = false, historyId }: ApprovalCardProps) {
  const actions = chatActions.value;
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [reasonDraft, setReasonDraft] = useState("");

  if (autoApproved) {
    return (
      <button
        type="button"
        class="notient-approval notient-approval--auto notient-chat-approval notient-chat-approval--auto"
        data-call-id={pending.callId}
        onClick={() => {
          if (!historyId) return;
          void actions?.undoLastWrite(historyId);
        }}
      >
        <span class="notient-chat-approval__pill">Auto-approved {pending.toolName}</span>
        {historyId ? <span class="notient-chat-approval__undo">Undo</span> : null}
      </button>
    );
  }

  const segments = splitDiff(pending.preview);

  return (
    <article class="notient-approval notient-chat-approval" data-call-id={pending.callId}>
      <header class="notient-approval__head notient-chat-approval__header">
        <h4 class="notient-approval__title notient-chat-approval__name">{pending.toolName}</h4>
        <span class="notient-pip">write</span>
      </header>
      <pre class="notient-approval__diff notient-chat-approval__diff">
        {segments.map((segment, segmentIndex) => {
          const key = `${segment.kind}-${segmentIndex}-${segment.text.slice(0, 16)}`;
          if (segment.kind === "context") {
            return <span key={key}>{segment.text}</span>;
          }
          return (
            <span key={key} class={segment.kind}>
              {segment.text}
            </span>
          );
        })}
      </pre>
      <footer class="notient-approval__actions notient-chat-approval__actions">
        <button
          type="button"
          class="notient-button notient-chat-approval__approve"
          data-emphasis="primary"
          onClick={() => actions?.resolveApproval(pending.callId, true)}
        >
          Approve
        </button>
        <button
          type="button"
          class="notient-button notient-chat-approval__reject"
          data-emphasis="ghost"
          data-tone="danger"
          onClick={() => setShowRejectInput((current) => !current)}
        >
          Reject
        </button>
      </footer>
      {showRejectInput ? (
        <div class="notient-chat-approval__reject-input">
          <input
            type="text"
            class="notient-composer__field notient-chat-approval__reason"
            value={reasonDraft}
            placeholder="Optional reason"
            onInput={(input) => {
              const target = input.currentTarget as HTMLInputElement;
              setReasonDraft(target.value);
            }}
          />
          <button
            type="button"
            class="notient-button notient-chat-approval__confirm-reject"
            data-tone="danger"
            onClick={() => {
              actions?.resolveApproval(pending.callId, false, reasonDraft.trim() || undefined);
              setShowRejectInput(false);
              setReasonDraft("");
            }}
          >
            Confirm reject
          </button>
        </div>
      ) : null}
    </article>
  );
}
