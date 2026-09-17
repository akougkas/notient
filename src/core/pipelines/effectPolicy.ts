import type { BackgroundSettings } from "../../api/background";
import type { ChangePreview, PreviewEffect } from "../../api/changes";
import { inspectMarkdown } from "../../api/notes";
import type { PipelineJob } from "../../api/pipelines";
import { NoteApiError } from "../../api/schema";
import { insideFolder, scopeAllows } from "../../api/scope";

export function assertPipelinePolicy(job: PipelineJob, current: BackgroundSettings): void {
  if (JSON.stringify(current.pipelines[job.pipeline]) !== JSON.stringify(job.policy))
    throw new NoteApiError(
      "FORBIDDEN",
      "pipeline configuration changed; run again under the current policy",
    );
  if (job.background && (current.paused || !current.pipelines[job.pipeline].enabled))
    throw new NoteApiError("FORBIDDEN", "background permission was revoked");
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
