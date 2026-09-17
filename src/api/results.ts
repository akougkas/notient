import { z } from "zod";
import { askResultSchema } from "./ask";
import { backgroundResultSchema } from "./background";
import { briefResultSchema } from "./brief";
import { changePreviewSchema, changeResultSchema } from "./changes";
import { chatConfigureResultSchema, chatSettingsResultSchema } from "./chat";
import { comparisonResultSchema } from "./comparison";
import { graphNeighborsSchema, graphPathSchema } from "./graph";
import { historyDetailSchema, historyListSchema, historyUndoResultSchema } from "./history";
import { hostOutputs } from "./host";
import { pipelineListSchema } from "./pipelineCatalog";
import { jobListSchema, jobResultSchema } from "./pipelines";
import { policyValidationSchema } from "./policyValidation";
import { proposalListSchema, proposalResultSchema } from "./proposals";
import { contextResultSchema, retrievalResultSchema } from "./retrieval";
import { noteReadResultSchema, noteReferenceSchema, revisionSchema } from "./schema";

export const eventSchema = z.object({
  id: z.string().max(256),
  ts: z.number().int().nonnegative(),
  type: z.string().max(128),
  payload: z.json(),
});
export const eventsResultSchema = z.object({
  ok: z.literal(true),
  events: z.array(eventSchema).max(100),
  cursor: z.string().nullable(),
});
export const capabilitiesSchema = z.object({
  ok: z.literal(true),
  apiVersion: z.literal("v1"),
  version: z.string(),
  vaultId: z.string().regex(/^[a-f0-9]{16}$/),
  operations: z.array(z.string()),
  limits: z.object({
    requestBytes: z.number(),
    concurrentRequests: z.number(),
    eventPage: z.number(),
    requestDurationMs: z.number(),
  }),
});
export const noteListSchema = z.object({
  ok: z.literal(true),
  notes: z
    .array(
      noteReferenceSchema.extend({
        tags: z.array(z.string()),
        aliases: z.array(z.string()),
        properties: z.record(z.string(), z.json()).nullable(),
      }),
    )
    .max(200),
  nextCursor: z.string().nullable(),
  snapshot: revisionSchema,
});
/** Only operations with an implemented, validated response are advertised. */
export const operationOutputs = {
  "brief.run": briefResultSchema,
  "notes.compare": comparisonResultSchema,
  "notes.correlate": comparisonResultSchema,
  ...hostOutputs,
  "capabilities.get": capabilitiesSchema,
  "notes.read": noteReadResultSchema,
  "graph.neighbors": graphNeighborsSchema,
  "graph.path": graphPathSchema,
  "history.list": historyListSchema,
  "history.get": historyDetailSchema,
  "history.undo": historyUndoResultSchema,
  "notes.list": noteListSchema,
  "search.run": retrievalResultSchema,
  "context.get": contextResultSchema,
  "ask.run": askResultSchema,
  "changes.get": changePreviewSchema,
  "changes.preview": changePreviewSchema,
  "changes.apply": changeResultSchema,
  "proposals.list": proposalListSchema,
  "proposals.get": proposalResultSchema,
  "proposals.approve": changeResultSchema,
  "proposals.reject": proposalResultSchema,
  "proposals.submit": proposalResultSchema,
  "jobs.list": jobListSchema,
  "jobs.get": jobResultSchema,
  "jobs.control": jobResultSchema,
  "pipelines.list": pipelineListSchema,
  "pipelines.run": jobResultSchema,
  "pipelines.validate": policyValidationSchema,
  "pipelines.configure": backgroundResultSchema,
  "background.pause": backgroundResultSchema,
  "chat.settings": chatSettingsResultSchema,
  "chat.configure": chatConfigureResultSchema,
  "events.subscribe": eventsResultSchema,
} as const;
export type ImplementedOperation = keyof typeof operationOutputs;
export type OperationResult<Name extends ImplementedOperation> = z.infer<
  (typeof operationOutputs)[Name]
>;
