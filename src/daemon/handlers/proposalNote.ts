/** Dedicated authenticated writer for Notient-owned proposal-note artifacts. */

import type { VaultAdapter } from "../../adapters/vaultAdapter";
import { buildProposalNotePlan, parseProposalNoteInput } from "../../core/approvals/proposalNote";
import type { ApprovalGate } from "../../core/chat/approvalGate";
import type { ApprovalMode } from "../../core/chat/types";
import type { DurableNoteWriter } from "../../core/history/durableNoteWriter";
import { type MethodHandler, RpcError } from "../rpc";
import {
  type NonBlockingApprovalTracker,
  invokeWithNonBlockingApproval,
} from "./nonBlockingApproval";

export interface ProposalNoteHandlerDeps {
  approvalGate: ApprovalGate;
  approvalTracker: NonBlockingApprovalTracker;
  approvalMode: () => ApprovalMode;
  vault: Pick<VaultAdapter, "exists">;
  applyWrite: DurableNoteWriter["apply"];
  hash: (content: string) => Promise<string>;
  now?: () => number;
}

interface ProposalNoteWriteResult {
  applied: boolean;
  reason?: string;
  sha?: string;
  historyId?: string;
}

const PREVIEW_MAX_CHARS = 800;

export function makeProposalNoteHandler(deps: ProposalNoteHandlerDeps): MethodHandler {
  let counter = 0;
  const now = deps.now ?? Date.now;
  return async ({ params, principal }) => {
    const input = parseProposalNoteParams(params);
    const plan = buildProposalNotePlan({
      input,
      proposedBy: principal.id,
      now: now(),
    });
    const callId = `proposal-note-${Date.now().toString(36)}-${counter++}`;
    const outcome = await invokeWithNonBlockingApproval<ProposalNoteWriteResult>({
      approvalGate: deps.approvalGate,
      tracker: deps.approvalTracker,
      callId,
      invoke: async (signal) => {
        if (await deps.vault.exists(plan.path)) {
          return {
            applied: false,
            reason: `path already exists: ${plan.path}`,
          };
        }
        const decision = await deps.approvalGate.request(
          {
            id: callId,
            name: "proposals.propose_note",
            args: { path: plan.path, title: plan.title, kind: plan.kind },
          },
          deps.approvalMode(),
          renderPreview(plan.path, plan.content),
          signal,
          { clientIdentity: principal.id },
        );
        if (!decision.approved) return { applied: false, reason: decision.reason };
        if (await deps.vault.exists(plan.path)) {
          return {
            applied: false,
            reason: `path already exists: ${plan.path}`,
          };
        }
        const receipt = await deps.applyWrite({
          ...deps.approvalGate.writeGuard(decision, signal),
          kind: "notes.create",
          target: plan.path,
          before: null,
          after: plan.content,
          clientIdentity: principal.id,
        });
        if (!receipt.applied) {
          return {
            applied: false,
            reason: `path already exists: ${plan.path}`,
          };
        }
        return {
          applied: true,
          sha: await deps.hash(plan.content),
          historyId: receipt.historyId,
        };
      },
    });

    if (outcome.kind === "pending") {
      return {
        ok: true,
        applied: false,
        pending: true,
        callId,
        preview: outcome.preview,
        path: plan.path,
      };
    }
    if (!outcome.value.applied) {
      if (typeof outcome.value.reason !== "string" || outcome.value.reason.length === 0) {
        throw new Error("proposal-note integrity failure: refusal omitted its reason");
      }
      return {
        ok: true,
        applied: false,
        pending: false,
        reason: outcome.value.reason,
        path: plan.path,
      };
    }
    if (typeof outcome.value.sha !== "string" || typeof outcome.value.historyId !== "string") {
      throw new Error("proposal-note integrity failure: applied write omitted its receipt");
    }
    return {
      ok: true,
      applied: true,
      path: plan.path,
      sha: outcome.value.sha,
      historyId: outcome.value.historyId,
    };
  };
}

function parseProposalNoteParams(params: Record<string, unknown>) {
  try {
    return parseProposalNoteInput(params);
  } catch (error) {
    throw new RpcError("INVALID_PARAMS", error instanceof Error ? error.message : String(error));
  }
}

function renderPreview(path: string, content: string): string {
  const shown =
    content.length <= PREVIEW_MAX_CHARS
      ? content
      : `${content.slice(0, PREVIEW_MAX_CHARS)}\n... (${content.length - PREVIEW_MAX_CHARS} more chars)`;
  return `Create proposal note at ${path}\n---\n${shown}`;
}
