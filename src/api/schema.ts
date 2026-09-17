/** Public, transport-independent schema authority. No database or runtime imports. */
import { z } from "zod";
import { isCanonicalOrdinaryNotePath } from "../core/vault/publicPath";

export const notePathSchema = z
  .string({ error: "path must be an exact ordinary public vault-relative Markdown note path" })
  .refine(isCanonicalOrdinaryNotePath, {
    message: "path must be an exact ordinary public vault-relative Markdown note path",
  });
export const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const sourceRangeSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .refine((range) => range.end >= range.start && range.endLine >= range.startLine);
export const noteReferenceSchema = z.object({ path: notePathSchema, revision: revisionSchema });
export const sourceReferenceSchema = noteReferenceSchema.extend({
  range: sourceRangeSchema,
  quote: z.string(),
});
export const selectorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("heading"),
      text: z.string().min(1),
      occurrence: z.number().int().positive().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("block"), id: z.string().regex(/^[A-Za-z0-9_-]+$/) }).strict(),
  z
    .object({
      kind: z.literal("range"),
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    })
    .strict(),
]);
export const noteReadRequestSchema = z
  .object({
    path: notePathSchema,
    revision: revisionSchema.optional(),
    selector: selectorSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.selector?.kind === "range" && request.revision === undefined) {
      context.addIssue({ code: "custom", message: "range selection requires a source revision" });
    }
  });
export const apiErrorCodeSchema = z.enum([
  "INVALID_PARAMS",
  "NOT_FOUND",
  "CONFLICT",
  "FORBIDDEN",
  "INFERENCE_UNAVAILABLE",
  "PENDING_APPROVAL",
  "CANCELLED",
  "PARTIAL",
  "LIMIT_EXCEEDED",
  "INTERNAL_ERROR",
]);
export const mutationGuardSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(128),
    sources: z.array(noteReferenceSchema).min(1).max(200),
  })
  .strict();
export const pageSchema = z
  .object({
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().max(4096).optional(),
  })
  .strict();

export type NoteReference = z.infer<typeof noteReferenceSchema>;
export type SourceReference = z.infer<typeof sourceReferenceSchema>;
export type SourceRange = z.infer<typeof sourceRangeSchema>;
export type NoteSelector = z.infer<typeof selectorSchema>;
export type NoteReadRequest = z.infer<typeof noteReadRequestSchema>;
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const noteStructureSchema = z.object({
  frontmatter: z.object({
    properties: z.record(z.string(), z.json()).nullable(),
    raw: z.string(),
    range: sourceRangeSchema.nullable(),
    error: z.string().nullable(),
  }),
  headings: z.array(
    z.object({
      text: z.string(),
      level: z.number().int().min(1).max(6),
      occurrence: z.number().int().positive(),
      range: sourceRangeSchema,
      section: sourceRangeSchema,
    }),
  ),
  blocks: z.array(z.object({ id: z.string(), range: sourceRangeSchema })),
  links: z.array(
    z.object({
      kind: z.enum(["wiki", "markdown"]),
      target: z.string(),
      alias: z.string().nullable(),
      heading: z.string().nullable(),
      block: z.string().nullable(),
      embed: z.boolean(),
      range: sourceRangeSchema,
    }),
  ),
  tags: z.array(z.string()),
  aliases: z.array(z.string()),
  callouts: z.array(z.object({ kind: z.string(), title: z.string(), range: sourceRangeSchema })),
  tasks: z.array(z.object({ checked: z.boolean(), text: z.string(), range: sourceRangeSchema })),
});
export const noteReadResultSchema = z.object({
  ok: z.literal(true),
  body: z.string(),
  note: noteReferenceSchema,
  structure: noteStructureSchema,
  selected: sourceReferenceSchema.nullable(),
  freshness: z.object({
    source: z.literal("file"),
    indexedRevision: revisionSchema.nullable(),
    state: z.enum(["current", "lagging", "unknown"]),
  }),
});
export type NoteStructure = z.infer<typeof noteStructureSchema>;
export type NoteReadResult = z.infer<typeof noteReadResultSchema>;

export class NoteApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NoteApiError";
  }
}
