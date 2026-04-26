import type { StreamSettings } from "./types";

export interface ScoreInput {
  confidence: number;
  ageHours: number;
  relatedToActiveNote: boolean;
  settings: StreamSettings;
}

export function computeScore(input: ScoreInput): number {
  const recency = Math.exp(-input.ageHours / input.settings.recencyHalfLifeHours);
  const relevance = input.relatedToActiveNote ? 1 : input.settings.offNoteRelevanceFloor;
  return Math.max(0, input.confidence) * recency * relevance;
}

export interface RankInput {
  id: string;
  confidence: number;
  ageHours: number;
  relatedToActiveNote: boolean;
}

export interface Ranked extends RankInput {
  score: number;
}

export function rank(items: RankInput[], settings: StreamSettings): Ranked[] {
  const scored = items.map((item) => ({
    ...item,
    score: computeScore({
      confidence: item.confidence,
      ageHours: item.ageHours,
      relatedToActiveNote: item.relatedToActiveNote,
      settings,
    }),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, settings.maxItems);
}
