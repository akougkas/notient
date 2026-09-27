import {
  intelligenceRecordSchema,
  type CurrentIntelligenceSource,
  type IntelligenceDependencyState,
  type IntelligenceRecord,
} from "./types";
import { withoutRetainedIntelligence } from "./markdown";

export type IntelligenceDependencyComparison = IntelligenceDependencyState & {
  revisionChanged: boolean;
};

function occurrences(text: string, quote: string): number {
  if (!quote) return 0;
  let count = 0;
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(quote, from);
    if (at < 0) break;
    count += 1;
    if (count > 1) return count;
    from = at + 1;
  }
  return count;
}

export function changedIntelligenceDependencies(
  input: IntelligenceRecord,
  currentSources: readonly CurrentIntelligenceSource[],
): IntelligenceDependencyComparison[] {
  const record = intelligenceRecordSchema.parse(input);
  const currentByPath = new Map(currentSources.map((source) => [source.path, source]));
  const previousByPath = new Map<
    string,
    { revision: string; evidence: Array<{ range: { start: number; end: number }; quote: string }> }
  >();
  const addDependency = (
    path: string,
    revision: string,
    evidence?: { range: { start: number; end: number }; quote: string },
  ) => {
    const current = previousByPath.get(path) ?? { revision, evidence: [] };
    if (current.revision !== revision)
      throw new Error(`intelligence dependency for ${path} has conflicting revisions`);
    if (evidence !== undefined && !current.evidence.some((entry) =>
      entry.range.start === evidence.range.start && entry.range.end === evidence.range.end && entry.quote === evidence.quote
    )) current.evidence.push(evidence);
    previousByPath.set(path, current);
  };
  for (const dependency of record.dependencies) addDependency(dependency.path, dependency.revision);
  for (const evidence of record.evidence)
    addDependency(evidence.source.path, evidence.source.revision, evidence.source);
  for (const relationship of record.relationships)
    for (const evidence of relationship.evidence)
      addDependency(evidence.path, evidence.revision, evidence);

  return [...previousByPath.entries()].map(([path, previous]) => {
    const current = currentByPath.get(path);
    if (!current) {
      return {
        path,
        previousRevision: previous.revision,
        currentRevision: null,
        retainedEvidence: false,
        revisionChanged: false,
        changedEvidence:
          previous.evidence.length > 0
            ? previous.evidence.map((entry) => entry.quote)
            : ["source unavailable"],
      };
    }
    if (current.revision === previous.revision) {
      return {
        path,
        previousRevision: previous.revision,
        currentRevision: current.revision,
        retainedEvidence: true,
        revisionChanged: false,
        changedEvidence: [],
      };
    }
    const authoredBody = withoutRetainedIntelligence(current.body);
    const changedEvidence = previous.evidence
      .filter((entry) => {
        if (authoredBody.slice(entry.range.start, entry.range.end) === entry.quote) return false;
        return occurrences(authoredBody, entry.quote) !== 1;
      })
      .map((entry) => entry.quote);
    return {
      path,
      previousRevision: previous.revision,
      currentRevision: current.revision,
      retainedEvidence: previous.evidence.length > 0 && changedEvidence.length === 0,
      revisionChanged: true,
      changedEvidence,
    };
  });
}
