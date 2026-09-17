import { z } from "zod";
import { HISTORY_KINDS } from "../core/history/types";
import { noteReferenceSchema, revisionSchema } from "./schema";

// Public validation must remain usable in browsers and native Obsidian.
export const historyIdSchema = z
  .string()
  .regex(
    /^history:u"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"$/,
    "expected a canonical history UUID record id",
  );
export const historyUndoSchema = z
  .strictObject({
    startedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative().nullable(),
    clientIdentity: z.string().min(1),
  })
  .nullable();
export const historyEntrySchema = z.strictObject({
  id: historyIdSchema,
  kind: z.enum(HISTORY_KINDS),
  target: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  clientIdentity: z.string().min(1),
  undo: historyUndoSchema,
  reversible: z.boolean(),
});
export const historyListSchema = z
  .object({
    ok: z.literal(true),
    entries: z.array(historyEntrySchema).max(200),
    nextCursor: z.string().nullable(),
    snapshot: revisionSchema,
  })
  .refine(
    (result) => new Set(result.entries.map((entry) => entry.id)).size === result.entries.length,
    "history page contains duplicate entries",
  );
export const historyDetailSchema = z.object({
  ok: z.literal(true),
  entry: historyEntrySchema,
  before: z.string().nullable(),
  after: z.string().nullable(),
  sources: z.array(noteReferenceSchema).max(1),
  destination: z.string().nullable(),
});
export const historyUndoResultSchema = z.object({
  ok: z.literal(true),
  entry: historyEntrySchema.refine(
    (entry) => entry.undo?.completedAt != null,
    "undo requires a durable completion receipt",
  ),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
export type HistoryDetail = z.infer<typeof historyDetailSchema>;
export interface HistoryCaller {
  id: string;
  kind: "human" | "agent";
  scopes: string[];
}
