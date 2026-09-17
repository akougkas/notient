import { z } from "zod";
import {
  type PipelineId,
  type PipelinePolicy,
  pipelineIdSchema,
  pipelinePolicySchema,
} from "./operations";
import { revisionSchema } from "./schema";

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
      modelCalls: 24,
      tokens: 200000,
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
export const backgroundSchema = z
  .object({ paused: z.boolean(), pipelines: z.record(pipelineIdSchema, pipelinePolicySchema) })
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
  return { paused: false, pipelines };
}
