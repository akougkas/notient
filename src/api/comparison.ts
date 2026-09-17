import { z } from "zod";
import { searchCoverageSchema } from "./indexing";
import { inferenceAttemptSchema } from "./pipelines";
import { noteReferenceSchema, sourceReferenceSchema } from "./schema";

export const comparisonJudgmentSchema = z.enum([
  "supports",
  "extends",
  "exemplifies",
  "related_to",
  "contradiction",
  "temporal-change",
  "different-assumptions",
  "unrelated",
  "insufficient",
]);
export const noteComparisonSchema = z
  .strictObject({
    source: noteReferenceSchema,
    target: noteReferenceSchema,
    judgment: comparisonJudgmentSchema,
    assessment: z.number().min(0).max(1),
    explanation: z.string().min(1).max(4000),
    evidence: z.array(sourceReferenceSchema).max(8),
  })
  .superRefine((item, context) => {
    if (item.source.path === item.target.path)
      context.addIssue({ code: "custom", message: "comparison requires different notes" });
    const sources = [item.source, item.target];
    if (
      item.evidence.some(
        (evidence) =>
          !sources.some(
            (source) => source.path === evidence.path && source.revision === evidence.revision,
          ),
      )
    )
      context.addIssue({
        code: "custom",
        message: "comparison evidence lies outside its exact source pair",
      });
    if (
      !["unrelated", "insufficient"].includes(item.judgment) &&
      (item.assessment === 0 ||
        !sources.every((source) => item.evidence.some((evidence) => evidence.path === source.path)))
    )
      context.addIssue({
        code: "custom",
        message: "a supported comparison needs evidence from both notes",
      });
  });
export type NoteComparison = z.infer<typeof noteComparisonSchema>;
export const comparisonResultSchema = z
  .object({
    ok: z.literal(true),
    sources: z.array(noteReferenceSchema).min(1).max(8),
    comparisons: z.array(noteComparisonSchema).max(40),
    abstained: z.boolean(),
    reason: z.string().min(1).nullable(),
    coverage: searchCoverageSchema.nullable(),
    limitations: z.array(z.string().min(1)).max(20),
    attempts: z.array(inferenceAttemptSchema).max(2),
    durationMs: z.number().int().nonnegative(),
  })
  .superRefine((result, context) => {
    if (new Set(result.sources.map((source) => source.path)).size !== result.sources.length)
      context.addIssue({ code: "custom", message: "comparison sources must be distinct" });
    const pairs = result.comparisons.map((item) =>
      [item.source.path, item.target.path].sort().join("\0"),
    );
    if (
      new Set(pairs).size !== pairs.length ||
      result.comparisons.some((item) =>
        [item.source, item.target].some(
          (source) =>
            !result.sources.some(
              (ref) => ref.path === source.path && ref.revision === source.revision,
            ),
        ),
      )
    )
      context.addIssue({
        code: "custom",
        message: "comparison pairs must be unique and bound to inspected sources",
      });
    const supported = result.comparisons.some(
      (item) => !["unrelated", "insufficient"].includes(item.judgment),
    );
    if (
      result.abstained === supported ||
      (result.abstained ? !result.reason : result.reason !== null)
    )
      context.addIssue({
        code: "custom",
        message: "comparison outcome must match its supported evidence",
      });
  });
export type ComparisonResult = z.infer<typeof comparisonResultSchema>;
