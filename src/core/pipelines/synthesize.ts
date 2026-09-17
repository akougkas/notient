import { z } from "zod";
import type { PipelinePlan } from "../../api/pipelines";
import type { SourceReference } from "../../api/schema";
import { hasInternalSourceMarkers } from "../markdown/sourceMarkers";
import { noteFilename } from "../vault/noteFilename";
import { type PipelineContext, witnessSchema } from "./context";

const schema = z
  .object({
    title: z.string().max(160),
    sections: z
      .array(
        z
          .object({
            heading: z.string().min(1).max(200),
            paragraphs: z
              .array(
                z
                  .object({
                    text: z
                      .string()
                      .min(1)
                      .max(2500)
                      .refine(
                        (text) => !hasInternalSourceMarkers(text),
                        "Write original prose without numeric source markers such as [0]. Put exact quotations and source indices only in the evidence array; the renderer adds source links.",
                      ),
                    evidence: z.array(witnessSchema).min(1).max(8),
                  })
                  .strict(),
              )
              .min(1)
              .max(8),
          })
          .strict(),
      )
      .max(10),
    abstention: z.string().nullable(),
  })
  .strict();
export async function synthesizeNotes(context: PipelineContext, plan: PipelinePlan): Promise<void> {
  if (context.selected.length < 2) await context.retrieve();
  if (context.documents.length < 2) {
    plan.reason = "Synthesis requires at least two relevant sources.";
    return;
  }
  const settings = context.options.policy.parameters.synthesis;
  const output = await context.model(
    "synthesize_notes",
    `Write a useful ${settings.kind === "map" ? "map of content connecting source topics with concise annotations" : "draft that combines complementary facts, explains their connections, and names unresolved tensions"}. Use at least two sources substantively. Write fluent, original prose that explains the connection; do not stitch quotations together or repeat what each source says separately. Put exact supporting quotations and numeric source indices in each paragraph's evidence array. The text must contain no numeric citation markers such as [0] or [1] and no Sources section: the renderer adds readable wikilinks. Stay within ${settings.maxWords} words. Distinguish documented facts from inferences and open questions. Do not invent experiments, decisions, dates or consensus. Describe conflicting accounts explicitly. If sources are empty, unrelated or cannot support a useful synthesis, return empty sections and an abstention. Being selected together is not evidence that notes are related. A shared generic theme such as care, maintenance, quality or planning is not a connection: when the subjects differ and no source refers to the other's subject, abstain. If your draft would have to say that the sources have no documented relationship, abstain instead of writing it.`,
    schema,
  );
  if (!output.sections.length) {
    plan.reason = output.abstention ?? "Sources did not support a useful synthesis.";
    return;
  }
  if (!output.title.trim()) throw new Error("synthesis requires a meaningful title");
  const evidence = output.sections.flatMap((section) =>
    section.paragraphs.flatMap((paragraph) =>
      paragraph.evidence.map((witness) => context.evidence(witness)),
    ),
  );
  if (new Set(evidence.map((entry) => entry.path)).size < 2)
    throw new Error("synthesis did not use two distinct sources");
  const sources = [...new Set(evidence.map((entry) => entry.path))];
  const body = output.sections
    .map(
      (section) =>
        `## ${section.heading.replaceAll("\n", " ")}\n\n${section.paragraphs
          .map((paragraph) => {
            const citations = [
              ...new Set(paragraph.evidence.map((witness) => context.evidence(witness).path)),
            ]
              .map((path) => `[[${path.slice(0, -3)}]]`)
              .join("; ");
            return `${paragraph.text}\n\nSources: ${citations}`;
          })
          .join("\n\n")}`,
    )
    .join("\n\n");
  if (body.split(/\s+/).length > settings.maxWords + 150)
    throw new Error("synthesis exceeded its configured length");
  const content = settings.template
    .replace("{{title}}", () => output.title.replaceAll("\n", " "))
    .replace("{{body}}", () => body)
    .replace("{{sources}}", () => sources.map((path) => `- [[${path.slice(0, -3)}]]`).join("\n"));
  const folder = context.options.policy.destinations.notes;
  const path = [folder, noteFilename(output.title)].filter(Boolean).join("/");
  plan.changes.push({ kind: "create", path, body: content, expected: null });
  const shown = reviewEvidence(evidence, FINDING_EVIDENCE_LIMIT);
  plan.findings.push({
    kind: "synthesis",
    title: output.title,
    explanation: `Cited ${settings.kind} drawing on ${sources.length} sources.${shown.omitted ? ` Review shows ${shown.entries.length} of ${shown.entries.length + shown.omitted} distinct quotations, covering every cited source first.` : ""}`,
    evidence: shown.entries,
  });
}

const FINDING_EVIDENCE_LIMIT = 30;

/**
 * Distinct quotations for review, taken one source at a time in citation
 * order so a source cited late in a long draft is still represented.
 */
function reviewEvidence(
  evidence: SourceReference[],
  limit: number,
): { entries: SourceReference[]; omitted: number } {
  const bySource = new Map<string, SourceReference[]>();
  const seen = new Set<string>();
  for (const entry of evidence) {
    const key = `${entry.path}:${entry.range.start}:${entry.range.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bySource.set(entry.path, [...(bySource.get(entry.path) ?? []), entry]);
  }
  const queues = [...bySource.values()];
  const entries: SourceReference[] = [];
  for (
    let round = 0;
    entries.length < limit && queues.some((queue) => queue.length > round);
    round++
  )
    for (const queue of queues)
      if (round < queue.length && entries.length < limit) entries.push(queue[round]);
  return { entries, omitted: seen.size - entries.length };
}
