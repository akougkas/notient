import type { CultivationDigest } from "../../api/cultivation";

type Condition = CultivationDigest["conditions"][number];
type Quiet = CultivationDigest["quiet"][number];

export type ConditionRoute = "review" | "settings" | null;

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
  const has = (id: string) => digest.conditions.some((condition) => condition.id === id);
  const scheduling = has("paused")
    ? "Background cultivation is paused, so no new notes are being studied."
    : has("no-trigger")
      ? "No workflow is set to run, so no new notes will be studied."
      : has("no-save-trigger")
        ? "New saves wait for an idle or interval run."
        : has("pending-review")
          ? "Changes are waiting for your review."
          : "";
  const history = digest.quiet.length
    ? "Earlier runs are listed below."
    : "No run has finished recently for notes in scope.";
  return ["Nothing new to surface.", scheduling, history].filter(Boolean).join(" ");
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
