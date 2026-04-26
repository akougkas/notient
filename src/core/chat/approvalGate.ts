/**
 * Per-call approval gate for chat write tools.
 *
 * Every write-gated tool routes through `request(call, mode, preview, signal)`
 * before touching the vault. In `safe` mode the promise blocks until the UI
 * calls `resolve(callId, decision)`; in `yolo` mode it auto-approves and
 * records to the history table for one-click undo.
 *
 * Aborting the per-call signal rejects the pending promise with an AbortError
 * and removes the entry from the pending map so the UI does not leak a card.
 */

import type { ApprovalMode, ToolCall } from "./types";

export interface PendingApproval {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  preview: string;
  resolve: (decision: ApprovalDecision) => void;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
}

export interface ApprovalGateEvents {
  onPending: (pending: PendingApproval) => void;
  onResolved: (callId: string, decision: ApprovalDecision) => void;
}

export interface ApprovalGateOptions {
  events: ApprovalGateEvents;
  /**
   * Yolo-mode hook. Tool implementations also write their own history rows on
   * success; this hook runs first so the history shows the auto-approval
   * decision even if the subsequent write fails.
   */
  recordHistoryAutoApprove: (call: ToolCall) => Promise<void>;
}

function asAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("aborted", "AbortError");
  }
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

export class ApprovalGate {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly options: ApprovalGateOptions) {}

  async request(
    call: ToolCall,
    mode: ApprovalMode,
    preview: string,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    if (signal.aborted) {
      throw asAbortError();
    }
    if (mode === "yolo") {
      await this.options.recordHistoryAutoApprove(call);
      const decision: ApprovalDecision = { approved: true };
      this.options.events.onResolved(call.id, decision);
      return decision;
    }
    return new Promise<ApprovalDecision>((resolve, reject) => {
      const onAbort = (): void => {
        this.pending.delete(call.id);
        signal.removeEventListener("abort", onAbort);
        reject(asAbortError());
      };
      const pending: PendingApproval = {
        callId: call.id,
        toolName: call.name,
        args: call.args,
        preview,
        resolve: (decision) => {
          if (!this.pending.has(call.id)) return;
          this.pending.delete(call.id);
          signal.removeEventListener("abort", onAbort);
          this.options.events.onResolved(call.id, decision);
          resolve(decision);
        },
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(call.id, pending);
      this.options.events.onPending(pending);
    });
  }

  resolve(callId: string, decision: ApprovalDecision): void {
    const pending = this.pending.get(callId);
    if (!pending) return;
    pending.resolve(decision);
  }

  list(): PendingApproval[] {
    return Array.from(this.pending.values());
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }
}
