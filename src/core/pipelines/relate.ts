import { z } from "zod";
import type { NoteComparison } from "../../api/comparison";
import type { PipelinePlan } from "../../api/pipelines";
import { hasInternalSourceMarkers } from "../markdown/sourceMarkers";
import { type PipelineContext, witnessSchema } from "./context";

const schema = z
  .object({
    comparisons: z
      .array(
        z
          .object({
            source: z
              .number()
              .int()
              .nonnegative()
              .describe(
                "Subject of the directed relation: this note supports, extends or exemplifies the target.",
              ),
            target: z
              .number()
              .int()
              .nonnegative()
              .describe(
                "Object of the directed relation; may be the selected note when a retrieved note extends it.",
              ),
            judgment: z.enum([
              "supports",
              "extends",
              "exemplifies",
              "related_to",
              "contradiction",
              "temporal-change",
              "different-assumptions",
              "unrelated",
              "insufficient",
            ]),
            assessment: z
              .number()
              .min(0)
              .max(1)
              .describe(
                "Decimal from 0 to 1 inclusive, never a percentage. Heuristic strength of textual support, not a probability.",
              ),
            explanation: z
              .string()
              .min(1)
              .max(4000)
              .refine(
                (text) => !hasInternalSourceMarkers(text),
                "Explain using readable note titles, without numeric source markers such as [0]. Put source indices only in structured evidence; the interface supplies source navigation.",
              ),
            evidence: z
              .array(witnessSchema)
              .max(8)
              .describe(
                "For a supported judgment include at least one exact quotation with note=source and another with note=target. Evidence from only one side is invalid. Unrelated or insufficient may have no quotations.",
              ),
          })
          .strict(),
      )
      .max(40),
    abstention: z.string().nullable(),
  })
  .strict();

export async function relateNotes(
  context: PipelineContext,
  plan: PipelinePlan,
  contradictions = false,
): Promise<void> {
  await context.retrieve();
  const report = await analyzeRelationships(context, { contradictions });
  for (const item of report.comparisons) {
    if (["unrelated", "insufficient"].includes(item.judgment)) continue;
    if (
      contradictions &&
      !["contradiction", "temporal-change", "different-assumptions"].includes(item.judgment)
    )
      continue;
    const kind = ["contradiction", "temporal-change", "different-assumptions"].includes(
      item.judgment,
    )
      ? (item.judgment as "contradiction" | "temporal-change" | "different-assumptions")
      : "relationship";
    plan.findings.push({
      kind,
      title: `${item.source.path} · ${item.target.path}`,
      explanation: item.explanation,
      evidence: item.evidence,
    });
    if (item.judgment === "temporal-change" || item.judgment === "different-assumptions") continue;
    plan.relationships.push({
      relation:
        item.judgment === "contradiction"
          ? "contradicts"
          : (item.judgment as "supports" | "extends" | "exemplifies" | "related_to"),
      source: item.source,
      target: item.target,
      rationale: item.explanation,
      evidence: item.evidence,
      assessment: item.assessment,
    });
  }
  if (!plan.findings.length)
    plan.reason =
      report.reason ??
      "The examined sources do not establish incompatible claims under matching assumptions.";
}

