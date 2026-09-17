import { z } from "zod";
import { PIPELINES } from "../core/pipelines/definitions";
import { type PipelineId, type PipelinePolicy, pipelinePolicySchema } from "./operations";

export const policyValidationSchema = z.object({
  ok: z.literal(true),
  valid: z.boolean(),
  policy: pipelinePolicySchema,
  issues: z.array(
    z.object({ path: z.string(), severity: z.enum(["error", "warning"]), message: z.string() }),
  ),
});
export function pipelineEffects(
  pipeline: PipelineId,
): readonly PipelinePolicy["effects"][number][] {
  return PIPELINES[pipeline].effects;
}
/** Semantic checks shared by settings clients and the daemon. Warnings describe
 * real scope/budget consequences; they do not manufacture runtime permission. */
export function validatePipelinePolicy(pipeline: PipelineId, policy: PipelinePolicy) {
  const issues: z.infer<typeof policyValidationSchema>["issues"] = [];
  const add = (path: string, severity: "error" | "warning", message: string) =>
    issues.push({ path, severity, message });
  if (policy.enabled && !policy.triggers.length)
    add("triggers", "error", "Choose at least one trigger before enabling background work.");
  if (new Set(policy.triggers).size !== policy.triggers.length)
    add("triggers", "error", "Each trigger may appear only once.");
  if (policy.effects.some((effect) => !pipelineEffects(pipeline).includes(effect)))
    add("effects", "error", "An allowed effect is not supported by this workflow.");
  if (policy.mode === "apply" && pipeline !== "index-extract" && !policy.effects.length)
    add(
      "effects",
      "error",
      "Automatic application requires explicit allowed effects. Choose Review for human decisions.",
    );
  if (
    !policy.readScope.paths.length &&
    !policy.readScope.folders.length &&
    !policy.readScope.tags.length
  )
    add(
      "readScope",
      "warning",
      "Reads can cover every eligible note outside exclusions, within the run budget.",
    );
  if (
    policy.mode === "apply" &&
    !policy.writeScope.paths.length &&
    !policy.writeScope.folders.length &&
    !policy.writeScope.tags.length
  )
    add(
      "writeScope",
      "warning",
      "Allowed effects can reach every ordinary note outside exclusions. Restrict the write scope for automatic work.",
    );
  if (policy.budget.tokens < policy.budget.generationTokens)
    add(
      "budget.tokens",
      "warning",
      "The total token budget is smaller than one generation ceiling; reasoning may be unable to start.",
    );
  if (policy.budget.generationTokens < 4096)
    add(
      "budget.generationTokens",
      "warning",
      "Reasoning models share this ceiling with the final answer; a small ceiling can produce incomplete output.",
    );
  if (pipeline !== "index-extract" && (!policy.budget.modelCalls || !policy.budget.tokens))
    add(
      "budget",
      "warning",
      "This workflow needs inference; a zero model-call or token budget prevents it from producing a model result.",
    );
  if (pipeline === "index-extract" && policy.mode === "apply")
    add(
      "mode",
      "warning",
      "Indexing updates derived data only; it does not edit authored Markdown.",
    );
  return policyValidationSchema.parse({
    ok: true,
    valid: !issues.some((issue) => issue.severity === "error"),
    policy,
    issues,
  });
}
