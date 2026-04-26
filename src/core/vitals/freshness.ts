export interface FreshnessInput {
  updatedAt: number;
  now: number;
  halfLifeDays: number;
}

export function freshness(input: FreshnessInput): number {
  const days = Math.max(0, (input.now - input.updatedAt) / 86_400_000);
  return Math.exp(-days / input.halfLifeDays);
}
