import type { ProposalProvenance } from "../../api/proposals";
import { sourceRange } from "../../api/notes";
import type { SourceReference } from "../../api/schema";
import type { WritebackEdgeTable } from "../db/edgeTables";
import {
  parseAllIntelligenceRecords,
  prepareIntelligenceAppend,
  withoutRetainedIntelligence,
} from "../intelligence";

export interface RelationshipEndpointSnapshot {
  path: string;
  revision: string | null;
  body: string;
}

function exactAuthoredReference(
  reference: SourceReference,
  endpoint: RelationshipEndpointSnapshot,
  dependencyRevision: string | undefined,
): boolean {
  if (
    reference.path !== endpoint.path ||
    reference.revision !== (endpoint.revision ?? dependencyRevision) ||
    !dependencyRevision ||
    reference.revision !== dependencyRevision
  )
    return false;
  const { start, end } = reference.range;
  if (end <= start || end > endpoint.body.length) return false;
  const actualRange = sourceRange(endpoint.body, start, end);
  if (
    actualRange.startLine !== reference.range.startLine ||
    actualRange.endLine !== reference.range.endLine
  )
    return false;
  return withoutRetainedIntelligence(endpoint.body).slice(start, end) === reference.quote;
}

export function hasValidatedRelationshipIntelligence(
  body: string,
  relation: WritebackEdgeTable,
  source: RelationshipEndpointSnapshot,
  target: RelationshipEndpointSnapshot,
): boolean {
  let records;
  try {
    records = parseAllIntelligenceRecords(body);
  } catch {
    return false;
  }
  return records.some((record) => {
    if (record.kind !== "relationship") return false;
    const sourceDependency = record.dependencies.find((item) => item.path === source.path)?.revision;
    const targetDependency = record.dependencies.find((item) => item.path === target.path)?.revision;
    if (!sourceDependency || !targetDependency) return false;
    return record.relationships.some((candidate) => {
      if (
        candidate.target !== target.path ||
        candidate.relation !== relation ||
        candidate.evidence.length < 2 ||
        candidate.evidence.length > 20
      )
        return false;
      let sawSource = false;
      let sawTarget = false;
      for (const reference of candidate.evidence) {
        if (reference.path === source.path) {
          sawSource = true;
          if (!exactAuthoredReference(reference, source, sourceDependency)) return false;
        } else if (reference.path === target.path) {
          sawTarget = true;
          if (!exactAuthoredReference(reference, target, targetDependency)) return false;
        } else {
          return false;
        }
      }
      return sawSource && sawTarget;
    });
  });
}

export function retainReviewedRelationship(
  body: string,
  relation: WritebackEdgeTable,
  target: string,
  provenance?: ProposalProvenance,
  contributor = "notient",
): string {
  const evidence = provenance?.evidence.slice(0, 20) ?? [];
  const statement = provenance?.rationale ?? `This note has a reviewed ${relation} relationship with ${target}.`;
  return prepareIntelligenceAppend(body, "Notient understanding", [{
    kind: "relationship",
    status: "provisional",
    statement,
    attribution: { kind: "agent", id: contributor, label: contributor },
    evidence: evidence.map((source) => ({ source, relation: "reports", assessment: "source-assertion" })),
    qualifications: [
      "Reviewed for retention; review grants a write and does not independently verify the relationship.",
      ...(evidence.length ? ["Support is limited to the cited note passages."] : ["No supporting source passage was retained with this legacy proposal."]),
    ],
    relationships: [{ target, relation, meaning: `${relation}: ${statement}`, provenance: "inferred", evidence }],
    dependencies: [...new Map(evidence.map((source) => [source.path, { path: source.path, revision: source.revision }])).values()],
    feedback: null,
  }]).body;
}
