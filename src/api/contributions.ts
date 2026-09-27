import { z } from "zod";
import { revisionSchema, sourceReferenceSchema, noteReferenceSchema } from "./schema";
import { reviewProposalSchema } from "./proposals";
import {
  contributionFeedbackReasonSchema,
  contributionIdSchema,
  contributionKindSchema,
  contributionOriginSchema,
  contributionStatusSchema,
} from "./contributionContracts";

export {
  contributionFeedbackReasonSchema,
  contributionIdSchema,
  contributionKindSchema,
  contributionOriginSchema,
  contributionStatusSchema,
} from "./contributionContracts";

export const contributionAttributionSchema = z
  .object({
    id: z.string().min(1).max(128),
    kind: z.enum(["human", "agent"]),
    label: z.string().min(1).max(200),
  })
  .strict();

export const contributionFeedbackSchema = z
  .object({
    reason: contributionFeedbackReasonSchema,
    target: z.string().min(1).max(8000),
    targetRecordId: z.string().regex(/^i-[a-f0-9]{64}$/),
    targetKey: z.string().regex(/^subject-v1:[a-f0-9]{64}$/),
    explanation: z.string().min(1).max(4000),
    targetEvidence: z.array(sourceReferenceSchema).max(30).optional(),
    targetDependencies: z.array(noteReferenceSchema).max(30).optional(),
  })
  .strict();

export const contributionRecordSchema = z
  .object({
    id: contributionIdSchema,
    revision: revisionSchema,
    kind: z.enum(["contribution", "feedback"]),
    contributionKind: contributionKindSchema.nullable(),
    target: noteReferenceSchema,
    statement: z.string().min(1).max(8000),
    evidence: z.array(sourceReferenceSchema).max(30),
    attribution: contributionAttributionSchema,
    origin: contributionOriginSchema.nullable().default(null),
    feedback: contributionFeedbackSchema.nullable(),
    status: contributionStatusSchema,
    proposalId: revisionSchema.nullable(),
    dispositionReason: z.string().max(2000).nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      (record.kind === "contribution" &&
        (record.contributionKind === null || record.feedback !== null)) ||
      (record.kind === "feedback" &&
        (record.contributionKind !== null || record.feedback === null))
    ) {
      context.addIssue({
        code: "custom",
        path: ["kind"],
        message: "contribution and feedback details must match the record kind",
      });
    }
    if (
      (record.status === "awaiting-review" || record.status === "retained" || record.status === "rejected" || record.status === "stale") !==
      (record.proposalId !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["proposalId"],
        message: "review states require a linked proposal",
      });
    }
  });

export const contributionResultSchema = z.object({
  ok: z.literal(true),
  contribution: contributionRecordSchema,
});

export const contributionSubmitResultSchema = contributionResultSchema.extend({
  replayed: z.boolean(),
});

export const contributionListSchema = z.object({
  ok: z.literal(true),
  contributions: z.array(contributionRecordSchema).max(200),
  snapshot: revisionSchema,
  nextCursor: z.string().nullable(),
});

export const contributionStageResultSchema = contributionResultSchema.extend({
  proposal: reviewProposalSchema,
});

export type { ContributionKind, ContributionOrigin } from "./contributionContracts";
export type ContributionRecord = z.infer<typeof contributionRecordSchema>;
