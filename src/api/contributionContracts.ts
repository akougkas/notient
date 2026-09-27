import { z } from "zod";

export const contributionIdSchema = z
  .string()
  .regex(/^contribution:u"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"$/);

export const contributionKindSchema = z.enum([
  "finding",
  "interpretation",
  "question",
  "decision",
]);

export const contributionStatusSchema = z.enum([
  "pending",
  "awaiting-review",
  "retained",
  "rejected",
  "stale",
  "dismissed",
]);

export const contributionFeedbackReasonSchema = z.enum([
  "false",
  "unsupported",
  "irrelevant",
  "already-known",
  "deferred",
]);

export const contributionOriginSchema = z
  .object({
    kind: z.enum(["human", "clipper", "agent", "software"]),
    label: z.string().trim().min(1).max(200),
    sourceUrl: z
      .string()
      .url()
      .max(2048)
      .refine((value) => value.startsWith("https://") || value.startsWith("http://"))
      .optional(),
  })
  .strict();

export type ContributionKind = z.infer<typeof contributionKindSchema>;
export type ContributionOrigin = z.infer<typeof contributionOriginSchema>;
