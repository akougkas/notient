import { graphNeighborsSchema, graphPathSchema } from "./graph";
import { noteExcerptSchema, retrievalResultSchema } from "./retrieval";
import type { SourceReference } from "./schema";
import type { IntelligenceRecord } from "../core/intelligence/types";

export type SurfaceEvidence = {
  path: string;
  title: string;
  quote: string | null;
  evidence: SourceReference | null;
  freshness: "current" | "lagging" | "unknown";
  retainedRecord?: {
    id: string;
    kind?: IntelligenceRecord["kind"];
    status?: IntelligenceRecord["status"];
  };
};

export type EvidenceSurface = {
  kind: "evidence";
  id: string;
  title: string;
  items: SurfaceEvidence[];
  qualification: string | null;
};

export type PlacesSurface = {
  kind: "places";
  id: string;
  title: string;
  paths: string[];
  scope: "returned-notes";
};

export type MapSurface = {
  kind: "map";
  id: string;
  title: string;
  nodes: { path: string; title: string }[];
  edges: { from: string; to: string; relation: string; state: string }[];
  qualification: string | null;
};

export type NotientSurface = EvidenceSurface | PlacesSurface | MapSurface;

export type SurfaceToolResult = {
  callId: string;
  tool?: string;
  status: "ok" | "error";
  data?: unknown;
  error?: string;
};

function title(path: string): string {
  return (path.split("/").at(-1) ?? path).replace(/\.md$/, "");
}

function places(callId: string, paths: string[]): PlacesSurface | null {
  const distinct = [...new Set(paths)];
  return distinct.length > 1 ? {
    kind: "places", id: `places:${callId}`, title: "Where these notes live",
    paths: distinct, scope: "returned-notes",
  } : null;
}

export function projectToolSurfaces(results: readonly SurfaceToolResult[]): NotientSurface[] {
  const unique = new Map<string, SurfaceToolResult>();
  for (const result of results) {
    if (result.callId && !unique.has(result.callId)) unique.set(result.callId, result);
  }
  const surfaces: NotientSurface[] = [];
  for (const result of unique.values()) {
    if (result.status !== "ok") continue;
    const search = retrievalResultSchema.safeParse(result.data);
    if (search.success && (!result.tool || result.tool === "vault.search_notes")) {
      const data = search.data;
      surfaces.push({
        kind: "evidence", id: `evidence:${result.callId}`, title: "Notes worth looking at",
        items: data.hits.map((hit) => ({
          path: hit.note.path, title: title(hit.note.path), quote: hit.evidence?.quote ?? null,
          evidence: hit.evidence, freshness: hit.freshness.state,
        })),
        qualification: [data.coverage.message, data.omitted ? `${data.omitted} additional results omitted.` : null]
          .filter(Boolean).join(" ") || null,
      });
      const tree = places(result.callId, data.hits.map((hit) => hit.note.path));
      if (tree) surfaces.push(tree);
      continue;
    }
    const excerpt = noteExcerptSchema.safeParse(result.data);
    if (excerpt.success && (!result.tool || result.tool === "vault.read_note")) {
      const data = excerpt.data;
      if (
        data.evidence.path !== data.notePath || data.body !== data.evidence.quote ||
        data.evidence.range.end - data.evidence.range.start !== data.body.length
      ) continue;
      const records = data.retainedUnderstanding?.records.filter((record) =>
        record.source.path === data.notePath && record.source.revision === data.evidence.revision &&
        record.source.range.end - record.source.range.start === record.source.quote.length,
      ) ?? [];
      const invalidRecords = (data.retainedUnderstanding?.records.length ?? 0) - records.length;
      const omittedRecords = (data.retainedUnderstanding?.omitted ?? 0) + invalidRecords;
      surfaces.push({
        kind: "evidence", id: `evidence:${result.callId}`, title: "Read from your note",
        items: [{ path: data.notePath, title: title(data.notePath), quote: data.evidence.quote,
          evidence: data.evidence, freshness: "unknown" },
          ...records.map((record): SurfaceEvidence => ({
            path: data.notePath, title: title(data.notePath), quote: record.source.quote,
            evidence: record.source, freshness: "unknown",
            retainedRecord: { id: record.recordId, kind: record.kind, status: record.status },
          })),
        ],
        qualification: [
          data.truncated ? "Body excerpt; the complete note contains more." : "Returned passage complete.",
          ...(data.retainedUnderstanding ? [
            `${records.length} complete retained record${records.length === 1 ? "" : "s"}${omittedRecords ? `; ${omittedRecords} omitted` : ""}.`,
          ] : []),
          data.structure !== null && !data.structureOmitted ? "Outline included." : "Outline not supplied.",
        ].join(" "),
      });
      continue;
    }
    const neighbors = graphNeighborsSchema.safeParse(result.data);
    if (neighbors.success && (!result.tool || result.tool === "vault.list_neighbors")) {
      const data = neighbors.data;
      surfaces.push({
        kind: "map", id: `map:${result.callId}`, title: "Connections around this note",
        nodes: [data.note, ...data.connections.map((edge) => edge.note)]
          .filter((note, index, all) => all.findIndex((other) => other.path === note.path) === index)
          .map((note) => ({ path: note.path, title: title(note.path) })),
        edges: data.connections.map((edge) => ({
          from: edge.direction === "outgoing" ? data.note.path : edge.note.path,
          to: edge.direction === "outgoing" ? edge.note.path : data.note.path,
          relation: edge.relation, state: edge.state,
        })),
        qualification: [data.coverage.message,
          data.omitted || data.truncated ? "Additional connections are omitted." : null,
          data.connections.some((edge) => edge.evidenceState !== "current") ? "Some supporting evidence is stale or unavailable." : null,
        ].filter(Boolean).join(" ") || null,
      });
      continue;
    }
    const route = graphPathSchema.safeParse(result.data);
    if (route.success && (!result.tool || result.tool === "graph.find_path")) {
      const data = route.data;
      surfaces.push({
        kind: "map", id: `map:${result.callId}`, title: "A path between notes",
        nodes: data.path.map((note) => ({ path: note.path, title: title(note.path) })),
        edges: data.steps.map((edge, index) => ({
          from: data.path[edge.direction === "outgoing" ? index : index + 1]!.path,
          to: data.path[edge.direction === "outgoing" ? index + 1 : index]!.path,
          relation: edge.relation, state: edge.state,
        })),
        qualification: data.outcome === "incomplete" ? "Coverage is incomplete; a route may still exist."
          : data.outcome === "not-found" ? "No route was found within this bounded search."
          : data.coverage.message,
      });
    }
  }
  return surfaces;
}
