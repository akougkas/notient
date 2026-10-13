import { z } from "zod";
import { searchCoverageSchema } from "./indexing";
import {
  noteReferenceSchema,
  noteStructureSchema,
  revisionSchema,
  sourceReferenceSchema,
} from "./schema";

export const retrievalHitSchema = z
  .object({
    note: noteReferenceSchema,
    score: z.number().finite(),
    scoreKind: z.enum(["bm25", "cosine-similarity", "reciprocal-rank"]),
    evidence: sourceReferenceSchema.nullable(),
    freshness: z.object({
      indexedRevision: revisionSchema.nullable(),
      state: z.enum(["current", "lagging", "unknown"]),
      reason: z.string().nullable(),
    }),
  })
  .strict();
export const retrievalResultSchema = z.object({
  coverage: searchCoverageSchema,
  ok: z.literal(true),
  query: z.string(),
  mode: z.enum(["lexical", "semantic", "hybrid"]),
  hits: z.array(retrievalHitSchema).max(100),
  durationMs: z.number().nonnegative(),
  omitted: z.number().int().nonnegative(),
});
export const contextResultSchema = z.object({
  coverage: searchCoverageSchema,
  ok: z.literal(true),
  query: z.string(),
  sources: z.array(sourceReferenceSchema).max(50),
  omittedStale: z.number().int().nonnegative(),
  characters: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type RetrievalResult = z.infer<typeof retrievalResultSchema>;
export type RetrievalHit = z.infer<typeof retrievalHitSchema>;
export type ContextResult = z.infer<typeof contextResultSchema>;

export const noteExcerptSchema = z
  .object({
    notePath: noteReferenceSchema.shape.path,
    body: z.string().max(12000),
    totalLines: z.number().int().positive(),
    totalCharacters: z.number().int().nonnegative().optional(),
    retainedUnderstanding: z
      .object({
        records: z
          .array(z.object({
            recordId: z.string().regex(/^i-[a-f0-9]{64}$/),
            source: sourceReferenceSchema,
          }).strict())
          .max(4),
        omitted: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    lineRange: z.object({ start: z.number().int().positive(), end: z.number().int().positive() }),
    evidence: sourceReferenceSchema,
    truncated: z.boolean(),
    structure: noteStructureSchema.nullable(),
    structureOmitted: z.boolean(),
  })
  .strict();
