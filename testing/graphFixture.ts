import type { Connection, GraphNeighbors, GraphPath } from "../src/api/graph";
import { searchCoverage, unknownIndexingReadiness } from "../src/api/indexing";
const revision = "a".repeat(64);
const readiness = {
  ...unknownIndexingReadiness(),
  state: "current" as const,
  total: 3,
  current: 3,
};
const coverage = searchCoverage(readiness, readiness);
export function graphConnection(path = "b.md"): Connection {
  return {
    id: `wikilink:${path}`,
    note: { path, revision },
    relation: "wikilink",
    direction: "outgoing",
    state: "authored",
    assessment: null,
    author: "wikilink",
    rationale: null,
    evidence: [],
    evidenceState: "unavailable",
  };
}
export function graphNeighborsFixture(
  path = "a.md",
  connections: Connection[] = [],
): GraphNeighbors {
  return {
    ok: true,
    note: { path, revision },
    connections,
    coverage,
    omitted: 0,
    truncated: false,
  };
}
export function graphPathFixture(paths = ["a.md", "b.md", "c.md"]): GraphPath {
  return {
    ok: true,
    from: paths[0],
    to: paths[paths.length - 1],
    path: paths.map((path) => ({ path, revision })),
    steps: paths.slice(1).map(graphConnection),
    outcome: "found",
    coverage,
    visited: paths.length,
  };
}
