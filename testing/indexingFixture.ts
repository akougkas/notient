import type { IndexingReadiness, SearchCoverage } from "../src/api/indexing";
export function currentIndexingFixture(
  overrides: Partial<IndexingReadiness> = {},
): IndexingReadiness {
  return {
    kind: "structural",
    state: "current",
    generation: 1,
    total: 1,
    current: 1,
    pending: 0,
    failed: 0,
    failures: [],
    ...overrides,
  };
}
export function currentCoverageFixture(): SearchCoverage {
  return { state: "current", indexing: currentIndexingFixture(), message: null };
}
