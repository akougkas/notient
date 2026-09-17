import { z } from "zod";
import { searchCoverageSchema } from "./indexing";
import { inferenceAttemptSchema } from "./pipelines";
import { noteReferenceSchema, sourceReferenceSchema } from "./schema";

export const briefStatementSchema = z.strictObject({
  text: z.string().min(1).max(4000),
  evidence: z.array(sourceReferenceSchema).min(1).max(8),
});
export const briefFindingSchema = briefStatementSchema
  .extend({
    kind: z.enum(["claim", "decision", "question", "tension"]),
  })
  .superRefine((finding, context) => {
    if (
      finding.kind === "tension" &&
      new Set(finding.evidence.map((source) => source.path)).size < 2
    )
      context.addIssue({
        code: "custom",
        message: "a cross-note tension requires evidence from both notes",
      });
  });
export const briefResultSchema = z
  .object({
    ok: z.literal(true),
    topic: z.string().min(1).max(8192),
    summary: briefStatementSchema.nullable(),
    findings: z.array(briefFindingSchema).max(20),
    sources: z.array(noteReferenceSchema).max(8),
    abstained: z.boolean(),
    reason: z.string().min(1).nullable(),
    coverage: searchCoverageSchema,
    limitations: z.array(z.string().min(1)).max(20),
    attempts: z.array(inferenceAttemptSchema).max(2),
    durationMs: z.number().int().nonnegative(),
  })
  .superRefine((result, context) => {
    if (
      result.abstained !== (result.summary === null) ||
      (result.abstained ? !result.reason || result.findings.length > 0 : result.reason !== null)
    )
      context.addIssue({
        code: "custom",
        message: "brief outcome must match its grounded statements",
      });
    if (new Set(result.sources.map((source) => source.path)).size !== result.sources.length)
      context.addIssue({ code: "custom", message: "inspected sources must be distinct" });
    const evidence = [
      ...(result.summary?.evidence ?? []),
      ...result.findings.flatMap((finding) => finding.evidence),
    ];
    if (
      evidence.some(
        (citation) =>
          !result.sources.some(
            (source) => source.path === citation.path && source.revision === citation.revision,
          ),
      )
    )
      context.addIssue({
        code: "custom",
        message: "brief statements must cite an inspected source revision",
      });
  });
export type BriefResult = z.infer<typeof briefResultSchema>;

/** Bind a successful response to the actual request at external boundaries. */
export function briefResultFor(input: {
  query?: string;
  source?: { path: string; revision: string };
  limit?: number;
}) {
  return briefResultSchema.superRefine((result, context) => {
    if (
      (input.query !== undefined && result.topic !== input.query) ||
      result.sources.length > (input.limit ?? 8) ||
      (input.source &&
        !result.sources.some(
          (source) =>
            source.path === input.source?.path && source.revision === input.source?.revision,
        ))
    )
      context.addIssue({
        code: "custom",
        message: "brief sources or topic do not match the request",
      });
  });
}
