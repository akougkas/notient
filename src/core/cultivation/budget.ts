import type { AttentionSettings } from "../../api/cultivationSettings";
import type { PipelineJob } from "../../api/pipelines";
import { utcDayStart } from "./attention";

export interface CultivationBudgetStatus {
  tokens: { limit: number; spent: number; reserved: number; remaining: number };
  modelCalls: { limit: number; spent: number; reserved: number; remaining: number };
}

export function cultivationBudgetStatus(
  jobs: readonly PipelineJob[],
  settings: AttentionSettings,
  now: number,
): CultivationBudgetStatus {
  const today = utcDayStart(now);
  const relevant = jobs.filter(
    (job) => job.background && (job.createdAt >= today || job.updatedAt >= today),
  );
  const spentTokens = relevant.reduce(
    (total, job) => total + job.attempts.reduce((sum, attempt) => sum + attempt.chargedTokens, 0),
    0,
  );
  const spentCalls = relevant.reduce((total, job) => total + job.attempts.length, 0);
  const reservedTokens = relevant.reduce((total, job) => {
    const charged = job.attempts.reduce((sum, attempt) => sum + attempt.chargedTokens, 0);
    const executionFinished = ["completed", "awaiting-approval"].includes(job.state);
    return total + (executionFinished ? charged : Math.max(job.policy.budget.tokens, charged));
  }, 0);
  const reservedCalls = relevant.reduce(
    (total, job) => total + (["completed", "awaiting-approval"].includes(job.state)
      ? job.attempts.length
      : Math.max(job.policy.budget.modelCalls, job.attempts.length)),
    0,
  );
  return {
    tokens: {
      limit: settings.dailyTokens,
      spent: Math.ceil(spentTokens),
      reserved: Math.ceil(reservedTokens),
      remaining: Math.max(0, settings.dailyTokens - Math.ceil(reservedTokens)),
    },
    modelCalls: {
      limit: settings.dailyModelCalls,
      spent: spentCalls,
      reserved: reservedCalls,
      remaining: Math.max(0, settings.dailyModelCalls - reservedCalls),
    },
  };
}
