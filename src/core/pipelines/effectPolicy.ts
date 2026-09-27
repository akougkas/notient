import type { BackgroundSettings } from "../../api/background";
import type { PipelinePolicy } from "../../api/operations";
import type { ChangePreview, PreviewEffect } from "../../api/changes";
import { inspectMarkdown } from "../../api/notes";
import type { PipelineJob } from "../../api/pipelines";
import { NoteApiError } from "../../api/schema";
import { insideFolder, scopeAllows } from "../../api/scope";

export function assertPipelinePolicy(job: PipelineJob, current: BackgroundSettings): void {
  if (!pipelinePolicyAllows(job.policy, current.pipelines[job.pipeline]))
    throw new NoteApiError(
      "FORBIDDEN",
      "pipeline configuration changed; run again under the current policy",
    );
  if (job.background && (current.paused || !current.pipelines[job.pipeline].enabled))
    throw new NoteApiError("FORBIDDEN", "background permission was revoked");
}

export function pipelinePolicyAllows(effective: PipelinePolicy, current: PipelinePolicy): boolean {
  if (
    JSON.stringify({ ...effective, budget: null }) !==
    JSON.stringify({ ...current, budget: null })
  )
    return false;
  return (Object.keys(current.budget) as Array<keyof PipelinePolicy["budget"]>).every((key) => {
    const allowed = effective.budget[key];
    const maximum = current.budget[key];
    if (!Number.isSafeInteger(allowed) || !Number.isSafeInteger(maximum)) return false;
    return key === "priority" ? allowed === maximum : allowed <= maximum;
  });
}

export function enforceEffectPolicy(
  job: PipelineJob,
  preview: ChangePreview,
  effect: PreviewEffect,
): void {
  const policy = job.policy;
  if (
    job.preview ||
    !job.caller.scopes.includes("write") ||
    policy.mode !== "apply" ||
    !policy.effects.includes(effect.category)
  )
    throw new NoteApiError(
      "PENDING_APPROVAL",
      `This policy requires review before ${effect.category} effects.`,
    );
  const tags = inspectMarkdown(effect.before ?? effect.after).tags;
  if (
    !scopeAllows(policy.writeScope, effect.path, tags) ||
    (effect.before !== null && !scopeAllows(policy.readScope, effect.path, tags))
  )
    throw new NoteApiError("FORBIDDEN", "effect path is outside the policy's effective scope");
  if (effect.destination && !scopeAllows(policy.writeScope, effect.destination, tags))
    throw new NoteApiError("FORBIDDEN", "destination is outside the policy's write scope");
  if (effect.category === "create" && !insideFolder(effect.path, policy.destinations.notes))
    throw new NoteApiError("FORBIDDEN", "new note is outside the configured destination");
  if (
    effect.category === "archive" &&
    effect.destination &&
    !insideFolder(effect.destination, policy.destinations.archive)
  )
    throw new NoteApiError("FORBIDDEN", "archive destination is outside the configured folder");
  if (effect.category === "body") {
    if (effect.before === null || !effect.after.startsWith(effect.before))
      throw new NoteApiError("PENDING_APPROVAL", "Replacing authored content requires review.");
    const addition = effect.after.slice(effect.before.length);
    const structure = inspectMarkdown(addition);
    const first = structure.headings[0];
    const savedHeadings = inspectMarkdown(effect.after).headings;
    if (
      !first ||
      first.level !== 2 ||
      addition.slice(0, first.range.start).trim() ||
      !savedHeadings.some(
        (heading) => heading.range.start === effect.before!.length + first.range.start,
      ) ||
      !policy.allowedSections.includes(first.text) ||
      structure.headings.some(
        (heading) => heading.level === 1 || (heading.level === 2 && !policy.allowedSections.includes(heading.text)),
      )
    )
      throw new NoteApiError("PENDING_APPROVAL", "Body enrichment must stay in designated sections.");
  }
  if (effect.category === "relationships" && !policy.allowedSections.includes("Notient understanding"))
    throw new NoteApiError("PENDING_APPROVAL", "Designate the relationship intelligence section or review this change.");
  for (const change of preview.changeSet.changes) {
    if (!("source" in change) || change.source.path !== effect.path) continue;
    if (
      effect.category === "properties" &&
      change.kind === "properties" &&
      Object.keys(change.patch).some((key) => !policy.allowedProperties.includes(key))
    )
      throw new NoteApiError("FORBIDDEN", "property is not allowed by this policy");
    if (
      effect.category === "body" &&
      change.kind === "append" &&
      !policy.allowedSections.some(
        (section) =>
          change.text.trimStart().startsWith(`## ${section}\n`) ||
          change.text.trimStart().startsWith(`## ${section}\r\n`),
      )
    )
      throw new NoteApiError("FORBIDDEN", "body effect is outside configured sections");
  }
}