/** One evidence/judgment implementation for finite pipelines and read-only note analysis. */
export async function analyzeRelationships(
  context: PipelineContext,
  options: { contradictions?: boolean; question?: string } = {},
): Promise<{ comparisons: NoteComparison[]; reason: string | null }> {
  const { contradictions = false } = options;
  if (context.documents.length < 2)
    return { comparisons: [], reason: "No second relevant source is available for a comparison." };
  const output = await context.model(
    contradictions ? "compare_claims" : "relate_notes",
    contradictions
      ? "Compare selected notes with relevant supplied historical notes. Every pair MUST include at least one document with selected=true; never compare two retrieved-only candidates. Assessment is a decimal from 0 to 1, never a percentage. Examine concrete claims about the same referent. A genuine contradiction requires incompatible assertions under the same time, definitions, assumptions and scope. Explicitly distinguish temporal-change and different-assumptions; do not call those contradictions. temporal-change requires affirmative evidence that the same proposition changed over time; different dates alone do not establish that a change occurred. Use insufficient for a merely possible change. Return only the strongest useful comparisons, not an inventory of every unrelated pair. Quoted questions, speculation, different cohorts or incomplete evidence do not establish conflict. Return unrelated/insufficient or abstain where warranted. Explain the actual claims and qualifiers, not just shared vocabulary."
      : "Compare selected notes with supplied candidates. Every pair MUST include at least one document with selected=true; never compare two retrieved-only candidates. Assessment is a decimal from 0 to 1, never a percentage. Propose only a useful specific connection, supported by substantive passages from both sides. A reference list mentioning a page, a matching URL, navigation links, or mirrored copies of the same text do not establish a knowledge relationship: abstain on these. supports must corroborate a concrete claim, not confirm that a document exists or appears in an index. Direction is source -> target: source supports/corroborates target, source extends target by adding a concrete limitation or development, or source exemplifies target by supplying an instance. Choose the indices in that order, even when the selected note is the TARGET. If note B develops note A, return source=B, target=A, judgment=extends. The explanation must agree with that direction. related_to needs an explicit shared mechanism or practical connection. If task.question is provided, use it to choose the most relevant comparison. Distinguish genuine contradiction under the same time, definitions and scope from temporal-change or different-assumptions; dates alone do not establish change. When apparent disagreement is explained by scope, conditions or assumptions, use different-assumptions. Do not label independent policies as extends merely because one describes an exception excluded by the other; extends requires an actual added development of the same subject. Explain the actual qualifiers on both sides. Mere topic words, contradictory instructions and vague similarity are insufficient. Explain the connection so a reader can judge it. Return unrelated/insufficient where appropriate.",
    // A direct question is supplied as data, never additional tool authority.
    schema.superRefine((value, validation) => {
      try {
        relationshipReport(context, value);
      } catch (error) {
        validation.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }),
    options.question ? { question: options.question } : undefined,
  );
  return relationshipReport(context, output);
}

function relationshipReport(
  context: PipelineContext,
  output: z.infer<typeof schema>,
): { comparisons: NoteComparison[]; reason: string | null } {
  const comparisons: NoteComparison[] = [];
  const seen = new Set<string>();
  const abstentions: string[] = [];
  for (const item of output.comparisons) {
    const source = context.documents[item.source];
    const target = context.documents[item.target];
    if (
      !source ||
      !target ||
      source === target ||
      (!context.selected.includes(source) && !context.selected.includes(target))
    )
      throw new Error("comparison uses an invalid pair");
    const key = [item.source, item.target].sort().join(":");
    if (seen.has(key)) throw new Error("comparison repeated the same pair");
    seen.add(key);
    const evidence = item.evidence.map((entry) => context.evidence(entry));
    if (["unrelated", "insufficient"].includes(item.judgment) || item.assessment === 0) {
      if (
        evidence.some((entry) => entry.path !== source.note.path && entry.path !== target.note.path)
      )
        throw new Error("comparison abstention cited a source outside its pair");
      abstentions.push(`${source.note.path} · ${target.note.path}: ${item.explanation}`);
      comparisons.push({
        ...item,
        source: source.note,
        target: target.note,
        evidence,
        judgment: item.assessment === 0 ? "insufficient" : item.judgment,
      });
      continue;
    }
    if (
      ![source, target].every((note) => evidence.some((entry) => entry.path === note.note.path)) ||
      evidence.some((entry) => entry.path !== source.note.path && entry.path !== target.note.path)
    )
      throw new Error(
        `comparison ${item.source} -> ${item.target} requires exact evidence from both sides; include at least one substantive quotation with note=${item.source} and another with note=${item.target}, or use insufficient when the supplied passages cannot support the relationship`,
      );
    if (
      ![source, target].every((note) =>
        evidence.some((entry) => entry.path === note.note.path && !referenceOnly(entry.quote)),
      )
    ) {
      const explanation =
        "A bibliographic pointer alone does not support a substantive connection.";
      abstentions.push(`${source.note.path} · ${target.note.path}: ${explanation}`);
      comparisons.push({
        source: source.note,
        target: target.note,
        judgment: "insufficient",
        assessment: 0,
        explanation,
        evidence,
      });
      continue;
    }
    comparisons.push({ ...item, source: source.note, target: target.note, evidence });
  }
  const supported = comparisons.some(
    (item) => !["unrelated", "insufficient"].includes(item.judgment),
  );
  const reason =
    output.abstention?.trim() ||
    abstentions.join("\n\n").slice(0, 8000) ||
    "The examined sources do not support a useful connection or an incompatible claim under matching assumptions.";
  return { comparisons, reason: supported ? null : reason };
}

/** A standalone reference, including a short labelled bibliography entry, is
 * navigation evidence. It cannot by itself support a claim about its target. */
export function referenceOnly(quote: string): boolean {
  return /^(?:[-*+]\s+|\d+\.\s+)?(?:\*{0,2}[^:\n]{1,100}\*{0,2}:\s*)?(?:https?:\/\/\S+|\[[^\]]+\]\([^)]+\)|\[\[[^\]]+\]\])\s*$/u.test(
    quote.trim(),
  );
}
