import { z } from "zod";
import { notePathSchema } from "./schema";

export const methodologySettingsSchema = z
  .object({
    mode: z.enum(["ai-managed", "para", "flap", "custom"]),
    name: z.string().trim().min(1).max(100).default("Custom"),
    conventions: z.string().max(20000).default(""),
  })
  .strict();
export type MethodologySettings = z.infer<typeof methodologySettingsSchema>;

export const attentionSettingsSchema = z
  .object({
    dailyTokens: z.number().int().min(0).max(1000000).default(600000),
    dailyModelCalls: z.number().int().min(0).max(100).default(72),
    revisitDays: z.number().int().min(1).max(365).default(30),
    digestItems: z.number().int().min(1).max(20).default(5),
    priorities: z
      .array(
        z
          .object({
            path: notePathSchema,
            priority: z.number().int().min(-100).max(100),
          })
          .strict(),
      )
      .max(200)
      .default([])
      .refine(
        (entries) => new Set(entries.map((entry) => entry.path)).size === entries.length,
        "note attention priorities must be unique by path",
      ),
  })
  .strict();
export type AttentionSettings = z.infer<typeof attentionSettingsSchema>;

export const cultivationSettingsSchema = z
  .object({
    attention: attentionSettingsSchema,
    methodology: methodologySettingsSchema,
  })
  .strict();
export type CultivationSettings = z.infer<typeof cultivationSettingsSchema>;
