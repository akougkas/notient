import { type PipelineId, type PipelinePolicy, folderSchema } from "../../api/operations";
import { scopeAllows } from "../../api/scope";

export const CAPTURE_WORKFLOWS: readonly PipelineId[] = ["enrich", "relate", "contradictions", "inbox"];
export const DRAFT_WORKFLOWS: readonly PipelineId[] = ["enrich"];
const DEFAULT_SECTION = "Notient understanding";

interface CatalogEntry {
  id: PipelineId;
  title: string;
  policy: PipelinePolicy;
  schedule: { lastRun: number | null; nextRun: number | null; reason: string };
}

const seconds = (ms: number) => (ms % 60000 === 0 ? `${ms / 60000} min` : `${ms / 1000} s`);

export function actualCaptureFolder(entries: readonly CatalogEntry[]): string {
  return entries.find((entry) => entry.id === "inbox")?.policy.destinations.inbox ?? "Inbox";
}

function sampleCapturePath(folder: string): string {
  return `${folder ? `${folder}/` : ""}Thought.md`;
}

function folderLabel(folder: string): string {
  return folder || "the vault root";
}

function unbounded(scope: PipelinePolicy["readScope"]): boolean {
  return !scope.folders.length && !scope.paths.length && !scope.tags.length;
}

function sectionName(policy: PipelinePolicy): string {
  return policy.allowedSections[0] ?? DEFAULT_SECTION;
}

function resultText(id: PipelineId, policy: PipelinePolicy): string {
  if (policy.mode === "apply")
    return `Only ${policy.effects.join(", ") || "no"} effects apply without review; anything else waits for review.`;
  if (id !== "enrich")
    return "Whatever it proposes is a review, nothing is written until you approve it, and a capture with nothing to propose produces no review. What it can propose depends on the workflow.";
  return `A supported finding is proposed under a "## ${sectionName(policy)}" section at the end of the capture note (added to that section when it is already the last one), nothing is written until you approve it, and a capture with nothing supportable produces no review.`;
}

function scopeText(scope: PipelinePolicy["readScope"]): string {
  const parts = [
    scope.folders.length ? `folders ${scope.folders.join(", ")}` : "",
    scope.paths.length ? `${scope.paths.length} exact note${scope.paths.length === 1 ? "" : "s"}` : "",
    scope.tags.length ? `tags ${scope.tags.join(", ")}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : "any eligible note";
}

export function captureBlockers(entry: CatalogEntry, paused: boolean, folder: string): string[] {
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
  if (unbounded(policy.readScope))
    blockers.push(
      "Its read scope is unbounded (any eligible note), so it is not a safely scoped capture workflow.",
    );
  else if (!scopeAllows(policy.readScope, sampleCapturePath(folder), []))
    blockers.push(
      `Its read scope (${scopeText(policy.readScope)}) does not include the capture folder (${folderLabel(folder)}), so new captures would not be read.`,
    );
  if (entry.id === "enrich" && !policy.allowedSections.length)
    blockers.push(
      "No designated intelligence section is set, so retained understanding cannot be checked against one.",
    );
  if (policy.mode === "report") blockers.push("Report mode may study the capture, but it creates no review or note change.");
  if (policy.enabled && (!policy.budget.modelCalls || !policy.budget.tokens))
    blockers.push("Its model-call or token budget is zero, so model-assisted results are unavailable.");
  return blockers;
}

export function captureRowSummary(entry: CatalogEntry, paused: boolean, folder: string): string {
  const { policy } = entry;
  if (!policy.enabled) return "off";
  const reactsToSave = policy.triggers.includes("save");
  const blocked = captureBlockers(entry, paused, folder).length > 0;
  const trigger = policy.triggers.length ? policy.triggers.join("+") : "no trigger";
  const mode = policy.mode === "propose" ? "review" : policy.mode;
  const flag = unbounded(policy.readScope) ? " · broad scope" : reactsToSave && blocked ? " (blocked)" : "";
  return `on · ${trigger}${flag} · ${mode}`;
}

export function captureExplanation(
  entries: readonly CatalogEntry[],
  selected: CatalogEntry | undefined,
  paused: boolean,
  folder: string,
): string {
  const candidates = entries.filter((entry) => CAPTURE_WORKFLOWS.includes(entry.id));
  const active = candidates.filter((entry) => captureBlockers(entry, paused, folder).length === 0);
  if (selected && CAPTURE_WORKFLOWS.includes(selected.id)) {
    const blockers = captureBlockers(selected, paused, folder);
    if (!blockers.length) {
      const { policy } = selected;
      return `A capture saved in ${folderLabel(folder)} (set by Process inbox) can be studied after ${seconds(policy.debounceMs)}, at most once per ${seconds(policy.cooldownMs)}, reading only ${scopeText(policy.readScope)}. ${resultText(selected.id, policy)} Now: ${selected.schedule.reason || "waiting for a save"}`;
    }
    return `A new capture may not yield a reviewable development from ${selected.title}. ${blockers.join(" ")} ${DRAFT_WORKFLOWS.includes(selected.id) ? "Press s for a folder-scoped, review-only draft; nothing changes until you review and save." : "Edit it with Enter; nothing changes until you review and save."}`;
  }
  if (active.length)
    return `New captures can be studied by ${active.map((entry) => entry.title).join(", ")}. What each one proposes differs, and a capture with nothing to propose produces no review. Select a workflow for timing, scope and review behavior.`;
  return "No workflow is ready to produce a reviewable development from a new capture. Captures are still saved and searchable. Select Enrich notes and press s to prepare a narrow, review-only draft; nothing is enabled until you review and save it.";
}

export function captureDraft(
  policy: PipelinePolicy,
  folder: string,
): { policy: PipelinePolicy; folder: string } | null {
  if (!folder || !folderSchema.safeParse(folder).success) return null;
  const next = structuredClone(policy);
  next.enabled = true;
  if (!next.triggers.includes("save")) next.triggers = [...next.triggers, "save"];
  next.mode = "propose";
  if (!next.allowedSections.length) next.allowedSections = [DEFAULT_SECTION];
  next.readScope = { ...next.readScope, paths: [], folders: [folder], tags: [] };
  next.writeScope = { ...next.writeScope, paths: [], folders: [folder], tags: [] };
  return { policy: next, folder };
}

export function activationConsequence(
  id: PipelineId,
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
      : id === "enrich"
        ? `Results arrive as reviews and the effects list (${after.effects.join(", ") || "empty"}) is not used in review mode. Retained understanding is proposed under a "## ${sectionName(after)}" section at the end of the note (added to that section when it is already the last one), so existing text is kept and only appended to. Nothing is written until you approve it.`
        : `Results arrive as reviews and the effects list (${after.effects.join(", ") || "empty"}) is not used in review mode. Nothing is written until you approve it; what this workflow proposes is described in its own help.`,
  ];
  if (id === "enrich" && after.allowedProperties.length)
    lines.push(
      `A review may also propose frontmatter properties limited to: ${after.allowedProperties.join(", ")}. Remove any you do not want under Details before saving.`,
    );
  if (after.readScope.folders.length + after.readScope.paths.length + after.readScope.tags.length === 0)
    lines.push("Warning: the read scope covers every eligible note.");
  return lines;
}
