import { z } from "zod";
import { changeSetSchema, effectSchema } from "./operations";
import { notePathSchema, noteReferenceSchema, revisionSchema } from "./schema";

export const previewEffectSchema = z.object({
  kind: z.enum(["write", "move"]),
  category: effectSchema,
  relationship: z
    .object({
      edgeId: z.string(),
      table: z.enum([
        "supports",
        "contradicts",
        "extends",
        "exemplifies",
        "synthesizes",
        "related_to",
      ]),
      target: noteReferenceSchema,
    })
    .nullable(),
  path: notePathSchema,
  destination: notePathSchema.nullable(),
  before: z.string().nullable(),
  after: z.string(),
  beforeRevision: revisionSchema.nullable(),
  afterRevision: revisionSchema,
  reason: z.string(),
});
export const changePreviewSchema = z.object({
  ok: z.literal(true),
  previewId: z.string(),
  revision: revisionSchema,
  owner: z.string(),
  changeSet: changeSetSchema,
  effects: z.array(previewEffectSchema).max(200),
  conflicts: z.array(z.object({ path: notePathSchema, reason: z.string() })).max(200),
  createdAt: z.number().int(),
});
export const changeResultSchema = z.object({
  ok: z.boolean(),
  previewId: z.string(),
  state: z.enum(["applied", "conflict", "partial", "denied", "cancelled"]),
  effects: z.array(
    z.object({
      index: z.number().int(),
      path: notePathSchema,
      state: z.enum(["applied", "conflict", "denied", "cancelled"]),
      historyId: z.string().nullable(),
      message: z.string().nullable(),
    }),
  ),
});
export type ChangePreview = z.infer<typeof changePreviewSchema>;
export type PreviewEffect = z.infer<typeof previewEffectSchema>;
export type ChangeResult = z.infer<typeof changeResultSchema>;
