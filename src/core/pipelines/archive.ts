import { z } from "zod";
import type { PipelinePlan } from "../../api/pipelines";
import { insideFolder } from "../../api/scope";
import { hasTag } from "../markdown/tags";
import { type PipelineContext, witnessSchema } from "./context";

const schema = z
  .object({
    reviews: z
      .array(
        z
          .object({
            note: z.number().int().nonnegative(),
            judgment: z.enum(["retain", "completed", "superseded", "redundant", "insufficient"]),
            explanation: z.string().min(1).max(4000),
            evidence: z.array(witnessSchema).max(8),
          })
          .strict(),
      )
      .max(24),
    abstention: z.string().nullable(),
  })
  .strict();
export async function reviewArchive(context: PipelineContext, plan: PipelinePlan): Promise<void> {
  const criteria = context.options.policy.parameters.archive;
  const listing = await context.options.vault.listMarkdown();
  const eligible = context.selected.filter((note) => {
    if (insideFolder(note.note.path, context.options.policy.destinations.archive)) return false;
    if (criteria.preserveOpenTasks && note.structure.tasks.some((task) => !task.checked))
      return false;
    if (criteria.protectedTags.some((tag) => hasTag(note.structure.tags, tag, true))) return false;
    const modified = listing.find((entry) => entry.path === note.note.path)?.mtime;
    return modified !== undefined && Date.now() - modified >= criteria.minimumAgeDays * 86400000;
  });
  if (!eligible.length) {
    plan.reason =
      "No selected notes meet the age, protected-tag and unfinished-task criteria. Age is only an eligibility filter.";
    return;
  }
  await context.retrieve(eligible);
  const output = await context.model(
    "review_archive",
    "Review only the eligible note indices. Set judgment=retain to keep evergreen/reference material, active decisions, unique unresolved knowledge, or notes needed to understand current work. Set judgment=completed when the content explicitly establishes that the work is finished with no unresolved useful material and you recommend moving the note to the archive. Set judgment=superseded or redundant only when a supplied replacement covers all useful content. Set judgment=insufficient if uncertain. The judgment is the action decision: do not say retain when your explanation recommends archiving. Age alone is never evidence of irrelevance. Cite the target note and, for superseded/redundant, its replacement. Explain what would be lost.",
    schema,
    { eligible: eligible.map((note) => context.documents.indexOf(note)), criteria },
  );
  const seen = new Set<number>();
  for (const item of output.reviews) {
    if (item.judgment === "retain" || item.judgment === "insufficient") continue;
    const note = context.documents[item.note];
    if (!eligible.includes(note) || seen.has(item.note))
      throw new Error("archive review selected an ineligible or duplicate source");
    // A passage cannot establish that the rest of a note has no useful work.
    if (!context.isComplete(note)) continue;
    seen.add(item.note);
    if (item.judgment === "redundant" && !criteria.allowRedundant) continue;
    const evidence = item.evidence.map((witness) => context.evidence(witness));
    if (!evidence.some((entry) => entry.path === note.note.path))
      throw new Error("archive recommendation lacks target-note evidence");
    if (item.judgment !== "completed" && !evidence.some((entry) => entry.path !== note.note.path))
      throw new Error("archive recommendation lacks replacement evidence");
    const destination = [context.options.policy.destinations.archive, note.note.path]
      .filter(Boolean)
      .join("/");
    plan.changes.push({ kind: "archive", source: note.note, destination, updateReferences: true });
    plan.findings.push({
      kind: "archive",
      title: `Archive ${note.note.path}`,
      explanation: item.explanation,
      evidence,
    });
  }
  if (!plan.changes.length)
    plan.reason =
      output.abstention ??
      "The eligible notes retain useful or unresolved material; no archive is justified.";
}
