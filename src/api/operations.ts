/** Runtime input contracts for the v1 note-centered API. Implementations register separately. */
import { z } from "zod";
import { isCanonicalPublicFolderPath } from "../core/vault/publicPath";
import { chatBudgetSchema } from "./chat";
import { historyIdSchema } from "./history";
import { hostInputs } from "./host";
import {
  mutationGuardSchema,
  notePathSchema,
  noteReadRequestSchema,
  noteReferenceSchema,
  pageSchema,
  revisionSchema,
  selectorSchema,
  sourceReferenceSchema,
} from "./schema";

export const folderSchema = z.string().refine(isCanonicalPublicFolderPath);
export const scopeSchema = z
  .object({
    paths: z.array(notePathSchema).max(200).default([]),
    folders: z.array(folderSchema).max(50).default([]),
    tags: z.array(z.string().min(1).max(128)).max(50).default([]),
    excludeFolders: z.array(folderSchema).max(50).default([]),
    excludeTags: z.array(z.string().min(1).max(128)).max(50).default([]),
  })
  .strict();
export const pipelineIdSchema = z.enum([
  "index-extract",
  "enrich",
  "relate",
  "contradictions",
  "synthesize",
  "inbox",
  "archive",
]);
export const effectSchema = z.enum([
  "create",
  "properties",
  "body",
  "relationships",
  "move",
  "archive",
]);
export const budgetSchema = z
  .object({
    notes: z.number().int().min(1).max(200),
    candidates: z.number().int().min(1).max(1000),
    modelCalls: z.number().int().min(0).max(100),
    tokens: z.number().int().min(0).max(1000000),
    generationTokens: z.number().int().min(1024).max(131072).default(8192),
    durationMs: z.number().int().min(1000).max(3600000),
    concurrency: z.number().int().min(1).max(8),
    retries: z.number().int().min(0).max(5),
    priority: z.number().int().min(0).max(10),
  })
  .strict();
