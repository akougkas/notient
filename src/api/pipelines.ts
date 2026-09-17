import { z } from "zod";
import { changeResultSchema } from "./changes";
import {
  changeSetSchema,
  jobStateSchema,
  pipelineIdSchema,
  pipelinePolicySchema,
} from "./operations";
import { noteReferenceSchema, revisionSchema, sourceReferenceSchema } from "./schema";

export const pipelineFindingSchema = z.object({
  kind: z.enum([
    "summary",
    "metadata",
    "relationship",
    "contradiction",
    "temporal-change",
    "different-assumptions",
    "synthesis",
    "inbox",
    "archive",
    "concept",
    "claim",
    "question",
  ]),
  title: z.string().min(1).max(300),
  explanation: z.string().min(1).max(8000),
  evidence: z.array(sourceReferenceSchema).min(1).max(30),
});
export const relationshipSuggestionSchema = z.object({
  relation: z.enum([
    "supports",
    "contradicts",
    "extends",
    "exemplifies",
    "synthesizes",
    "related_to",
  ]),
  source: noteReferenceSchema,
  target: noteReferenceSchema,
  rationale: z.string().min(1).max(8000),
  evidence: z.array(sourceReferenceSchema).min(2).max(20),
  assessment: z.number().min(0).max(1),
});
export const pipelinePlanSchema = z.object({
  pipeline: pipelineIdSchema,
  summary: z.string().min(1),
  abstained: z.boolean(),
  reason: z.string().nullable(),
  findings: z.array(pipelineFindingSchema).max(500),
  changes: z.array(changeSetSchema.shape.changes.element).max(200),
  relationships: z.array(relationshipSuggestionSchema).max(200),
  sources: z.array(noteReferenceSchema).max(200),
  extractions: z
    .array(
      z.object({
        source: noteReferenceSchema,
        noteId: z.string(),
        chunkIds: z.array(z.string()).max(10000),
        extraction: z.object({
          entities: z.array(z.string()),
          claims: z.array(z.string()),
          questions: z.array(z.string()),
          entityKinds: z
            .record(
              z.string(),
              z.enum([
                "proper_noun",
                "system",
                "technique",
                "metric",
                "quantity",
                "event",
                "other",
              ]),
            )
            .optional(),
          claimKinds: z
            .record(z.string(), z.enum(["definition", "assertion", "datum", "speculation"]))
            .optional(),
          entityEvidence: z.record(z.string(), z.array(z.string())).optional(),
          claimEvidence: z.record(z.string(), z.array(z.string())).optional(),
          questionEvidence: z.record(z.string(), z.array(z.string())).optional(),
          stats: z.object({ llmCalls: z.number().int(), windows: z.number().int() }).optional(),
        }),
      }),
    )
    .max(200),
});
export type PipelinePlan = z.infer<typeof pipelinePlanSchema>;
export type PipelineFinding = z.infer<typeof pipelineFindingSchema>;

const usageSchema = z.object({
  source: z.enum(["provider", "unavailable"]),
  promptTokens: z.number().nullable(),
  completionTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  reasoningTokens: z.number().nullable(),
  visibleAnswerTokens: z.number().nullable(),
  nonReasoningCompletionTokens: z.number().nullable(),
});
export const inferenceAttemptSchema = z.object({
  sequence: z.number().int().positive(),
  inputTokenEstimate: z.number().nonnegative(),
  generationCeiling: z.number().nonnegative(),
  chargedTokens: z.number().nonnegative(),
  accounting: z.enum(["reserved-estimate", "provider-total", "provider-components"]),
  completion: z
    .object({
      finishReason: z.string().nullable(),
      state: z.enum(["complete", "truncated", "incomplete", "filtered", "cancelled"]),
      usage: usageSchema,
    })
    .nullable(),
});
export const pipelineJobSchema = z.object({
  id: z.string().uuid(),
  revision: revisionSchema,
  pipeline: pipelineIdSchema,
  state: jobStateSchema,
  caller: z.object({
    id: z.string(),
    kind: z.enum(["human", "agent"]),
    scopes: z.array(z.string()),
  }),
  background: z.boolean(),
  preview: z.boolean(),
  reason: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  sourceRevisions: z.array(noteReferenceSchema).max(200),
  configurationRevision: revisionSchema,
  policy: pipelinePolicySchema,
  attempts: z.array(inferenceAttemptSchema).max(100),
  runAttempts: z.number().int().nonnegative(),
  activeDurationMs: z.number().nonnegative(),
  stage: z.string(),
  progress: z.object({
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  plan: pipelinePlanSchema.nullable(),
  previewId: z.string().nullable(),
  previewRevision: revisionSchema.nullable(),
  proposalIds: z.array(z.string()).max(200),
  effects: changeResultSchema.nullable(),
  failure: z.object({ code: z.string(), message: z.string(), at: z.number().int() }).nullable(),
  nextAttemptAt: z.number().int().nullable(),
});
export type PipelineJob = z.infer<typeof pipelineJobSchema>;
/** Lists stay bounded independently of a job's evidence and generated output. */
export const jobSummarySchema = pipelineJobSchema
  .pick({
    id: true,
    revision: true,
    pipeline: true,
    state: true,
    caller: true,
    background: true,
    preview: true,
    reason: true,
    createdAt: true,
    updatedAt: true,
    runAttempts: true,
    activeDurationMs: true,
    stage: true,
    progress: true,
    failure: true,
    nextAttemptAt: true,
  })
  .extend({
    sourceCount: z.number().int().nonnegative(),
    proposalCount: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
    chargedTokens: z.number().nonnegative(),
  });
/** Derived database identities are private implementation checkpoints. */
export const jobDetailSchema = pipelineJobSchema.extend({
  plan: pipelinePlanSchema.omit({ extractions: true }).nullable(),
});
export const jobResultSchema = z.object({ ok: z.literal(true), job: jobDetailSchema });
export const jobListSchema = z.object({
  ok: z.literal(true),
  jobs: z.array(jobSummarySchema).max(200),
  nextCursor: z.string().nullable(),
  snapshot: revisionSchema,
});
