import type { Connection } from "../../api/graph";
import { sourceRange } from "../../api/notes";
import type { NoteReference, SourceReference } from "../../api/schema";
import { isWritebackEdgeTable, type WritebackEdgeTable } from "../db/edgeTables";
import {
  intelligenceRecordId,
  parseAllIntelligenceRecords,
  withoutRetainedIntelligence,
} from "../intelligence";

export function retainedRelationshipCandidates(
  body: string,
): Array<{ target: string; relation: WritebackEdgeTable }> | null {
  try {
    return parseAllIntelligenceRecords(body).flatMap((record) =>
      record.kind === "relationship" && record.status === "provisional"
        ? record.relationships.flatMap((relationship) =>
            relationship.provenance === "inferred" &&
            isWritebackEdgeTable(relationship.relation ?? "")
              ? [
                  {
                    target: relationship.target,
                    relation: relationship.relation as WritebackEdgeTable,
                  },
                ]
              : [],
          )
        : [],
    );
  } catch {
    return null;
  }
}

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
): Pick<Connection, "rationale" | "evidence" | "evidenceState" | "id" | "author"> | null {
  let records;
  try {
    records = parseAllIntelligenceRecords(source.body);
  } catch {
    return null;
  }
  const matches: Array<
    Pick<Connection, "rationale" | "evidence" | "evidenceState" | "id" | "author">
  > = [];
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
        id: intelligenceRecordId(record),
        author: record.attribution.id,
        rationale: relationship.meaning,
        evidence,
        evidenceState: "current",
      });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

export function alreadyRetainedRelationship(
  source: CurrentEndpoint,
  target: CurrentEndpoint,
  relation: WritebackEdgeTable,
  rationale: string,
  evidence: readonly SourceReference[],
): string | null {
  const recovered = recoverCurrentRelationshipIntelligence(source, target, relation);
  if (!recovered || !evidence.length) return null;
  const record = parseAllIntelligenceRecords(source.body).find((item) => intelligenceRecordId(item) === recovered.id);
  if (!record || !sameRationaleWording(record.statement, rationale)) return null;
  if (!evidence.every((candidate) => recovered.evidence.some((previous) =>
    candidate.path === previous.path && candidate.revision === previous.revision &&
    candidate.range.start >= previous.range.start && candidate.range.end <= previous.range.end &&
    previous.quote.slice(candidate.range.start - previous.range.start, candidate.range.end - previous.range.start) === candidate.quote
  ))) return null;
  return recovered.id;
}

function sameRationaleWording(left: string, right: string): boolean {
  const words = (text: string) => text.normalize("NFKC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
  const a = words(left), b = words(right);
  if (a.length && a.join(" ") === b.join(" ")) return true;
  const shorter = a.length < b.length ? a : b, longer = a.length < b.length ? b : a;
  if (shorter.length < 30 || longer.length !== shorter.length + 1) return false;
  let at = 0;
  while (at < shorter.length && shorter[at] === longer[at]) at++;
  const repeated = longer[at];
  if (!repeated || !shorter.includes(repeated) || /^\d+$/u.test(repeated) ||
    ["no", "not", "never", "neither", "without", "cannot", "one", "two", "three", "first", "second", "third", "always", "only", "sometimes", "all", "none"].includes(repeated)) return false;
  return shorter.slice(at).every((word, index) => word === longer[at + index + 1]);
}
