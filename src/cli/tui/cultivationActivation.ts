import type { PipelineId, PipelinePolicy } from "../../api/operations";
import { scopeAllows } from "../../api/scope";

export const CAPTURE_WORKFLOWS: readonly PipelineId[] = ["enrich", "relate", "contradictions", "inbox"];

interface CatalogEntry {
  id: PipelineId;
  title: string;
  policy: PipelinePolicy;
  schedule: { lastRun: number | null; nextRun: number | null; reason: string };
}

const seconds = (ms: number) => (ms % 60000 === 0 ? `${ms / 60000} min` : `${ms / 1000} s`);

function captureFolder(policy: PipelinePolicy): string {
  return policy.destinations.inbox;
}

function sampleCapturePath(policy: PipelinePolicy): string {
  const folder = captureFolder(policy);
  return `${folder ? `${folder}/` : ""}Thought.md`;
}

function scopeText(scope: PipelinePolicy["readScope"]): string {
  const parts = [
    scope.folders.length ? `folders ${scope.folders.join(", ")}` : "",
    scope.paths.length ? `${scope.paths.length} exact note${scope.paths.length === 1 ? "" : "s"}` : "",
    scope.tags.length ? `tags ${scope.tags.join(", ")}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : "any eligible note";
}

export function captureBlockers(entry: CatalogEntry, paused: boolean): string[] {
  const { policy } = entry;
  const blockers: string[] = [];
  if (paused) blockers.push("All background work is paused (press p to resume).");
  if (!policy.enabled) blockers.push("Background work is off for this workflow.");
  if (!policy.triggers.includes("save")) {
    blockers.push(
      policy.triggers.length
        ? `It runs after ${policy.triggers.join(" and ")}, not after a save, so a fresh capture waits for that.`
        : "It has no trigger, so nothing starts it.",
    );
  }
  if (!scopeAllows(policy.readScope, sampleCapturePath(policy), []))
    blockers.push(`Its read scope (${scopeText(policy.readScope)}) does not include ${captureFolder(policy) || "the vault root"}, where captures are saved.`);
  if (policy.mode === "report") blockers.push("It is in report mode, so findings never become reviews or note changes.");
  if (policy.enabled && (!policy.budget.modelCalls || !policy.budget.tokens))
    blockers.push("Its model-call or token budget is zero, so it cannot produce a model result.");
  return blockers;
}

export function captureRowSummary(entry: CatalogEntry, paused: boolean): string {
  const { policy } = entry;
  if (!policy.enabled) return "off";
  const reactsToSave = policy.triggers.includes("save");
  const blocked = captureBlockers(entry, paused).length > 0;
  const trigger = policy.triggers.length ? policy.triggers.join("+") : "no trigger";
  const mode = policy.mode === "propose" ? "review" : policy.mode;
  return `on · ${trigger}${reactsToSave && blocked ? " (blocked)" : ""} · ${mode}`;
}

export function captureExplanation(
  entries: readonly CatalogEntry[],
  selected: CatalogEntry | undefined,
  paused: boolean,
): string {
  const candidates = entries.filter((entry) => CAPTURE_WORKFLOWS.includes(entry.id));
  const active = candidates.filter((entry) => captureBlockers(entry, paused).length === 0);
  if (selected && CAPTURE_WORKFLOWS.includes(selected.id)) {
    const blockers = captureBlockers(selected, paused);
    if (!blockers.length) {
      const { policy } = selected;
      return `A capture saved to ${captureFolder(policy) || "the vault root"} is studied by ${selected.title} ${seconds(policy.debounceMs)} after saving, at most once per ${seconds(policy.cooldownMs)}. Results are ${policy.mode === "apply" ? "applied within the allowed effects" : "reviews"}. Now: ${selected.schedule.reason || "waiting for a save"}`;
    }
    return `A new capture will not start ${selected.title}. ${blockers.join(" ")} Press s to prepare a safe draft; nothing changes until you review and save it.`;
  }
  if (active.length)
    return `New captures are studied by ${active.map((entry) => entry.title).join(", ")}. Select a workflow to see timing, scope and review behavior.`;
  return "No workflow will study a new capture. Captures are still saved and searchable. Select Enrich notes and press s to prepare a narrow, review-only draft; nothing is enabled until you review and save it.";
}

export function captureDraft(policy: PipelinePolicy): PipelinePolicy {
  const next = structuredClone(policy);
  const folder = captureFolder(next);
  const inScope = (scope: PipelinePolicy["readScope"]) =>
    scope.folders.length > 0 || scope.paths.length > 0 || scope.tags.length > 0;
  next.enabled = true;
  if (!next.triggers.includes("save")) next.triggers = [...next.triggers, "save"];
  if (next.mode !== "propose") next.mode = "propose";
  if (!inScope(next.readScope)) next.readScope = { ...next.readScope, folders: [folder] };
  if (!inScope(next.writeScope)) next.writeScope = { ...next.writeScope, folders: [folder] };
  return next;
}

export function activationConsequence(
  title: string,
  before: PipelinePolicy,
  after: PipelinePolicy,
): string[] {
  const becomesActive =
    after.enabled &&
    after.triggers.length > 0 &&
    (!before.enabled || before.triggers.join() !== after.triggers.join());
  if (!becomesActive) return [];
  const lines = [
    `After saving, ${title} may call the model in the background after ${after.triggers.join(", ")}. Saved notes in ${scopeText(after.readScope)} can be read; writes are limited to ${scopeText(after.writeScope)}.`,
    `Each run is bounded to ${after.budget.notes} notes, ${after.budget.modelCalls} model calls and ${after.budget.tokens} tokens, and the daily cultivation budget still applies.`,
    after.mode === "apply"
      ? `Apply mode writes ${after.effects.join(", ") || "nothing"} without asking. Authored prose changes still require review.`
      : "Results arrive as reviews. Nothing is written to a note until you approve it.",
  ];
  if (after.readScope.folders.length + after.readScope.paths.length + after.readScope.tags.length === 0)
    lines.push("Warning: the read scope covers every eligible note.");
  return lines;
}
