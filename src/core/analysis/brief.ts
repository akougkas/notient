import { z } from "zod";
import type { BriefResult } from "../../api/brief";
import { hasInternalSourceMarkers } from "../markdown/sourceMarkers";
import { type PipelineContext, witnessSchema } from "../pipelines/context";

const statement = z.strictObject({
  text: z
    .string()
    .min(1)
    .max(4000)
    .refine(
      (text) => !hasInternalSourceMarkers(text),
      "Write readable prose without numeric source markers; use structured evidence instead.",
    ),
  evidence: z.array(witnessSchema).min(1).max(8),
});
const schema = z.strictObject({
  summary: statement.nullable(),
  findings: z
    .array(statement.extend({ kind: z.enum(["claim", "decision", "question", "tension"]) }))
    .max(20),
  abstention: z.string().min(1).nullable(),
});

/** A compact source-grounded briefing, using the same bounded context and
 * schema correction as other note analysis. Stored paraphrases are not evidence. */
export async function composeBrief(
  context: PipelineContext,
  topic: string,
): Promise<Pick<BriefResult, "summary" | "findings" | "abstained" | "reason">> {
  if (!context.documents.length)
    return {
      summary: null,
      findings: [],
      abstained: true,
      reason:
        "No current source passages were found within this scope. Missing results do not establish absence.",
    };
  const output = await context.model(
    "knowledge_brief",
    "Prepare a compact, useful brief on task.topic from the supplied saved notes. The summary should be two or three concise sentences in your own words. Put exact quotations in the structured evidence fields, without repeating them verbatim in the prose. Each quotation must be long enough to identify one occurrence in its supplied source and support the actual claim, including order or conditions when those matter. Add only the most useful distinct findings: claim for a concrete assertion, decision only for an explicitly adopted choice (not a plan or suggestion), question for a question actually raised in the text, and tension for competing claims with quotations from both notes. A question being present does not prove it is still unanswered. Different dates, scopes or assumptions alone do not establish a contradiction. Explain those qualifiers. Do not invent historical decisions, recency, resolution status or absence from truncated excerpts. Keep the result focused; do not fill categories with weak material. If there is insufficient relevant evidence, return summary=null, findings=[] and an explicit abstention.",
    schema.superRefine((output, validation) => {
      try {
        resolveBrief(context, output);
      } catch (error) {
        validation.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }),
    { topic },
  );
  return resolveBrief(context, output);
}
function resolveBrief(
  context: PipelineContext,
  output: z.infer<typeof schema>,
): Pick<BriefResult, "summary" | "findings" | "abstained" | "reason"> {
  if (output.summary === null) {
    if (output.findings.length || !output.abstention)
      throw new Error("an abstained brief requires a reason and no findings");
    return {
      summary: null,
      findings: [],
      abstained: true,
      reason:
        output.abstention ?? "The supplied passages do not establish a useful brief on this topic.",
    };
  }
  if (output.abstention !== null)
    throw new Error("a supported brief cannot simultaneously abstain");
  return {
    summary: {
      text: output.summary.text,
      evidence: output.summary.evidence.map((witness) => context.evidence(witness)),
    },
    findings: output.findings.map((finding) => {
      const evidence = finding.evidence.map((witness) => context.evidence(witness));
      if (finding.kind === "tension" && new Set(evidence.map((source) => source.path)).size < 2)
        throw new Error("a cross-note tension requires exact quotations from both notes");
      return { ...finding, evidence };
    }),
    abstained: false,
    reason: null,
  };
}
