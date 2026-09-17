import type { ComparisonResult, NoteComparison } from "./comparison";
export const comparisonLabels: Record<NoteComparison["judgment"], string> = {
  supports: "Supports",
  extends: "Develops",
  exemplifies: "Example",
  related_to: "Connection",
  contradiction: "Conflicting claims",
  "temporal-change": "Change over time",
  "different-assumptions": "Different assumptions",
  unrelated: "No useful relationship",
  insufficient: "Insufficient evidence",
};
const link = (path: string) =>
  `[${path.replaceAll("[", "\\[").replaceAll("]", "\\]")}](${path.split("/").map(encodeURIComponent).join("/")})`;
export function comparisonMarkdown(result: ComparisonResult): string {
  const lines = [
    result.abstained
      ? `## What the evidence leaves open\n\n${result.reason}`
      : "## What these notes tell us together",
  ];
  if (result.coverage?.state !== undefined && result.coverage.state !== "current")
    lines.push(`**Retrieval coverage:** ${result.coverage.message ?? "Incomplete index."}`);
  for (const item of result.comparisons) {
    lines.push(
      `### ${comparisonLabels[item.judgment]}\n\n${link(item.source.path)} → ${link(item.target.path)}\n\n${item.explanation}`,
    );
    for (const evidence of item.evidence)
      lines.push(
        `${link(evidence.path)} · lines ${evidence.range.startLine}–${evidence.range.endLine}\n\n${evidence.quote
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}`,
      );
  }
  if (result.limitations.length)
    lines.push(
      `### Limits of this comparison\n\n${result.limitations.map((text) => `- ${text}`).join("\n")}`,
    );
  return lines.join("\n\n");
}
