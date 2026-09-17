import { z } from "zod";
import type { PipelinePlan } from "../../api/pipelines";
import { insideFolder } from "../../api/scope";
import { noteFilename } from "../vault/noteFilename";
import { type PipelineContext, witnessSchema } from "./context";
import { enrichNotes } from "./enrich";
import { relateNotes } from "./relate";
import { synthesizeNotes } from "./synthesize";

const schema = z
  .object({
    items: z
      .array(
        z
          .object({
            note: z.number().int().nonnegative(),
            category: z.enum(["reference", "project", "idea", "meeting", "task", "unclassified"]),
            decision: z.enum(["organize", "retain-inbox", "needs-information"]),
            title: z.string().max(160),
            explanation: z.string().min(1).max(3000),
            evidence: z.array(witnessSchema).min(1).max(6),
          })
          .strict(),
      )
      .max(24),
    abstention: z.string().nullable(),
  })
  .strict();
export async function processInbox(context: PipelineContext, plan: PipelinePlan): Promise<void> {
  const inbox = context.options.policy.destinations.inbox;
  if (context.selected.some((note) => !insideFolder(note.note.path, inbox)))
    throw new Error("inbox processing requires sources inside the configured inbox");
  const selected = [...context.selected];
  const { processedProperty, processedValue } = context.options.policy.parameters.inbox;
  const pending = selected.filter(
    (note) => note.structure.frontmatter.properties?.[processedProperty] !== processedValue,
  );
  if (!pending.length) {
    plan.reason = `Selected inbox notes are already marked ${processedProperty}: ${processedValue}.`;
    return;
  }
  context.selected.splice(0, context.selected.length, ...pending);
  const output = await context.model(
    "classify_inbox",
    "Classify selected inbox notes by their actual content. Organize only substantive notes with a clear topic and usable destination title. Keep empty notes, raw ambiguous fragments and unresolved requests in the inbox. Cite exact evidence and explain the category and routing decision. The category is descriptive; it grants no permission.",
    schema,
  );
  const organized = new Map<number, z.infer<typeof schema>["items"][number]>();
  for (const item of output.items) {
    const note = context.documents[item.note];
    if (!pending.includes(note)) throw new Error("inbox classification selected an invalid source");
    const evidence = item.evidence.map((witness) => context.evidence(witness));
    if (evidence.some((entry) => entry.path !== note.note.path))
      throw new Error("classification must cite its own source");
    plan.findings.push({
      kind: "inbox",
      title: `${item.category}: ${note.note.path}`,
      explanation: item.explanation,
      evidence,
    });
    if (item.decision === "organize" && item.category !== "unclassified")
      organized.set(item.note, item);
  }
  if (!organized.size) {
    plan.reason =
      output.abstention ?? "Inbox items need more information or should remain in place.";
    context.selected.splice(0, context.selected.length, ...selected);
    return;
  }
  context.selected.splice(
    0,
    context.selected.length,
    ...[...organized.keys()].map((index) => context.documents[index]),
  );
  await enrichNotes(context, plan);
  await relateNotes(context, plan);
  if (context.options.policy.parameters.inbox.createDerivedNotes && context.documents.length > 1)
    await synthesizeNotes(context, plan);
  const markers: PipelinePlan["changes"] = [];
  const mark = context.options.policy.allowedProperties.includes(processedProperty);
  for (const [index, item] of organized) {
    const note = context.documents[index];
    const destination = [context.options.policy.destinations.notes, noteFilename(item.title)]
      .filter(Boolean)
      .join("/");
    const moves = destination !== note.note.path;
    if (moves)
      plan.changes.push({ kind: "move", source: note.note, destination, updateReferences: true });
    if (mark)
      markers.push({
        kind: "properties",
        source: { path: moves ? destination : note.note.path, revision: note.note.revision },
        patch: { [processedProperty]: processedValue },
      });
  }
  // The marker is each item's final effect, on its final path. Effects apply
  // in order and stop at the first failure, so a note is never marked
  // processed while its enrichment, relationship or move is pending or failed.
  plan.changes.push(...markers);
  context.selected.splice(0, context.selected.length, ...selected);
}
