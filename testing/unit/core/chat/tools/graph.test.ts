import { describe, expect, test } from "bun:test";
import { DateTime, RecordId, type Surreal } from "surrealdb";
import { contentRevision } from "../../../../../src/api/notes";
import { makeFindPathTool } from "../../../../../src/core/chat/tools/graph";
import { GraphService } from "../../../../../src/core/graph/graphService";
import { STRUCTURAL_INDEX_VERSION } from "../../../../../src/core/markdown/types";

function fixture(
  options: {
    edge?: unknown;
    envelope?: unknown;
    edit?: boolean;
    count?: number;
    table?: string;
    missing?: string;
    onEdgeRead?: () => void;
  } = {},
) {
  const queries: string[] = [];
  const reads = new Map<string, number>();
  const db = {
    query: (sql: string, bindings: Record<string, unknown> = {}) => {
      queries.push(sql);
      return {
        collect: async () => {
          if (sql.includes("SELECT sha"))
            return [
              [
                {
                  sha: contentRevision(String(bindings.path)),
                  tier1_at: new DateTime(new Date()),
                  structural_version: STRUCTURAL_INDEX_VERSION,
                },
              ],
            ];
          if (sql.includes("FROM note"))
            return [[{ id: new RecordId("note", "a"), path: bindings.path }]];
          options.onEdgeRead?.();
          if (options.envelope) return options.envelope;
          if (!sql.includes(`FROM ${options.table ?? "wikilink"}`) || bindings.path !== "a.md")
            return [[]];
          return [
            Array.from(
              { length: options.count ?? 1 },
              (_, index) =>
                options.edge ?? {
                  id: new RecordId("wikilink", String(index)),
                  fromPath: "a.md",
                  toPath: "b.md",
                  source: "wikilink",
                  confidence: 1,
                },
            ),
          ];
        },
      };
    },
  } as unknown as Surreal;
  const graph = new GraphService({
    db,
    vault: {
      readBounded: async (path) => {
        if (path === options.missing) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        reads.set(path, (reads.get(path) ?? 0) + 1);
        return options.edit && (reads.get(path) ?? 0) > 1 ? `${path} changed` : path;
      },
    },
  });
  return { graph, queries, reads };
}

describe("bounded graph tools", () => {
  test("validates paths and finite hop bounds before reading", () => {
    const tool = makeFindPathTool(fixture().graph);
    for (const args of [
      { fromNotePath: "a.md", toNotePath: "" },
      { toNotePath: "b.md" },
      { fromNotePath: "/a.md", toNotePath: "b.md" },
      { fromNotePath: ".hidden.md", toNotePath: "b.md" },
      { fromNotePath: "a.txt", toNotePath: "b.md" },
      { fromNotePath: "a.md", toNotePath: "b.md", surprise: true },
      { fromNotePath: "a.md", toNotePath: "b.md", maxHops: 7 },
    ])
      expect(() => tool.validate(args)).toThrow();
  });
  test("rejects malformed envelopes and endpoint data", async () => {
    await expect(
      fixture({ envelope: { rows: [] } }).graph.neighbors({ path: "a.md" }),
    ).rejects.toThrow("invalid statement envelope");
    for (const edge of [
      { fromPath: "a.md", toPath: null },
      { fromPath: "elsewhere.md", toPath: "other.md" },
      { fromPath: "a.md", toPath: "a.md" },
      { fromPath: "a.md", toPath: ".secret.md" },
    ])
      await expect(
        fixture({
          edge: {
            id: new RecordId("wikilink", "edge"),
            source: "wikilink",
            confidence: 1,
            ...edge,
          },
        }).graph.neighbors({ path: "a.md" }),
      ).rejects.toThrow("storage integrity");
  });
  test("returns a revision-checked route and shared tool result", async () => {
    const { graph, queries } = fixture();
    const result = await makeFindPathTool(graph).invoke(
      { fromNotePath: "a.md", toNotePath: "b.md" },
      new AbortController().signal,
      { clientIdentity: "human" },
    );
    expect(result.path.map((note) => note.path)).toEqual(["a.md", "b.md"]);
    expect(result.steps[0].state).toBe("authored");
    expect(result.steps[0].assessment).toBeNull();
    expect(result.coverage.state).toBe("unknown");
    expect(
      queries
        .filter((query) => !query.includes("FROM note"))
        .every((query) => query.includes("LIMIT $limit TIMEOUT 2s")),
    ).toBe(true);
  });
  test("an edit during traversal fails instead of publishing stale evidence", async () => {
    await expect(fixture({ edit: true }).graph.path({ from: "a.md", to: "b.md" })).rejects.toThrow(
      "changed during this read",
    );
  });
  test("limits return explicit truncation and cancellation performs no I/O", async () => {
    const { graph, queries } = fixture({ count: 3 });
    const page = await graph.neighbors({ path: "a.md", limit: 1 });
    expect(page.connections).toHaveLength(1);
    expect(page.truncated).toBe(true);
    const before = queries.length;
    await expect(graph.neighbors({ path: "a.md" }, AbortSignal.abort())).rejects.toThrow(
      "cancelled",
    );
    expect(queries).toHaveLength(before);
  });
  test("relationship evidence is returned only for the recorded current revisions", async () => {
    const evidence = {
      path: "a.md",
      revision: contentRevision("a.md"),
      quote: "a.md",
      range: { start: 0, end: 4, startLine: 1, endLine: 1 },
    };
    const provenance = {
      pipeline: "relate",
      jobId: "00000000-0000-4000-8000-000000000001",
      configurationRevision: "c".repeat(64),
      sources: [{ path: "a.md", revision: evidence.revision }],
      evidence: [evidence],
      rationale: "B develops the idea in A.",
      score: { kind: "model-assessment", value: 0.8 },
    };
    const edge = {
      id: new RecordId("supports", "relation"),
      fromPath: "a.md",
      toPath: "b.md",
      source: "pipeline-relate",
      confidence: 0.8,
      provenance: JSON.stringify(provenance),
    };
    const current = await fixture({ table: "supports", edge }).graph.neighbors({ path: "a.md" });
    expect(current.connections[0]).toMatchObject({
      rationale: provenance.rationale,
      assessment: 0.8,
      evidenceState: "current",
      evidence: [evidence],
    });
    const unavailableProvenance = {
      ...provenance,
      sources: [...provenance.sources, { path: "gone.md", revision: "e".repeat(64) }],
    };
    const unavailable = await fixture({
      table: "supports",
      missing: "gone.md",
      edge: { ...edge, provenance: JSON.stringify(unavailableProvenance) },
    }).graph.neighbors({ path: "a.md" });
    expect(unavailable.connections[0]).toMatchObject({
      evidenceState: "unavailable",
      evidence: [],
    });
    provenance.sources[0].revision = "d".repeat(64);
    const stale = await fixture({
      table: "supports",
      edge: { ...edge, provenance: JSON.stringify(provenance) },
    }).graph.neighbors({ path: "a.md" });
    expect(stale.connections[0]).toMatchObject({ evidenceState: "stale", evidence: [] });
  });
  test("cancellation while storage is returning edges keeps the CANCELLED error code", async () => {
    const controller = new AbortController();
    const { graph } = fixture({ onEdgeRead: () => controller.abort() });
    await expect(graph.neighbors({ path: "a.md" }, controller.signal)).rejects.toMatchObject({
      code: "CANCELLED",
    });
  });
});
