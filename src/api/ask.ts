import { z } from "zod";
import { searchCoverageSchema } from "./indexing";
import { inferenceAttemptSchema } from "./pipelines";
import { sourceReferenceSchema } from "./schema";

export const UNGROUNDED_ANSWER = "I do not have enough cited vault evidence to answer.";
const canonical = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value);
export const askCitationSchema = sourceReferenceSchema
  .extend({
    score: z.number().finite(),
    quote: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0),
  })
  .strict();
export const askResultSchema = z
  .object({
    ok: z.literal(true),
    answer: canonical,
    citations: z.array(askCitationSchema).max(50),
    openQuestions: z.array(canonical).max(20),
    confidence: z.number().min(0).max(1),
    toolCalls: z
      .array(
        z
          .object({
            name: z.enum(["vault.search_notes", "vault.read_note"]),
            args: z.record(z.string(), z.json()),
            durationMs: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    durationMs: z.number().int().nonnegative(),
    attempts: z.array(inferenceAttemptSchema).max(10),
    coverage: searchCoverageSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.toolCalls[0]?.name !== "vault.search_notes")
      ctx.addIssue({ code: "custom", message: "answers must retrieve evidence first" });
    if (value.toolCalls.some((call) => call.durationMs > value.durationMs))
      ctx.addIssue({ code: "custom", message: "tool duration exceeds answer duration" });
    if (
      new Set(
        value.citations.map(
          (item) => `${item.path}:${item.revision}:${item.range.start}:${item.range.end}`,
        ),
      ).size !== value.citations.length
    )
      ctx.addIssue({ code: "custom", message: "citation source ranges must be unique" });
    if (new Set(value.openQuestions).size !== value.openQuestions.length)
      ctx.addIssue({ code: "custom", message: "open questions must be unique" });
    if (
      value.citations.length === 0 &&
      (value.answer !== UNGROUNDED_ANSWER ||
        value.confidence !== 0 ||
        value.openQuestions.length !== 0)
    )
      ctx.addIssue({ code: "custom", message: "uncited answers must explicitly abstain" });
    if (value.citations.length && (value.confidence === 0 || value.answer === UNGROUNDED_ANSWER))
      ctx.addIssue({
        code: "custom",
        message: "grounded answers must include evidence and confidence",
      });
  });
export type AskResult = z.infer<typeof askResultSchema>;
export type AskCitation = z.infer<typeof askCitationSchema>;
