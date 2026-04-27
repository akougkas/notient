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
  /**
   * Per-tool override map. When the tool name is present, the override wins
   * over the conversation-level mode: `auto` skips the gate; `ask` engages
   * it even in yolo mode. Absent entries fall back to mode defaults
   * (safe -> ask, yolo -> auto). Bootstrap populates this from
   * `chat.perTool` settings.
   */
  perToolPolicy?: Record<string, "auto" | "ask">;
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
  private readonly extraListeners = new Set<ApprovalGateEvents>();

  constructor(private readonly options: ApprovalGateOptions) {}

  /**
   * Register an additional listener for the duration of a chat turn. Returns
   * an unsubscribe function. The constructor-supplied `events` always fires;
   * extra listeners fire alongside without replacing it. The chat handler
   * uses this so each turn's NDJSON stream receives `loop:approval_pending`
   * and `loop:approval_resolved` frames scoped to the active envelope id.
   */
  subscribe(listener: ApprovalGateEvents): () => void {
    this.extraListeners.add(listener);
    return () => {
      this.extraListeners.delete(listener);
    };
  }

  private emitPending(pending: PendingApproval): void {
    this.options.events.onPending(pending);
    for (const listener of this.extraListeners) listener.onPending(pending);
  }

  private emitResolved(callId: string, decision: ApprovalDecision): void {
    this.options.events.onResolved(callId, decision);
    for (const listener of this.extraListeners) listener.onResolved(callId, decision);
  }

  policyFor(toolName: string, mode: ApprovalMode): "auto" | "ask" {
    const override = this.options.perToolPolicy?.[toolName];
    if (override !== undefined) return override;
    return mode === "yolo" ? "auto" : "ask";
  }

  async request(
    call: ToolCall,
    mode: ApprovalMode,
    preview: string,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    if (signal.aborted) {
      throw asAbortError();
    }
    if (this.policyFor(call.name, mode) === "auto") {
      await this.options.recordHistoryAutoApprove(call);
      const decision: ApprovalDecision = { approved: true };
      this.emitResolved(call.id, decision);
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
          this.emitResolved(call.id, decision);
          resolve(decision);
        },
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(call.id, pending);
      this.emitPending(pending);
    });
  }

  resolve(callId: string, decision: ApprovalDecision): void {
    const pending = this.pending.get(callId);
    if (!pending) return;
    pending.resolve(decision);
  }

  /**
   * Cancel every pending approval at once. Each waiting promise resolves with
   * `{ approved: false, reason }` so callers can observe the cancellation
   * without a try/catch. Used when the chat turn is aborted while a tool call
   * is still parked at the approval gate.
   */
  cancelAll(reason = "cancelled"): void {
    const entries = Array.from(this.pending.values());
    for (const entry of entries) {
      entry.resolve({ approved: false, reason });
    }
  }

  list(): PendingApproval[] {
    return Array.from(this.pending.values());
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }
}
