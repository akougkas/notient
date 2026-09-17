import { operationInputs } from "../../../api/operations";
import { createRpc } from "../rpc";
import { formatError } from "./rpc";
import type { SlashContext, SlashOutcome } from "./types";

export async function listPipelines(context: SlashContext): Promise<SlashOutcome> {
  try {
    const result = await createRpc(context.client).pipelines();
    return {
      message: [
        `Pipeline policy revision: ${result.revision} · background ${result.paused ? "paused" : "enabled per policy"}`,
        ...result.pipelines.map(
          (entry) =>
            `${entry.id} · ${entry.title} · ${entry.policy.mode}\n  ${entry.description}\n  Background: ${entry.policy.enabled ? "enabled" : "disabled"} · ${entry.schedule.reason}\n  Budget: ${entry.policy.budget.notes} notes, ${entry.policy.budget.modelCalls} model calls, ${entry.policy.budget.tokens} tokens\n  Effects: ${entry.policy.effects.join(", ") || "none"}; destinations: notes=${entry.policy.destinations.notes}, archive=${entry.policy.destinations.archive}`,
        ),
        'Start explicitly: /pipeline {"pipeline":"enrich","sources":[{"path":"Note.md","revision":"<sha256>"}],"preview":true,"idempotencyKey":"run-1"}',
      ].join("\n"),
    };
  } catch (error) {
    return { message: `pipelines error: ${formatError(error)}` };
  }
}

export async function runPipeline(context: SlashContext, rest: string): Promise<SlashOutcome> {
  try {
    const input = operationInputs["pipelines.run"].parse(JSON.parse(rest));
    const { job } = await createRpc(context.client).runPipeline(input);
    return {
      message: `${job.pipeline} job ${job.id}: ${job.state}.\nUse /job ${job.id} for results and controls.\n${job.preview ? "Preview: no authored-note effects; derived indexes and previews may persist." : `Recorded policy: ${job.policy.mode}; allowed effects: ${job.policy.effects.join(", ") || "none"}.`}`,
    };
  } catch (error) {
    return { message: `pipeline error: ${formatError(error)}` };
  }
}
