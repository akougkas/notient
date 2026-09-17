import { z } from "zod";
import type { PipelinePlan } from "../../api/pipelines";
import type { NoteReadResult } from "../../api/schema";
import { isTagName, tagIdentity } from "../markdown/tags";
import { type PipelineContext, witnessSchema } from "./context";

const aliasIdentity = (alias: string) => alias.normalize("NFC").trim().toLocaleLowerCase();

const schema = z
  .object({
    suggestions: z
      .array(
        z
          .object({
            note: z.number().int().nonnegative(),
            summary: z.string().max(2500),
            tags: z
              .array(
                z
                  .string()
                  .refine(isTagName, "must be one valid Obsidian tag name")
                  .describe(
                    "Obsidian tag without # or whitespace; separate words with hyphens or nested / segments.",
                  ),
              )
              .max(8),
            aliases: z.array(z.string().min(1).max(100)).max(5),
            reason: z.string().min(1).max(2000),
            evidence: z.array(witnessSchema).min(1).max(6),
          })
          .strict(),
      )
      .max(24),
    abstention: z.string().nullable(),
  })
  .strict();

export async function enrichNotes(context: PipelineContext, plan: PipelinePlan): Promise<void> {
  const output = await context.model(
    "enrich_notes",
    "For selected notes only, suggest a concise factual summary and a few retrieval-useful tags/aliases grounded in their actual topic. Tags must be valid Obsidian tags: no # prefix, spaces or punctuation other than hyphens, underscores and nested / segments; use file-reconciliation rather than file reconciliation. Aliases may contain spaces and must be alternative names for the note's subject, not invented facts. Skip generic tags, redundant summaries, empty/scaffold notes, private requests, and suggestions already represented in the note. Do not replace authored fields. Empty strings/lists mean no suggestion. Explain the reason for each suggestion.",
    schema,
  );
  const seen = new Set<number>();
  for (const item of output.suggestions) {
    const note = context.documents[item.note];
    if (!context.selected.includes(note) || seen.has(item.note))
      throw new Error("enrichment selected an invalid or repeated source");
    seen.add(item.note);
    const evidence = item.evidence.map((entry) => context.evidence(entry));
    if (evidence.some((entry) => entry.path !== note.note.path))
      throw new Error("enrichment evidence must belong to its source note");
    const patch = propertyPatch(note, item, context.options.policy.allowedProperties);
    if (Object.keys(patch).length) {
      plan.changes.push({ kind: "properties", source: note.note, patch });
      plan.findings.push({
        kind: "metadata",
        title: `Metadata for ${note.note.path}`,
        explanation: item.reason,
        evidence,
      });
    }
    const section = context.options.policy.allowedSections[0];
    if (
      item.summary &&
      section &&
      !note.structure.headings.some((heading) => heading.text === section)
    ) {
      const eol = note.body.includes("\r\n") ? "\r\n" : "\n";
      const text = `${eol}${eol}## ${section}${eol}${eol}${item.summary.replace(/\r?\n/g, eol)}${eol}`;
      plan.changes.push({ kind: "append", source: note.note, text });
      plan.findings.push({
        kind: "summary",
        title: `Summary for ${note.note.path}`,
        explanation: item.reason,
        evidence,
      });
    }
  }
  if (!plan.changes.length)
    plan.reason =
      output.abstention ??
      "No grounded enrichment would improve the selected notes without replacing authored material.";
}
function propertyPatch(
  note: NoteReadResult,
  item: z.infer<typeof schema>["suggestions"][number],
  allowed: string[],
): Record<string, string[]> {
  const patch: Record<string, string[]> = {};
  if (note.structure.frontmatter.error) return patch;
  const properties = note.structure.frontmatter.properties ?? {};
  for (const [key, singular, known, proposed, identity] of [
    ["tags", "tag", note.structure.tags, item.tags, tagIdentity],
    ["aliases", "alias", note.structure.aliases, item.aliases, aliasIdentity],
  ] as const) {
    // Extend the property the note already uses; never copy inline body tags
    // into properties or leave a parallel singular/plural pair.
    const property =
      properties[key] === undefined && properties[singular] !== undefined ? singular : key;
    if (!allowed.includes(key) || !allowed.includes(property)) continue;
    const values = extendedValues(properties[property], known, proposed, identity);
    if (values) patch[property] = values;
  }
  return patch;
}

/** Authored values followed by new suggestions, or null when nothing new applies. */
function extendedValues(
  current: unknown,
  known: readonly string[],
  proposed: readonly string[],
  identity: (value: string) => string,
): string[] | null {
  const authored =
    current === undefined || current === null
      ? []
      : typeof current === "string"
        ? [current]
        : Array.isArray(current) && current.every((entry) => typeof entry === "string")
          ? (current as string[])
          : null;
  if (authored === null) return null;
  const seen = new Set([...known, ...authored].map((value) => identity(value.replace(/^#/, ""))));
  const additions = proposed.filter((value) => {
    const normalized = identity(value);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
  return additions.length ? [...authored, ...additions] : null;
}
