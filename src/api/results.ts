import { z } from "zod";
import { askResultSchema } from "./ask";
import { backgroundResultSchema } from "./background";
import { briefResultSchema } from "./brief";
import { changePreviewSchema, changeResultSchema } from "./changes";
import {
  chatAbortResultSchema,
  chatApproveResultSchema,
  chatConfigureResultSchema,
  chatListResultSchema,
  chatLoadResultSchema,
  chatSendResultSchema,
  chatSettingsResultSchema,
  chatStartResultSchema,
} from "./chat";
import { comparisonResultSchema } from "./comparison";
import {
  contributionListSchema,
  contributionResultSchema,
  contributionStageResultSchema,
  contributionSubmitResultSchema,
} from "./contributions";
import {
  cultivationDigestSchema,
  cultivationSettingsResultSchema,
} from "./cultivation";
import { relationshipRetentionResultSchema } from "./relationshipRetention";
import { methodologySuggestionResultSchema } from "./methodology";
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
  principal: z
    .object({
      id: z.string(),
      kind: z.enum(["human", "agent"]),
      scopes: z.array(z.string()),
      vaultOwner: z.boolean(),
    })
    .optional(),
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
  "relationships.retain": relationshipRetentionResultSchema,
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
  "contributions.submit": contributionSubmitResultSchema,
  "feedback.submit": contributionSubmitResultSchema,
  "contributions.list": contributionListSchema,
  "contributions.get": contributionResultSchema,
  "contributions.stage": contributionStageResultSchema,
  "contributions.dismiss": contributionResultSchema,
  "jobs.list": jobListSchema,
  "jobs.get": jobResultSchema,
  "jobs.control": jobResultSchema,
  "pipelines.list": pipelineListSchema,
  "pipelines.run": jobResultSchema,
  "pipelines.validate": policyValidationSchema,
  "pipelines.configure": backgroundResultSchema,
  "background.pause": backgroundResultSchema,
  "cultivation.digest": cultivationDigestSchema,
  "cultivation.settings": cultivationSettingsResultSchema,
  "cultivation.configure": backgroundResultSchema,
  "methodology.suggest": methodologySuggestionResultSchema,
  "chat.start": chatStartResultSchema,
  "chat.send": chatSendResultSchema,
  "chat.abort": chatAbortResultSchema,
  "chat.list": chatListResultSchema,
  "chat.load": chatLoadResultSchema,
  "chat.approve": chatApproveResultSchema,
  "chat.settings": chatSettingsResultSchema,
  "chat.configure": chatConfigureResultSchema,
  "events.subscribe": eventsResultSchema,
} as const;
export type ImplementedOperation = keyof typeof operationOutputs;
export type OperationResult<Name extends ImplementedOperation> = z.infer<
  (typeof operationOutputs)[Name]
>;
