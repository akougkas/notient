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

export const cultivationOriginSchema = z
  .object({
    trigger: z.enum(["save", "idle", "interval", "reconsider", "manual"]),
    caller: z.string().min(1).max(200),
    examined: z.array(notePathSchema).max(20),
  })
  .strict();

export const cultivationQuietResultSchema = z
  .object({
    jobId: z.string().uuid(),
    pipeline: pipelineIdSchema,
    outcome: z.enum(["no-write", "failed"]),
    reason: z.string().min(1).max(2000),
    origin: cultivationOriginSchema,
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export const cultivationConditionSchema = z
  .object({
    id: z.string().min(1).max(64),
    level: z.enum(["attention", "info"]),
    label: z.string().min(1).max(200),
    detail: z.string().min(1).max(600),
    action: z.string().min(1).max(300).nullable(),
  })
  .strict();

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
    origin: cultivationOriginSchema.optional(),
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
    quiet: z.array(cultivationQuietResultSchema).max(20).default([]),
    conditions: z.array(cultivationConditionSchema).max(20).default([]),
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

export type CultivationOrigin = z.infer<typeof cultivationOriginSchema>;
export type CultivationQuietResult = z.infer<typeof cultivationQuietResultSchema>;
export type CultivationCondition = z.infer<typeof cultivationConditionSchema>;
export type CultivationDigestItem = z.infer<typeof cultivationDigestItemSchema>;
export type CultivationDigest = z.infer<typeof cultivationDigestSchema>;
