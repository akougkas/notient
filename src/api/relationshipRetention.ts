import { z } from "zod";
import { WRITEBACK_EDGE_TABLES } from "../core/db/edgeTables";
import { reviewProposalSchema } from "./proposals";
import { notePathSchema, revisionSchema } from "./schema";

const writebackEdgeTableSchema = z.enum(WRITEBACK_EDGE_TABLES);
const evidenceStateSchema = z.enum(["current", "stale", "unavailable"]);
const recordIdSchema = z.string().regex(/^i-[a-f0-9]{64}$/);

export const relationshipRetentionResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      ok: z.literal(true),
      status: z.literal("proposal-created"),
      edgeId: z.string().min(1).max(512),
      relation: writebackEdgeTableSchema,
      sourcePath: notePathSchema,
      targetPath: notePathSchema,
      evidenceState: evidenceStateSchema,
      recordId: recordIdSchema,
      previewId: revisionSchema,
      previewRevision: revisionSchema,
      proposal: reviewProposalSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      status: z.literal("already-retained"),
      edgeId: z.string().min(1).max(512),
      relation: writebackEdgeTableSchema,
      sourcePath: notePathSchema,
      targetPath: notePathSchema,
      evidenceState: evidenceStateSchema,
      recordId: recordIdSchema,
      previewId: z.null(),
      previewRevision: z.null(),
      proposal: z.null(),
    })
    .strict(),
]);

export type RelationshipRetentionResult = z.infer<typeof relationshipRetentionResultSchema>;
