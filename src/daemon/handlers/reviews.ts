import { operationInputs } from "../../api/operations";
import { NoteApiError } from "../../api/schema";
import type { ApprovalService } from "../../core/approvals/approvalService";
import type { ChangeService } from "../../core/history/changeService";
import { RpcError, type RpcRequestContext } from "../rpc";

export function makeReviewHandlers(approvals: ApprovalService, changes: ChangeService) {
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
    approve: call("proposals.approve", ({ params, principal, signal }) =>
      approvals.applyReview(
        operationInputs["proposals.approve"].parse(params),
        principal,
        changes,
        signal ?? AbortSignal.timeout(120000),
      ),
    ),
    submit: call("proposals.submit", async ({ params, principal }) => ({
      ok: true,
      proposal: await approvals.submitReview(params, principal, changes),
    })),
    reject: call("proposals.reject", async ({ params, principal, signal }) => {
      signal?.throwIfAborted();
      return {
        ok: true,
        proposal: await approvals.rejectReview(
          operationInputs["proposals.reject"].parse(params),
          principal,
        ),
      };
    }),
  };
}
