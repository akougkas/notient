import { z } from "zod";
import type { BriefResult } from "../../api/brief";
import { hasInternalSourceMarkers } from "../markdown/sourceMarkers";
import { type PipelineContext, retainedRecordWitnessSchema, witnessSchema } from "../pipelines/context";

const statement = z.strictObject({
  text: z
    .string()
    .min(1)
    .max(3600)
    .refine(
      (text) => !hasInternalSourceMarkers(text),
      "Write readable prose without numeric source markers; use structured evidence instead.",
    ),
  evidence: z.array(z.union([witnessSchema, retainedRecordWitnessSchema])).min(1).max(8),
});
const schema = z.strictObject({
  summary: statement.nullable(),
  findings: z
    .array(statement.extend({ kind: z.enum(["claim", "decision", "question", "tension"]) }))
    .max(20),
  abstention: z.string().min(1).nullable(),
});

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
    "Prepare a compact, useful brief on task.topic from the supplied saved notes. The summary should be two or three concise sentences in your own words. Put exact quotations in the structured evidence fields, without repeating them verbatim in the prose. Each quotation must be long enough to identify one occurrence in its supplied source and support the actual claim, including order or conditions when those matter. Add only the most useful distinct findings: claim for a concrete assertion, decision only for an explicitly adopted choice (not a plan or suggestion), question for a question actually raised in the text, and tension for competing claims with quotations from both notes. A question being present does not prove it is still unanswered. Different dates, scopes or assumptions alone do not establish a contradiction. Explain those qualifiers. Do not invent historical decisions, recency, resolution status or absence from truncated excerpts. Keep the result focused; do not fill categories with weak material. When describing saved findings, assessments, feedback, statuses or qualifications from retainedUnderstanding, cite each corresponding published recordWitness using its note and recordId. An introductory question or general topic passage does not evidence those retained contents. These citations report what the note retains, not independent evidence of the underlying facts. Do not describe a provisional suggestion as an adopted decision, supported as externally verified, or saved feedback as proven true. If there is insufficient relevant evidence, return summary=null, findings=[] and an explicit abstention.",
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
    { retainedRecordEvidence: true },
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
    summary: resolveStatement(context, output.summary),
    findings: output.findings.map((finding) => {
      const resolved = resolveStatement(context, finding);
      const evidence = resolved.evidence;
      if (finding.kind === "tension" && new Set(evidence.map((source) => source.path)).size < 2)
        throw new Error("a cross-note tension requires exact quotations from both notes");
      if (finding.kind === "decision" && finding.evidence.every((witness) => "recordId" in witness) &&
        !finding.evidence.some((witness) => "recordId" in witness && context.retainedRecord(witness)?.kind === "decision" && context.retainedRecord(witness)?.status === "decided"))
        throw new Error("a retained suggestion or finding does not establish an adopted decision");
      return { kind: finding.kind, ...resolved };
    }),
    abstained: false,
    reason: null,
  };
}

function resolveStatement(context: PipelineContext, value: z.infer<typeof statement>) {
  const recordIds = value.text.match(/\bi-[a-f0-9]{64}\b/gu) ?? [];
  for (const recordId of recordIds)
    if (!value.evidence.some((witness) => "recordId" in witness && witness.recordId === recordId))
      throw new Error("A statement about a retained record ID must cite that record's published recordWitness, not an introductory or unrelated passage.");
  const retained = value.evidence.some((witness) => "recordId" in witness);
  return {
    text: retained ? `As attributed understanding retained on the note: ${value.text} This brief does not independently verify the underlying claims.` : value.text,
    evidence: value.evidence.map((witness) => context.evidence(witness)),
  };
}
