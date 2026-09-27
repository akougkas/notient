import { operationInputs } from "../../api/operations";
import type { ReviewFeedbackRetention, ReviewProposal } from "../../api/proposals";
import { NoteApiError } from "../../api/schema";
import type { ApprovalService } from "../../core/approvals/approvalService";
import type { ChangeService } from "../../core/history/changeService";
import { RpcError, type Principal, type RpcRequestContext } from "../rpc";

export function makeReviewHandlers(
  approvals: ApprovalService,
  changes: ChangeService,
  onRejected?: (proposal: ReviewProposal, principal: Principal) => Promise<ReviewFeedbackRetention | void>,
  authorizeVaultOwner?: (principal: Principal) => void,
) {
  const call =
    <
      Name extends
        | "proposals.list"
        | "proposals.get"
        | "proposals.approve"
        | "proposals.reject"
        | "proposals.submit",
    >(
      name: Name,
      action: (request: RpcRequestContext) => Promise<Record<string, unknown>>,
    ) =>
    async (request: RpcRequestContext) => {
      if (!request.principal.scopes.includes("read"))
        throw new RpcError("FORBIDDEN", "review requires read scope");
      const parsed = operationInputs[name].safeParse(request.params);
      if (!parsed.success) throw new RpcError("INVALID_PARAMS", parsed.error.message);
      try {
        return await action({ ...request, params: parsed.data });
      } catch (error) {
        if (error instanceof NoteApiError) throw new RpcError(error.code, error.message);
        throw error;
      }
    };
  return {
    list: call("proposals.list", ({ params, signal }) =>
      approvals.pageReview(params, signal ?? AbortSignal.timeout(30000)),
    ),
    get: call("proposals.get", async ({ params }) => ({
      ok: true,
      proposal: await approvals.getReview(String(params.id)),
    })),
    approve: call("proposals.approve", ({ params, principal, signal }) => {
      const ownerAuthority = () => {
        if (principal.kind === "human") return;
        if (!authorizeVaultOwner) throw new RpcError("FORBIDDEN", "vault owner grant is required");
        authorizeVaultOwner(principal);
      };
      ownerAuthority();
      return approvals.applyReview(
        operationInputs["proposals.approve"].parse(params),
        principal,
        changes,
        signal ?? AbortSignal.timeout(120000),
        principal.kind === "human" ? undefined : async () => ownerAuthority(),
      );
    }),
    submit: call("proposals.submit", async ({ params, principal }) => ({
      ok: true,
      proposal: await approvals.submitReview(params, principal, changes),
    })),
    reject: call("proposals.reject", async ({ params, principal, signal }) => {
      signal?.throwIfAborted();
      const ownerAuthority = () => {
        if (principal.kind === "human") return;
        if (!authorizeVaultOwner) throw new RpcError("FORBIDDEN", "vault owner grant is required");
        authorizeVaultOwner(principal);
      };
      ownerAuthority();
      const proposal = await approvals.rejectReview(
        operationInputs["proposals.reject"].parse(params),
        principal,
        principal.kind === "human" ? undefined : ownerAuthority,
      );
      const feedbackRetention = await onRejected?.(proposal, principal);
      return { ok: true, proposal, ...(feedbackRetention ? { feedbackRetention } : {}) };
    }),
  };
}
