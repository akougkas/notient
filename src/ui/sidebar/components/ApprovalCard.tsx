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
      <article
        class="notient-chat-approval notient-chat-approval--auto"
        data-call-id={pending.callId}
      >
        <span class="notient-chat-approval__pill">Auto-approved {pending.toolName}</span>
        {historyId ? (
          <button
            type="button"
            class="notient-chat-approval__undo"
            onClick={() => {
              void actions?.undoLastWrite(historyId);
            }}
          >
            Undo
          </button>
        ) : null}
      </article>
    );
  }

  return (
    <article class="notient-chat-approval" data-call-id={pending.callId}>
      <header class="notient-chat-approval__header">
        <span class="notient-chat-approval__name">{pending.toolName}</span>
        <span class="notient-chat-approval__hint">Review the proposed write before approving.</span>
      </header>
      <pre class="notient-chat-approval__diff">{pending.preview}</pre>
      <footer class="notient-chat-approval__actions">
        <button
          type="button"
          class="notient-chat-approval__approve"
          onClick={() => actions?.resolveApproval(pending.callId, true)}
        >
          Approve
        </button>
        <button
          type="button"
          class="notient-chat-approval__reject"
          onClick={() => setShowRejectInput((current) => !current)}
        >
          Reject
        </button>
      </footer>
      {showRejectInput ? (
        <div class="notient-chat-approval__reject-input">
          <input
            type="text"
            class="notient-chat-approval__reason"
            value={reasonDraft}
            placeholder="Optional reason"
            onInput={(input) => {
              const target = input.currentTarget as HTMLInputElement;
              setReasonDraft(target.value);
            }}
          />
          <button
            type="button"
            class="notient-chat-approval__confirm-reject"
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
