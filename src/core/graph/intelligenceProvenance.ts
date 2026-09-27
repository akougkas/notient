import type { Connection } from "../../api/graph";
import { sourceRange } from "../../api/notes";
import type { NoteReference, SourceReference } from "../../api/schema";
import type { WritebackEdgeTable } from "../db/edgeTables";
import { parseAllIntelligenceRecords, withoutRetainedIntelligence } from "../intelligence";

interface CurrentEndpoint {
  note: NoteReference;
  body: string;
}

function currentReference(
  reference: SourceReference,
  endpoint: CurrentEndpoint,
): SourceReference | null {
  if (reference.path !== endpoint.note.path || !reference.quote) return null;
  const authored = withoutRetainedIntelligence(endpoint.body);
  const start = authored.indexOf(reference.quote);
  if (start < 0 || authored.indexOf(reference.quote, start + 1) !== -1) return null;
  const end = start + reference.quote.length;
  return {
    path: endpoint.note.path,
    revision: endpoint.note.revision,
    range: sourceRange(endpoint.body, start, end),
    quote: reference.quote,
  };
}

function currentEvidence(
  references: readonly SourceReference[],
  dependencies: readonly NoteReference[],
  source: CurrentEndpoint,
  target: CurrentEndpoint,
): SourceReference[] | null {
  if (references.length < 2 || references.length > 20) return null;
  const previousRevisions = new Map<string, string>();
  for (const reference of references) {
    const previous = previousRevisions.get(reference.path);
    if (previous !== undefined && previous !== reference.revision) return null;
    previousRevisions.set(reference.path, reference.revision);
  }
  for (const dependency of dependencies) {
    const previous = previousRevisions.get(dependency.path);
    if (previous !== undefined && previous !== dependency.revision) return null;
  }
  const rebound: SourceReference[] = [];
  let sawSource = false;
  let sawTarget = false;
  for (const reference of references) {
    if (reference.path === source.note.path) {
      sawSource = true;
      const current = currentReference(reference, source);
      if (!current) return null;
      rebound.push(current);
    } else if (reference.path === target.note.path) {
      sawTarget = true;
      const current = currentReference(reference, target);
      if (!current) return null;
      rebound.push(current);
    } else {
      return null;
    }
  }
  return sawSource && sawTarget ? rebound : null;
}

export function recoverCurrentRelationshipIntelligence(
  source: CurrentEndpoint,
  target: CurrentEndpoint,
  relation: WritebackEdgeTable,
): Pick<Connection, "rationale" | "evidence" | "evidenceState"> | null {
  let records;
  try {
    records = parseAllIntelligenceRecords(source.body);
  } catch {
    return null;
  }
  const matches: Array<Pick<Connection, "rationale" | "evidence" | "evidenceState">> = [];
  for (const record of records) {
    if (record.kind !== "relationship" || record.status !== "provisional") continue;
    for (const relationship of record.relationships) {
      if (
        relationship.target !== target.note.path ||
        relationship.relation !== relation ||
        relationship.provenance !== "inferred"
      )
        continue;
      const evidence = currentEvidence(relationship.evidence, record.dependencies, source, target);
      if (!evidence) continue;
      matches.push({
        rationale: relationship.meaning,
        evidence,
        evidenceState: "current",
      });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}
