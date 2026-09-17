import { z } from "zod";

/** Structural/lexical readiness for the latest filesystem observations, not AI completion. */
export const indexingReadinessSchema = z.object({
  kind: z.literal("structural"),
  state: z.enum(["unknown", "scanning", "indexing", "current", "failed", "paused"]),
  generation: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().nullable(),
  current: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  failures: z.array(z.object({ path: z.string(), message: z.string() })).max(5),
});
export type IndexingReadiness = z.infer<typeof indexingReadinessSchema>;

export const searchCoverageSchema = z.object({
  state: z.enum(["current", "incomplete", "unknown"]),
  indexing: indexingReadinessSchema,
  message: z.string().nullable(),
});
export type SearchCoverage = z.infer<typeof searchCoverageSchema>;

export function unknownIndexingReadiness(): IndexingReadiness {
  return {
    kind: "structural",
    state: "unknown",
    generation: 0,
    total: null,
    current: 0,
    pending: 0,
    failed: 0,
    failures: [],
  };
}

export function describeIndexing(indexing: IndexingReadiness): string {
  if (indexing.state === "unknown") return "Search indexing status unavailable";
  if (indexing.state === "scanning") return "Scanning vault for indexing work";
  const progress = `${indexing.current}/${indexing.total ?? "?"} notes current`;
  if (indexing.state === "current") return `Search index current · ${progress}`;
  if (indexing.state === "paused") return `Search indexing paused · ${progress}`;
  return `Search indexing · ${progress} · ${indexing.pending} pending · ${indexing.failed} failed`;
}

/** A query which overlaps a commit/edit cannot claim complete structural coverage. */
export function searchCoverage(
  before: IndexingReadiness,
  after: IndexingReadiness,
): SearchCoverage {
  if (before.state === "unknown" || after.state === "unknown")
    return {
      state: "unknown",
      indexing: after,
      message:
        "Structural index coverage is unavailable; empty results do not establish that the vault has no matching notes.",
    };
  if (
    before.state === "current" &&
    after.state === "current" &&
    before.generation === after.generation
  )
    return { state: "current", indexing: after, message: null };
  return {
    state: "incomplete",
    indexing: after,
    message:
      after.state === "current"
        ? "The structural index changed during this search. Run it again against the current index."
        : `${describeIndexing(after)}. Results may omit matching notes; direct note reads remain available.`,
  };
}
