import { z } from "zod";
import {
  type PipelineId,
  type PipelinePolicy,
  pipelineIdSchema,
  pipelinePolicySchema,
} from "./operations";
import { revisionSchema } from "./schema";
import {
  attentionSettingsSchema,
  cultivationSettingsSchema,
  methodologySettingsSchema,
} from "./cultivationSettings";

const LEGACY_PIPELINE_IDS = [
  "index-extract",
  "enrich",
  "relate",
  "contradictions",
  "synthesize",
  "inbox",
  "archive",
] as const satisfies readonly PipelineId[];

export {
  attentionSettingsSchema,
  cultivationSettingsSchema,
  methodologySettingsSchema,
} from "./cultivationSettings";
export type {
  AttentionSettings,
  CultivationSettings,
  MethodologySettings,
} from "./cultivationSettings";

export function defaultPipelinePolicy(pipeline: PipelineId): PipelinePolicy {
  return pipelinePolicySchema.parse({
    enabled: false,
    triggers: [],
    debounceMs: 5000,
    cooldownMs: 3600000,
    idleMs: 300000,
    intervalMs: 86400000,
    timezone: "UTC",
    windows: [],
    readScope: {},
    writeScope: {},
    destinations: { notes: "Notient/notes", inbox: "Inbox", archive: "Archive" },
    allowedProperties: ["tags", "aliases", "summary", "status"],
    allowedSections: ["Notient summary"],
    mode: pipeline === "index-extract" ? "report" : "propose",
    effects: [],
    budget: {
      notes: 12,
      candidates: 40,
      modelCalls: pipeline === "reconsider" ? 0 : 24,
      tokens: pipeline === "reconsider" ? 0 : 200000,
      durationMs: 300000,
      // Relationship and claim comparison share one analyst and need room for
      // reasoning as well as JSON: measured runs spent 7,000-9,600 tokens. This is
      // a shared provider ceiling; saved user policies retain their caps.
      generationTokens: pipeline === "contradictions" || pipeline === "relate" ? 16384 : 8192,
      concurrency: 1,
      retries: 2,
      priority: 5,
    },
  });
}
const pipelineSettingsSchema = z
  .partialRecord(pipelineIdSchema, pipelinePolicySchema)
  .superRefine((pipelines, context) => {
    for (const id of LEGACY_PIPELINE_IDS) {
      if (!Object.hasOwn(pipelines, id))
        context.addIssue({ code: "custom", path: [id], message: "pipeline policy is required" });
    }
  })
  .transform(
    (pipelines) =>
      Object.fromEntries(
        pipelineIdSchema.options.map((id) => [id, pipelines[id] ?? defaultPipelinePolicy(id)]),
      ) as Record<PipelineId, PipelinePolicy>,
  )
  .pipe(
    z.record(pipelineIdSchema, pipelinePolicySchema) as z.ZodType<
      Record<PipelineId, PipelinePolicy>,
      Record<PipelineId, PipelinePolicy>
    >,
  );

export const backgroundSchema = z
  .object({
    paused: z.boolean(),
    pipelines: pipelineSettingsSchema,
    cultivation: cultivationSettingsSchema.default(() => ({
      attention: attentionSettingsSchema.parse({}),
      methodology: methodologySettingsSchema.parse({ mode: "ai-managed" }),
    })),
  })
  .strict();
export type BackgroundSettings = z.infer<typeof backgroundSchema>;

export const backgroundResultSchema = z.object({
  ok: z.literal(true),
  revision: revisionSchema,
  settings: backgroundSchema,
  replayed: z.boolean(),
});
export function defaultBackgroundSettings(): BackgroundSettings {
  const pipelines = Object.fromEntries(
    pipelineIdSchema.options.map((id) => [id, defaultPipelinePolicy(id)]),
  ) as BackgroundSettings["pipelines"];
  return {
    paused: false,
    pipelines,
    cultivation: {
      attention: attentionSettingsSchema.parse({}),
      methodology: methodologySettingsSchema.parse({ mode: "ai-managed" }),
    },
  };
}