export const pipelinePolicySchema = z
  .object({
    enabled: z.boolean(),
    triggers: z.array(z.enum(["save", "idle", "interval"])).max(3),
    debounceMs: z.number().int().min(0).max(3600000),
    cooldownMs: z.number().int().min(0).max(86400000),
    idleMs: z.number().int().min(1000).max(86400000),
    intervalMs: z.number().int().min(60000).max(31536000000),
    timezone: z.string().refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, "invalid IANA timezone"),
    windows: z
      .array(
        z
          .object({
            days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
            startMinute: z.number().int().min(0).max(1439),
            endMinute: z.number().int().min(1).max(1440),
          })
          .strict()
          .refine((value) => value.startMinute < value.endMinute),
      )
      .max(20),
    readScope: scopeSchema,
    writeScope: scopeSchema,
    destinations: z
      .object({ notes: folderSchema, inbox: folderSchema, archive: folderSchema })
      .strict(),
    allowedProperties: z.array(z.string().min(1).max(128)).max(50),
    allowedSections: z.array(z.string().min(1).max(256)).max(50),
    mode: z.enum(["report", "propose", "apply"]),
    effects: z.array(effectSchema).max(6),
    budget: budgetSchema,
    parameters: z
      .object({
        retrieval: z.enum(["lexical", "hybrid"]).default("lexical"),
        synthesis: z
          .object({
            kind: z.enum(["draft", "map"]).default("draft"),
            template: z
              .string()
              .max(20000)
              .refine(
                (value) =>
                  ["{{title}}", "{{body}}", "{{sources}}"].every(
                    (key) => value.split(key).length === 2,
                  ),
                "template must contain title, body and sources exactly once",
              )
              .default("# {{title}}\n\n{{body}}\n\n## Sources\n{{sources}}\n"),
            maxWords: z.number().int().min(100).max(3000).default(800),
          })
          .strict()
          .prefault({}),
        inbox: z
          .object({
            createDerivedNotes: z.boolean().default(false),
            processedProperty: z.string().min(1).max(128).default("status"),
            processedValue: z.string().max(128).default("processed"),
          })
          .strict()
          .prefault({}),
        archive: z
          .object({
            minimumAgeDays: z.number().int().min(0).max(36500).default(30),
            preserveOpenTasks: z.boolean().default(true),
            protectedTags: z.array(z.string()).max(50).default(["evergreen", "keep"]),
            allowRedundant: z.boolean().default(true),
          })
          .strict()
          .prefault({}),
        indexExtract: z
          .object({ embeddings: z.boolean().default(true), extraction: z.boolean().default(true) })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
  })
  .strict();
export const jobStateSchema = z.enum([
  "queued",
  "running",
  "paused",
  "waiting-inference",
  "awaiting-approval",
  "completed",
  "failed",
  "cancelled",
  "partial",
]);
const jobId = z.string().uuid();
const identifier = z.string().min(1).max(256);
const selectedNotes = z.array(noteReferenceSchema).min(1).max(200);
const query = z.string().min(1).max(8192);
const empty = z.object({}).strict();
/** UTF-16 offsets into the exact saved source revision, as a host selection maps them. */
const focusRange = z
  .object({ start: z.number().int().nonnegative(), end: z.number().int().positive() })
  .strict()
  .refine((range) => range.end > range.start && range.end - range.start <= 16000, {
    message: "focus must be a non-empty range of at most 16,000 characters",
  });
const change = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("relationship"),
      source: noteReferenceSchema,
      target: noteReferenceSchema,
      edgeId: identifier,
    })
    .strict(),
  z
    .object({
      kind: z.literal("create"),
      path: notePathSchema,
      body: z.string().max(4194304),
      expected: z.null(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("append"),
      source: noteReferenceSchema,
      text: z.string().max(1048576),
    })
    .strict(),
  z
    .object({
      kind: z.literal("edit"),
      source: noteReferenceSchema,
      selector: selectorSchema,
      replacement: z.string().max(1048576),
    })
    .strict(),
  z
    .object({
      kind: z.literal("properties"),
      source: noteReferenceSchema,
      patch: z.record(z.string(), z.json()),
    })
    .strict(),
  z
    .object({
      kind: z.enum(["move", "archive", "unarchive"]),
      source: noteReferenceSchema,
      destination: notePathSchema,
      updateReferences: z.boolean(),
    })
    .strict(),
]);
export const changeSetSchema = z
  .object({ idempotencyKey: z.string().min(1).max(128), changes: z.array(change).min(1).max(200) })
  .strict();
