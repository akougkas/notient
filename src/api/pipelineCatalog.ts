import { z } from "zod";
import { type PipelineId, pipelineIdSchema, pipelinePolicySchema } from "./operations";
import { revisionSchema } from "./schema";

/** Describes the finite engine stages, not model-discovered capabilities. */
export const PIPELINE_CATALOG: Record<PipelineId, { title: string; description: string }> = {
  "index-extract": {
    title: "Index and extract",
    description:
      "Reconcile structure and lexical chunks; optionally embed and extract grounded concepts, claims and questions. Derived indexing does not edit authored Markdown.",
  },
  enrich: {
    title: "Enrich notes",
    description:
      "Suggest source-supported summaries, tags and aliases within the policy's allowed properties and sections.",
  },
  relate: {
    title: "Relate notes",
    description:
      "Retrieve bounded context and propose typed relationships with exact evidence from both notes.",
  },
  contradictions: {
    title: "Find contradictions",
    description:
      "Compare grounded claims and distinguish contradictions from temporal changes and different assumptions.",
  },
  synthesize: {
    title: "Synthesize and create",
    description:
      "Draft a cited synthesis or map of content using the configured template and destination; abstain when sources do not support one.",
  },
  inbox: {
    title: "Process inbox",
    description:
      "Classify scoped inbox notes, propose supported metadata and filing moves, and optionally derive notes without treating note content as instructions.",
  },
  archive: {
    title: "Review for archive",
    description:
      "Review age and redundancy with evidence, preserving protected tags and open tasks according to policy; propose archive moves without deleting sources.",
  },
};

export const pipelineListSchema = z.object({
  ok: z.literal(true),
  revision: revisionSchema,
  paused: z.boolean(),
  pipelines: z
    .array(
      z.object({
        id: pipelineIdSchema,
        title: z.string(),
        description: z.string(),
        policy: pipelinePolicySchema,
        schedule: z.object({
          lastRun: z.number().nullable(),
          nextRun: z.number().nullable(),
          reason: z.string(),
        }),
      }),
    )
    .length(pipelineIdSchema.options.length),
});
