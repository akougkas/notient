import type { BriefResult } from "./brief";
import type { SourceReference } from "./schema";
export const briefLabels = {
  claim: "Key point",
  decision: "Recorded decision",
  question: "Question raised",
  tension: "Competing claims",
} as const;
export function briefMarkdown(result: BriefResult): string {
  const lines = [
    `## ${result.topic}`,
    result.summary?.text ?? result.reason ?? "Insufficient evidence.",
  ];
  const evidence = (sources: SourceReference[]) =>
    sources
      .map(
        (source) =>
          `[${source.path.replaceAll("[", "\\[").replaceAll("]", "\\]")}](${source.path.split("/").map(encodeURIComponent).join("/")}) · lines ${source.range.startLine}–${source.range.endLine}\n\n${source.quote
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n")}`,
      )
      .join("\n\n");
  if (result.summary) lines.push(evidence(result.summary.evidence));
  for (const finding of result.findings)
    lines.push(
      `### ${briefLabels[finding.kind]}\n\n${finding.text}\n\n${evidence(finding.evidence)}`,
    );
  if (result.coverage.state !== "current")
    lines.push(`**Retrieval coverage:** ${result.coverage.message ?? "Incomplete index."}`);
  if (result.limitations.length)
    lines.push(
      `### Limits of this brief\n\n${result.limitations.map((text) => `- ${text}`).join("\n")}`,
    );
  return lines.join("\n\n");
}
