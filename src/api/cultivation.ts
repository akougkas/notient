import { z } from "zod";
import { attentionSettingsSchema, methodologySettingsSchema } from "./background";
import { pipelineIdSchema } from "./operations";
import { notePathSchema, revisionSchema, sourceReferenceSchema } from "./schema";
import { intelligenceStatusSchema } from "../core/intelligence/types";

export const cultivationDispositionSchema = z.enum([
  "applied",
  "awaiting-review",
  "report-only",
  "partial",
]);

export const cultivationDigestItemSchema = z
  .object({
    id: z.string().min(1),
    jobId: z.string().uuid(),
    pipeline: pipelineIdSchema,
    disposition: cultivationDispositionSchema,
    status: intelligenceStatusSchema.default("provisional"),
    title: z.string().min(1).max(300),
    explanation: z.string().min(1).max(8000),
    qualifications: z.array(z.string().min(1).max(2000)).max(20).default([]),
    path: notePathSchema,
    revision: revisionSchema,
    evidence: z.array(sourceReferenceSchema).min(1).max(30),
    reasons: z.array(z.string().min(1).max(300)).max(8),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export const cultivationDigestSchema = z
  .object({
    ok: z.literal(true),
    generatedAt: z.number().int().nonnegative(),
    paused: z.boolean(),
    items: z.array(cultivationDigestItemSchema).max(20),
    budget: z
      .object({
        tokens: z
          .object({
            limit: z.number().int().nonnegative(),
            spent: z.number().int().nonnegative(),
            reserved: z.number().int().nonnegative(),
            remaining: z.number().int().nonnegative(),
          })
          .strict(),
        modelCalls: z
          .object({
            limit: z.number().int().nonnegative(),
            spent: z.number().int().nonnegative(),
            reserved: z.number().int().nonnegative(),
            remaining: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
    methodology: methodologySettingsSchema,
  })
  .strict();

export const cultivationSettingsResultSchema = z
  .object({
    ok: z.literal(true),
    revision: revisionSchema,
    paused: z.boolean(),
    attention: attentionSettingsSchema,
    methodology: methodologySettingsSchema,
  })
  .strict();

export type CultivationDigestItem = z.infer<typeof cultivationDigestItemSchema>;
export type CultivationDigest = z.infer<typeof cultivationDigestSchema>;