export const operationInputs = {
  ...hostInputs,
  "capabilities.get": empty,
  "notes.read": noteReadRequestSchema,
  "notes.list": pageSchema
    .extend({
      query: z.string().max(256).optional(),
      scope: scopeSchema.optional(),
      properties: z.record(z.string(), z.json()).optional(),
    })
    .strict(),
  "search.run": z
    .object({
      query,
      mode: z.enum(["lexical", "semantic", "hybrid"]),
      scope: scopeSchema,
      limit: z.number().int().min(1).max(100),
    })
    .strict(),
  "context.get": z
    .object({
      query,
      scope: scopeSchema,
      maxCharacters: z.number().int().min(1).max(100000),
      limit: z.number().int().min(1).max(50),
    })
    .strict(),
  "ask.run": z
    .object({
      query: query.refine((value) => value.trim() === value),
      scope: scopeSchema,
      maxRoundsPerTurn: z.number().int().min(2).max(8).optional(),
    })
    .strict(),
  "brief.run": z
    .object({
      query: query.refine((value) => value.trim() === value).optional(),
      source: noteReferenceSchema.optional(),
      focus: focusRange.optional(),
      scope: scopeSchema,
      limit: z.number().int().min(1).max(8).default(8),
    })
    .strict()
    .refine(
      (input) => (input.query === undefined) !== (input.source === undefined),
      "provide exactly one topic query or saved source revision",
    )
    .refine(
      (input) => input.focus === undefined || input.source !== undefined,
      "focus requires a saved source revision",
    ),
  "notes.compare": z
    .object({ sources: selectedNotes.min(2).max(8), question: query.optional() })
    .strict(),
  "notes.correlate": z
    .object({
      source: noteReferenceSchema,
      focus: focusRange.optional(),
      scope: scopeSchema,
      limit: z.number().int().min(1).max(100),
    })
    .strict(),
  "graph.neighbors": z
    .object({
      path: notePathSchema,
      includeProposed: z.boolean().default(false),
      limit: z.number().int().min(1).max(200).default(50),
    })
    .strict(),
  "graph.path": z
    .object({
      from: notePathSchema,
      to: notePathSchema,
      maxHops: z.number().int().min(1).max(6).default(3),
    })
    .strict(),
  "changes.get": z.object({ previewId: identifier }).strict(),
  "changes.preview": changeSetSchema,
  "changes.apply": z
    .object({
      previewId: identifier,
      previewRevision: revisionSchema,
      idempotencyKey: z.string().min(1).max(128),
    })
    .strict(),
  "proposals.list": pageSchema
    .extend({
      path: notePathSchema.optional(),
      state: z.enum(["pending", "approved", "rejected", "stale"]).optional(),
    })
    .strict(),
  "proposals.get": z.object({ id: identifier }).strict(),
  "proposals.approve": z
    .object({
      id: identifier,
      previewId: identifier,
      previewRevision: revisionSchema,
      idempotencyKey: identifier,
    })
    .strict(),
  "proposals.submit": z
    .object({
      previewId: identifier,
      previewRevision: revisionSchema,
      rationale: z.string().trim().min(1).max(8000),
      evidence: z.array(sourceReferenceSchema).max(50).default([]),
      idempotencyKey: identifier,
    })
    .strict(),
  "proposals.reject": z
    .object({ id: identifier, revision: revisionSchema, idempotencyKey: identifier })
    .strict(),
  "history.list": pageSchema.extend({ path: notePathSchema.optional() }).strict(),
  "history.get": z.object({ id: historyIdSchema }).strict(),
  "history.undo": mutationGuardSchema.extend({ id: historyIdSchema }).strict(),
  "pipelines.list": empty,
  "pipelines.validate": z
    .object({ pipeline: pipelineIdSchema, policy: pipelinePolicySchema })
    .strict(),
  "pipelines.configure": z
    .object({
      pipeline: pipelineIdSchema,
      policy: pipelinePolicySchema,
      revision: revisionSchema,
      idempotencyKey: identifier,
    })
    .strict(),
  "pipelines.run": z
    .object({
      pipeline: pipelineIdSchema,
      sources: selectedNotes,
      preview: z.boolean().default(false),
      idempotencyKey: identifier,
    })
    .strict(),
  "chat.settings": empty,
  "chat.configure": z
    .object({ budget: chatBudgetSchema, revision: revisionSchema, idempotencyKey: identifier })
    .strict(),
  "background.pause": z
    .object({ paused: z.boolean(), revision: revisionSchema, idempotencyKey: identifier })
    .strict(),
  "jobs.list": pageSchema
    .extend({ pipeline: pipelineIdSchema.optional(), state: jobStateSchema.optional() })
    .strict(),
  "jobs.get": z.object({ id: jobId }).strict(),
  "jobs.control": z
    .object({
      id: jobId,
      action: z.enum(["pause", "resume", "cancel", "retry"]),
      revision: revisionSchema,
      idempotencyKey: identifier,
    })
    .strict(),
  "events.subscribe": z.object({ cursor: identifier.optional() }).strict(),
} as const;
export type OperationName = keyof typeof operationInputs;
export type OperationInput<Name extends OperationName> = z.input<(typeof operationInputs)[Name]>;
export type PipelinePolicy = z.infer<typeof pipelinePolicySchema>;
export type PipelineId = z.infer<typeof pipelineIdSchema>;
export type ChangeSet = z.infer<typeof changeSetSchema>;
export const evidenceResultSchema = z
  .object({
    explanation: z.string(),
    evidence: z.array(sourceReferenceSchema).max(200),
    abstained: z.boolean(),
    reason: z.string().nullable(),
  })
  .strict();
