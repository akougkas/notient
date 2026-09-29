import type { CultivationDigest } from "../../api/cultivation";

type Condition = CultivationDigest["conditions"][number];
type Quiet = CultivationDigest["quiet"][number];

export type ConditionRoute = "review" | "settings" | null;

const STOPPING_CONDITIONS = new Set(["paused", "no-trigger", "no-save-trigger"]);

export function conditionRoute(condition: Condition): ConditionRoute {
  if (condition.id === "pending-review") return "review";
  return condition.action ? "settings" : null;
}

export function conditionLine(condition: Condition): string {
  const route = conditionRoute(condition);
  const hint = route === "review" ? " [v reviews]" : route === "settings" ? " [s settings]" : "";
  return `${condition.label}. ${condition.detail}${condition.action ? ` ${condition.action}` : ""}${hint}`;
}

export function emptyDevelopments(digest: CultivationDigest): string {
  if (digest.conditions.some((condition) => STOPPING_CONDITIONS.has(condition.id)))
    return "Nothing has been studied in the background, and that is not the same as nothing worth finding. See what prevents cultivation above.";
  if (digest.conditions.some((condition) => condition.id === "pending-review"))
    return "No new developments beyond the changes waiting for your review.";
  if (digest.quiet.length)
    return "Nothing new worth surfacing. Recent runs studied notes and found nothing they were allowed to write or could support.";
  return "Nothing new worth surfacing. No cultivation run has finished recently for notes in scope.";
}

export function quietLine(entry: Quiet, pipelineTitle: string): string {
  const notes = entry.origin.examined.length ? entry.origin.examined.join(", ") : "no notes";
  const outcome = entry.outcome === "failed" ? "Could not finish" : "Studied, nothing to write";
  return `${outcome} · ${pipelineTitle} after ${entry.origin.trigger} · ${notes} · ${new Date(entry.updatedAt).toLocaleString()}\n${entry.reason}`;
}

export function originLine(origin: NonNullable<CultivationDigest["items"][number]["origin"]>): string {
  const notes = origin.examined.length ? origin.examined.join(", ") : "no notes";
  return `Started by ${origin.trigger}; examined ${notes}.`;
}
