import type { CultivationDigest } from "./cultivation";
import type { CultivationSettings } from "./cultivationSettings";

export function cultivationDigestMarkdown(digest: CultivationDigest): string {
  const lines = [
    "# Cultivation digest",
    "",
    `Generated ${new Date(digest.generatedAt).toLocaleString()} · background ${digest.paused ? "paused" : "active by policy"}`,
    `Daily budget: ${digest.budget.tokens.spent.toLocaleString()} / ${digest.budget.tokens.limit.toLocaleString()} tokens spent, ${digest.budget.tokens.reserved.toLocaleString()} reserved; ${digest.budget.modelCalls.spent} / ${digest.budget.modelCalls.limit} model calls spent, ${digest.budget.modelCalls.reserved} reserved.`,
    `Methodology: ${digest.methodology.mode === "custom" ? digest.methodology.name : digest.methodology.mode}`,
    "",
  ];
  if (digest.conditions.length) {
    lines.push("## Conditions", "");
    for (const condition of digest.conditions)
      lines.push(
        `- **${condition.label}.** ${condition.detail}${condition.action ? ` ${condition.action}` : ""}`,
      );
    lines.push("");
  }
  if (digest.items.length === 0) {
    lines.push("Nothing new worth surfacing: no current source-readable findings are available.");
    appendQuiet(lines, digest);
    return lines.join("\n").trimEnd();
  }
  for (const item of digest.items) {
    lines.push(
      `## ${item.title}`,
      "",
      `**${dispositionLabel(item.disposition)}** · ${statusLabel(item.status)} · ${item.path} · revision ${item.revision.slice(0, 12)}`,
      "",
      item.explanation,
      "",
    );
    if (item.origin)
      lines.push(
        `Origin: ${item.origin.trigger} trigger by ${item.origin.caller}; examined ${item.origin.examined.join(", ") || "no notes"}.`,
        "",
      );
    for (const qualification of item.qualifications)
      lines.push(`**Qualification:** ${qualification}`, "");
    for (const reason of item.reasons) lines.push(`- ${reason}`);
    if (item.reasons.length) lines.push("");
    for (const evidence of item.evidence) {
      lines.push(
        `**Source:** ${evidence.path} · lines ${evidence.range.startLine}–${evidence.range.endLine} · revision ${evidence.revision.slice(0, 12)}`,
        ...evidence.quote.split(/\r\n|\n|\r/u).map((line) => `> ${line}`),
        "",
      );
    }
  }
  appendQuiet(lines, digest);
  return lines.join("\n").trimEnd();
}

function appendQuiet(lines: string[], digest: CultivationDigest): void {
  if (!digest.quiet.length) return;
  lines.push("", "## Studied without writing", "");
  for (const entry of digest.quiet)
    lines.push(
      `- ${entry.outcome === "failed" ? "Failed" : "No write"} · ${entry.pipeline} · ${entry.origin.trigger} trigger · ${entry.origin.examined.join(", ") || "no notes"}: ${entry.reason}`,
    );
}

export function cultivationSettingsMarkdown(settings: CultivationSettings): string {
  const attention = settings.attention;
  const lines = [
    "# Cultivation settings",
    "",
    `Methodology: ${settings.methodology.mode === "custom" ? settings.methodology.name : settings.methodology.mode}`,
    `Daily limits: ${attention.dailyTokens.toLocaleString()} tokens and ${attention.dailyModelCalls} model calls.`,
    `Revisit notes after ${attention.revisitDays} days; show up to ${attention.digestItems} digest items.`,
    "",
  ];
  if (attention.priorities.length) {
    lines.push("## Explicit attention priorities", "");
    for (const entry of attention.priorities)
      lines.push(`- ${entry.path}: ${entry.priority > 0 ? "+" : ""}${entry.priority}`);
    lines.push("");
  }
  if (settings.methodology.conventions.trim()) {
    lines.push("## Configured conventions", "", settings.methodology.conventions.trim());
  }
  return lines.join("\n");
}

function dispositionLabel(disposition: CultivationDigest["items"][number]["disposition"]): string {
  switch (disposition) {
    case "applied":
      return "Applied";
    case "awaiting-review":
      return "Awaiting review";
    case "partial":
      return "Partially applied";
    case "report-only":
      return "Report only";
  }
}

function statusLabel(status: CultivationDigest["items"][number]["status"]): string {
  switch (status) {
    case "supported":
      return "Supported within cited scope";
    case "open":
      return "Open question";
    case "provisional":
      return "Provisional";
    case "disputed":
      return "Disputed";
    case "decided":
      return "Decided";
    case "retained":
      return "Retained";
    case "superseded":
      return "Superseded";
  }
}
