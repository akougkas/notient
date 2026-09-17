/**
 * `approvals.pending` — what the approval gate is currently blocking on.
 *
 * The chat stream already pushes `loop:approval_pending` to the connection
 * that owns the turn. This is the other half: any human client can ask what
 * is parked right now, so the TUI Inbox shows a write that a different
 * connection (or an earlier TUI session) left waiting.
 *
 * Read-only by construction: `ApprovalGate.listPending()` projects the
 * pending map without touching it. `chat.approve` (admin) is the only way
 * to resolve one.
 */

import type { ApprovalGate } from "../../core/chat/approvalGate";
import type { MethodHandler } from "../rpc";
import type { ApprovalsPendingResult, PendingApprovalWire } from "../wire";

export interface ApprovalsPendingDeps {
  approvalGate: Pick<ApprovalGate, "listPending">;
}

export function collectPendingApprovals(
  deps: ApprovalsPendingDeps,
  requestedBy?: string,
): ApprovalsPendingResult {
  const approvals: PendingApprovalWire[] = deps.approvalGate
    .listPending()
    .filter((entry) => requestedBy === undefined || entry.requestedBy === requestedBy)
    .map((entry) => ({
      callId: entry.callId,
      tool: entry.toolName,
      preview: entry.preview,
      path: entry.path,
      requestedBy: entry.requestedBy,
      requestedAt: entry.requestedAt,
    }));
  return { ok: true, approvals };
}

export function makeApprovalsPendingHandler(deps: ApprovalsPendingDeps): MethodHandler {
  return async ({ principal }) => {
    return collectPendingApprovals(
      deps,
      principal.kind === "human" ? undefined : principal.id,
    ) as unknown as Record<string, unknown>;
  };
}
