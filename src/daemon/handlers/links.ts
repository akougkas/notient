/** Canonical daemon authority for replaying approved edge writebacks. */

import type { ApprovalService } from "../../core/approvals/approvalService";
import { type MethodHandler, RpcError } from "../rpc";
import type { LinksSyncResult } from "../wire";

export interface LinksSyncHandlerDeps {
  approvalService: Pick<ApprovalService, "reconcilePendingApplications">;
}

export function makeLinksSyncHandler(deps: LinksSyncHandlerDeps): MethodHandler {
  return async () => {
    const result = await deps.approvalService.reconcilePendingApplications();
    if (result.deferred)
      throw new RpcError(
        "CONFLICT",
        `${result.deferred} approved write(s) await Obsidian editor protection; ${result.replayed} reconciled, ${result.abandoned} abandoned, ${result.failed} failed.`,
      );
    return {
      ok: true,
      replayed: result.replayed,
      abandoned: result.abandoned,
      failed: result.failed,
    } satisfies LinksSyncResult as unknown as Record<string, unknown>;
  };
}
