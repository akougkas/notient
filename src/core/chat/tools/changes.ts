import { z } from "zod";
import { contentRevision } from "../../../api/notes";
import { changeSetSchema, operationInputs } from "../../../api/operations";
import type { ApprovalService } from "../../approvals/approvalService";
import { CHAT_ASSISTANT_PREFIX } from "../../auth/agentIdentity";
import type { ChangeCaller, ChangeService } from "../../history/changeService";
import type { ToolDefinition, ToolInvokeContext, ToolJsonSchema } from "./registry";

export interface ChangeToolsContext {
  changes: ChangeService;
  approvalService: Pick<ApprovalService, "submitReview">;
  /** Live credential check for the conversation's principal, never model input. */
  authorizeIdentity: (id: string, scope: "write") => void | Promise<void>;
}

/**
 * The assistant is its own agent principal, scoped to the conversation's
 * authenticated client. It owns its previews and may ask for review; it is
 * never the human, so canonical apply, approve and reject stay refused.
 */
async function assistantCaller(
  tools: ChangeToolsContext,
  context: ToolInvokeContext,
): Promise<ChangeCaller> {
  if (context.noteScope !== undefined)
    throw new Error("change previews are unavailable in a scope-limited read-only turn");
  await tools.authorizeIdentity(context.clientIdentity, "write");
  return {
    id: `${CHAT_ASSISTANT_PREFIX}${context.clientIdentity}`,
    kind: "agent",
    scopes: ["read", "write"],
  };
}

const previewArgs = changeSetSchema.omit({ idempotencyKey: true }).strict();
const submitArgs = operationInputs["proposals.submit"]
  .omit({ idempotencyKey: true, evidence: true })
  .strict();

export interface ChangePreviewSummary {
  previewId: string;
  previewRevision: string;
  effects: Array<{
    kind: "write" | "move";
    category: string;
    path: string;
    destination: string | null;
    beforeRevision: string | null;
    afterRevision: string;
    reason: string;
  }>;
  conflicts: Array<{ path: string; reason: string }>;
  applied: false;
}

export interface ChangeSubmitSummary {
  reviewId: string;
  state: string;
  previewId: string;
  applied: false;
}

/**
 * The canonical change model for the in-app assistant: plan an exact stored
 * preview, then ask the human to review it. Both tools reuse `ChangeService`
 * and `ApprovalService`; neither changes note bytes or passes the approval
 * gate, because only the human's apply in the review list has effects.
 */
export function makeChangeTools(
  tools: ChangeToolsContext,
): [
  ToolDefinition<z.infer<typeof previewArgs>, ChangePreviewSummary>,
  ToolDefinition<z.infer<typeof submitArgs>, ChangeSubmitSummary>,
] {
  return [
    {
      name: "changes.preview",
      description:
        "Plan up to 200 changes against exact {path, revision} sources from vault.read_note: create, append, heading/block/range edits, property patches, and reference-aware move, archive or unarchive. Heading selectors must resolve to exactly one section. Stores the exact before/after Markdown and returns its effects and conflicts. No note bytes change. Use this for moves, multi-note or selector edits; follow with changes.submit_for_review.",
      schema: z.toJSONSchema(previewArgs) as ToolJsonSchema,
      validate: (raw) => previewArgs.parse(raw),
      writeGated: false,
      invoke: async (args, signal, context) => {
        const caller = await assistantCaller(tools, context);
        signal.throwIfAborted();
        // Identical planned changes name the same stored preview, so a retried
        // model call cannot fork a second review of the same edit.
        const preview = await tools.changes.preview(
          { idempotencyKey: `chat-${contentRevision(JSON.stringify(args.changes))}`, ...args },
          caller,
        );
        return {
          previewId: preview.previewId,
          previewRevision: preview.revision,
          effects: preview.effects.map((effect) => ({
            kind: effect.kind,
            category: effect.category,
            path: effect.path,
            destination: effect.destination,
            beforeRevision: effect.beforeRevision,
            afterRevision: effect.afterRevision,
            reason: effect.reason,
          })),
          conflicts: preview.conflicts,
          applied: false,
        };
      },
    },
    {
      name: "changes.submit_for_review",
      description:
        "Ask the human to review and apply one of your own stored previews. Pass its previewId, previewRevision and a concise rationale. This grants no approval: nothing changes until the human applies it from the review list, a rejection is permanent for that preview, and later source edits make it stale. Tell the user the change awaits their review; never describe it as applied.",
      schema: z.toJSONSchema(submitArgs) as ToolJsonSchema,
      validate: (raw) => submitArgs.parse(raw),
      writeGated: false,
      invoke: async (args, signal, context) => {
        const caller = await assistantCaller(tools, context);
        signal.throwIfAborted();
        const review = await tools.approvalService.submitReview(
          { ...args, evidence: [], idempotencyKey: `chat-submit-${args.previewId}` },
          caller,
          tools.changes,
        );
        return {
          reviewId: review.id,
          state: review.state,
          previewId: review.previewId,
          applied: false,
        };
      },
    },
  ];
}
