import { z } from "zod";
import { revisionSchema } from "./schema";

/**
 * Resources one chat turn may consume across capability probes, context
 * preparation, agent rounds, nested analysis and post-answer memory.
 */
export const chatBudgetSchema = z
  .object({
    modelCalls: z.number().int().min(1).max(128),
    tokens: z.number().int().min(1024).max(1000000),
    durationMs: z.number().int().min(1000).max(3600000),
    generationTokens: z.number().int().min(1024).max(131072),
  })
  .strict();
export type ChatBudget = z.infer<typeof chatBudgetSchema>;

export const chatSettingsResultSchema = z.object({
  ok: z.literal(true),
  revision: revisionSchema,
  budget: chatBudgetSchema,
});
export const chatConfigureResultSchema = chatSettingsResultSchema.extend({
  replayed: z.boolean(),
});
export type ChatConfigureResult = z.infer<typeof chatConfigureResultSchema>;
