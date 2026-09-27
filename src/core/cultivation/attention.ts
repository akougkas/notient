import type { AttentionSettings } from "../../api/background";

export interface AttentionCandidate {
  path: string;
  revision: string;
  modifiedAt: number;
  active: boolean;
  savedAt: number | null;
  lastCultivatedAt: number | null;
  currentRevisionCultivated: boolean;
  unresolvedQuestion: boolean;
  openTaskCount: number;
  changedEvidence: boolean;
  explicitPriority: number;
}

export interface AttentionAssessment {
  path: string;
  revision: string;
  score: number;
  eligible: boolean;
  reasons: string[];
}

export function assessAttention(
  candidate: AttentionCandidate,
  now: number,
  revisitDays: number,
): AttentionAssessment {
  const reasons: string[] = [];
  const hoursSinceEdit = Math.max(0, now - candidate.modifiedAt) / 3_600_000;
  const hoursSinceSave =
    candidate.savedAt === null ? Number.POSITIVE_INFINITY : Math.max(0, now - candidate.savedAt) / 3_600_000;
  const revisitMs = revisitDays * 86_400_000;
  const dueForRevisit =
    candidate.lastCultivatedAt === null || now - candidate.lastCultivatedAt >= revisitMs;
  const recentlyChanged = hoursSinceEdit <= 24 * 14 || hoursSinceSave <= 24 * 7;
  const eligible =
    !candidate.currentRevisionCultivated ||
    candidate.savedAt !== null ||
    candidate.changedEvidence ||
    dueForRevisit;
  let score = 0;
  if (candidate.active) {
    score += 12;
    reasons.push("Currently in focus");
  }
  if (candidate.savedAt !== null) {
    const recency = Math.exp(-hoursSinceSave / 24);
    score += 8 * recency;
    reasons.push("A save trigger is ready for this note");
  } else if (recentlyChanged) {
    score += 5 * Math.exp(-hoursSinceEdit / (24 * 7));
    reasons.push("Recently changed");
  }
  if (candidate.changedEvidence) {
    score += 7;
    reasons.push("Its supporting note changed since this note was last cultivated");
  }
  if (candidate.unresolvedQuestion) {
    score += 2;
    reasons.push("Contains an unresolved question");
  }
  if (candidate.openTaskCount > 0) {
    score += Math.min(3, candidate.openTaskCount);
    reasons.push(`${candidate.openTaskCount} open task${candidate.openTaskCount === 1 ? "" : "s"}`);
  }
  if (dueForRevisit && candidate.currentRevisionCultivated) {
    score += 3 + Math.min(3, (now - (candidate.lastCultivatedAt ?? 0)) / revisitMs);
    reasons.push(`Due for a ${revisitDays}-day revisit`);
  }
  if (candidate.explicitPriority !== 0) {
    score += candidate.explicitPriority / 10;
    reasons.push(
      candidate.explicitPriority > 0
        ? `Explicitly prioritized (${candidate.explicitPriority})`
        : `Explicitly deprioritized (${candidate.explicitPriority})`,
    );
  }
  if (reasons.length === 0) reasons.push("New note has not been cultivated yet");
  return {
    path: candidate.path,
    revision: candidate.revision,
    score,
    eligible,
    reasons,
  };
}

export function attentionPriorityMap(settings: AttentionSettings): Map<string, number> {
  return new Map(settings.priorities.map(({ path, priority }) => [path, priority]));
}

export function utcDayStart(at: number): number {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
