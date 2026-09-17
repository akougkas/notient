import { z } from "zod";
import { CHAT_ASSISTANT_PREFIX } from "../core/auth/agentIdentity";
import { changeResultSchema } from "./changes";
import { type PipelineId, pipelineIdSchema } from "./operations";
import { noteReferenceSchema, revisionSchema, sourceReferenceSchema } from "./schema";
export const proposalProvenanceSchema = z.object({
  pipeline: pipelineIdSchema,
  jobId: z.string().uuid(),
  configurationRevision: revisionSchema,
  sources: z.array(noteReferenceSchema).min(1).max(200),
  evidence: z.array(sourceReferenceSchema).min(1).max(500),
  rationale: z.string().min(1),
  score: z
    .object({ kind: z.literal("model-assessment"), value: z.number().min(0).max(1) })
    .nullable(),
});
export type ProposalProvenance = z.infer<typeof proposalProvenanceSchema>;
/** A caller's exact stored preview submitted for the human's decision. The
 * requester is the authenticated principal, never a tool argument. */
export const requestProvenanceSchema = z
  .object({
    requestedBy: z.object({ id: z.string().min(1), kind: z.enum(["human", "agent"]) }).strict(),
    sources: z.array(noteReferenceSchema).max(200),
    evidence: z.array(sourceReferenceSchema).max(500),
    rationale: z.string().min(1),
    score: z.null(),
  })
  .strict();
export const reviewProvenanceSchema = z.union([proposalProvenanceSchema, requestProvenanceSchema]);
export type ReviewProvenance = z.infer<typeof reviewProvenanceSchema>;
export function reviewTitle(
  provenance: ReviewProvenance,
  pipelines: Record<PipelineId, string>,
): string {
  return "pipeline" in provenance
    ? pipelines[provenance.pipeline]
    : provenance.requestedBy.id.startsWith(CHAT_ASSISTANT_PREFIX)
      ? "Change requested by the assistant"
      : `Change requested by ${provenance.requestedBy.id}`;
}
export const reviewProposalSchema = z.object({
  id: revisionSchema,
  revision: revisionSchema,
  state: z.enum(["pending", "approved", "rejected", "stale"]),
  previewId: revisionSchema,
  previewRevision: revisionSchema,
  edgeIds: z.array(z.string()).max(200),
  provenance: reviewProvenanceSchema,
  createdAt: z.number().int(),
  decidedAt: z.number().int().nullable(),
  decidedBy: z.string().nullable(),
  appliedHistory: z.array(z.string()).max(200),
  application: changeResultSchema.nullable().optional(),
});
export type ReviewProposal = z.infer<typeof reviewProposalSchema>;
export const proposalResultSchema = z.object({
  ok: z.literal(true),
  proposal: reviewProposalSchema,
});
export const proposalListSchema = z.object({
  ok: z.literal(true),
  proposals: z.array(reviewProposalSchema).max(200),
  snapshot: revisionSchema,
  nextCursor: z.string().nullable(),
});
