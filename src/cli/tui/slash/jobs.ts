import { operationInputs } from "../../../api/operations";
import { createRpc } from "../rpc";
import { formatError } from "./rpc";
import type { SlashContext, SlashOutcome } from "./types";

export async function listJobs(context: SlashContext, cursor: string): Promise<SlashOutcome> {
  try {
    const page = await createRpc(context.client).jobs(cursor || undefined);
    const lines = page.jobs.map(
      (job) =>
        `${job.id} · ${job.pipeline} · ${job.state} · ${job.progress.completed}/${job.progress.total} · ${job.stage}${job.failure ? `\n  ${job.failure.code}: ${job.failure.message}` : ""}`,
    );
    return {
      message: [
        ...(lines.length ? lines : ["No pipeline jobs recorded."]),
        ...(page.nextCursor ? [`Next page: /jobs ${page.nextCursor}`] : []),
      ].join("\n"),
    };
  } catch (error) {
    return { message: `jobs error: ${formatError(error)}` };
  }
}

export async function inspectJob(context: SlashContext, rest: string): Promise<SlashOutcome> {
  const [id, action, revision, idempotencyKey, extra] = rest.trim().split(/\s+/);
  if (!id) return { message: "/job needs a job id from /jobs" };
  try {
    if (action) {
      if (extra)
        return { message: "/job <id> <pause|resume|cancel|retry> <revision> <idempotency-key>" };
      const request = operationInputs["jobs.control"].parse({
        id,
        action,
        revision,
        idempotencyKey,
      });
      const { job } = await createRpc(context.client).controlJob(request);
      return {
        message: `${action} accepted: ${job.state}.\nControl receipt revision: ${job.revision}\nUse /job ${id} for current progress and any committed effects. Retry a lost reply with the exact same command and key.`,
      };
    }
    const { job } = await createRpc(context.client).job(id);
    return {
      message: [
        `${job.pipeline} · ${job.state} · ${job.id}`,
        `Revision: ${job.revision}`,
        `Reason: ${job.reason}`,
        `Stage: ${job.stage} · ${job.progress.completed}/${job.progress.total}`,
        `Attempts: ${job.runAttempts} · model calls: ${job.attempts.length} · charged tokens: ${job.attempts.reduce((sum, attempt) => sum + attempt.chargedTokens, 0)} (see API accounting for measured/reserved breakdown)`,
        ...(job.failure ? [`${job.failure.code}: ${job.failure.message}`] : []),
        ...(job.plan
          ? [
              job.plan.summary,
              ...job.plan.findings
                .slice(0, 10)
                .map((finding) => `${finding.title}: ${finding.explanation}`),
            ]
          : []),
        `Proposals: ${job.proposalIds.join(", ") || "none"}`,
        `Effects: ${job.effects?.state ?? "none applied"}`,
      ].join("\n"),
    };
  } catch (error) {
    return { message: `job error: ${formatError(error)}` };
  }
}
