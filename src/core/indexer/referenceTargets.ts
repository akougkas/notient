import { z } from "zod";
import { resolveMarkdownTarget, resolveTargets } from "../markdown/resolver";
import type { MarkdownExtraction } from "../markdown/types";

const targetSchema = z.strictObject({
  raw: z.string(),
  syntax: z.enum(["wiki", "markdown"]),
  resolved: z.string().nullable(),
});
export const referenceTargetsSchema = z.array(targetSchema);
export type ReferenceTarget = z.infer<typeof targetSchema>;

/** Derived receipts retain unresolved property links as well as resolved edges.
 * A destination's identity can change without any edit to its source Markdown. */
export function referenceTargets(
  path: string,
  extraction: MarkdownExtraction,
  vaultPaths: string[],
): ReferenceTarget[] {
  const targets: ReferenceTarget[] = [
    ...extraction.links.map((link) => ({
      raw: link.rawTarget,
      syntax: link.syntax === "markdown" ? ("markdown" as const) : ("wiki" as const),
      resolved: null,
    })),
    ...extraction.frontmatterRefs.map((ref) => ({
      raw: ref.rawTarget,
      syntax: "wiki" as const,
      resolved: null,
    })),
  ];
  return targets.map((target) => ({
    ...target,
    resolved: resolveReferenceTarget(path, target, vaultPaths),
  }));
}

export function resolveReferenceTarget(
  path: string,
  target: ReferenceTarget,
  vaultPaths: string[],
): string | null {
  return target.syntax === "markdown"
    ? resolveMarkdownTarget(path, target.raw, vaultPaths)
    : resolveTargets(
        path,
        [{ rawTarget: target.raw, targetHeading: null, targetBlockId: null }],
        vaultPaths,
      )[0].targetPath;
}
