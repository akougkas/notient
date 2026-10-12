import { createHash } from "node:crypto";
import {
  intelligenceRecordSchema,
  type IntelligenceEvidence,
  type IntelligenceFeedback,
  type IntelligenceRecord,
  type IntelligenceRelationship,
} from "./types";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function intelligenceRecordId(input: IntelligenceRecord): string {
  const record = intelligenceRecordSchema.parse(input);
  const evidence = (item: IntelligenceEvidence) => ({
    source: { path: item.source.path, quote: item.source.quote },
    relation: item.relation,
    assessment: item.assessment,
  });
  const relationship = (item: IntelligenceRelationship) => ({
    target: item.target,
    relation: item.relation ?? null,
    meaning: item.meaning,
    provenance: item.provenance,
    evidence: item.evidence.map((source) => ({ path: source.path, quote: source.quote })),
  });
  const semanticRecord = {
    kind: record.kind,
    status: record.status,
    statement: record.statement,
    attribution: record.attribution,
    ...(record.capturedContribution === undefined
      ? {}
      : { capturedContribution: record.capturedContribution }),
    ...(record.assessmentOf === undefined ? {} : { assessmentOf: record.assessmentOf }),
    evidence: record.evidence.map(evidence),
    qualifications: record.qualifications,
    relationships: record.relationships.map(relationship),
    feedback: record.feedback,
  };
  return `i-${digest(JSON.stringify(canonical(semanticRecord)))}`;
}

export function intelligenceSuppressionSubject(
  input: Pick<IntelligenceRecord, "kind" | "evidence" | "relationships"> &
    Partial<Pick<IntelligenceRecord, "statement" | "attribution">>,
): string {
  const evidence = [...new Map(
    input.evidence.map((item) => [
      `${item.source.path}\u0000${item.source.quote.normalize("NFC")}`,
      { path: item.source.path, quote: item.source.quote.normalize("NFC") },
    ]),
  ).values()].sort((left, right) =>
    `${left.path}\u0000${left.quote}`.localeCompare(`${right.path}\u0000${right.quote}`),
  );
  const relationships = [...new Map(
    input.relationships.map((item) => [
      `${item.target}\u0000${item.relation ?? ""}`,
      { target: item.target, relation: item.relation ?? null },
    ]),
  ).values()].sort((left, right) =>
    `${left.target}\u0000${left.relation ?? ""}`.localeCompare(`${right.target}\u0000${right.relation ?? ""}`),
  );
  if (evidence.length === 0 && relationships.length === 0) {
    const statement = input.statement?.normalize("NFC").trim().replace(/\s+/gu, " ");
    if (!statement || !input.attribution?.id || !input.attribution.kind)
      throw new Error("unquoted feedback requires a recorded claim and contributor identity");
    return `subject-v1:${digest(JSON.stringify(canonical({
      kind: input.kind,
      unquotedClaim: statement,
      contributor: { kind: input.attribution.kind, id: input.attribution.id },
    })))}`;
  }
  return `subject-v1:${digest(JSON.stringify(canonical({ kind: input.kind, evidence, relationships })))}`;
}

export function feedbackSuppressionKey(targetKey: string): string {
  const normalized = targetKey.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
  if (!normalized) throw new Error("feedback target key must not be empty");
  return `f-${digest(normalized)}`;
}

export function feedbackSuppresses(
  feedback: IntelligenceFeedback,
  candidateTargetKey: string,
  changedDependencyPaths: readonly string[] = [],
  deferredRelevant = false,
): boolean {
  if (feedback.reason === "deferred" && deferredRelevant) return false;
  if (changedDependencyPaths.length > 0) return false;
  return feedbackSuppressionKey(feedback.targetKey) === feedbackSuppressionKey(candidateTargetKey);
}

export function stableFeedbackRecordKey(record: IntelligenceRecord): string {
  const parsed = intelligenceRecordSchema.parse(record);
  if (parsed.kind !== "feedback" || parsed.feedback === null)
    throw new Error("feedback record key requires a feedback record");
  return feedbackSuppressionKey(parsed.feedback.targetKey);
}

export interface CompactIntelligenceFeedback {
  recordId: string;
  reason: IntelligenceFeedback["reason"];
  target: string;
  targetKey: string;
  explanation: string;
  attribution: { kind: IntelligenceRecord["attribution"]["kind"]; id: string; label: string };
  sourcePaths: string[];
  evidence: Array<{ path: string; relation: string; assessment: string; quote: string }>;
  relationships: Array<{ target: string; relation: string | null }>;
}

export function compactIntelligenceFeedback(
  records: readonly IntelligenceRecord[],
  limit = 12,
): CompactIntelligenceFeedback[] {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100)
    throw new Error("feedback context limit must be an integer from 0 through 100");
  if (limit === 0) return [];
  const seen = new Set<string>();
  const compact: CompactIntelligenceFeedback[] = [];
  for (const input of [...records].reverse()) {
    const record = intelligenceRecordSchema.parse(input);
    if (record.kind !== "feedback" || record.feedback === null) continue;
    const key = feedbackSuppressionKey(record.feedback.targetKey);
    if (seen.has(key)) continue;
    seen.add(key);
    compact.push({
      recordId: intelligenceRecordId(record),
      reason: record.feedback.reason,
      target: record.feedback.target.slice(0, 180),
      targetKey: record.feedback.targetKey.slice(0, 200),
      explanation: record.feedback.explanation.slice(0, 260),
      attribution: {
        kind: record.attribution.kind,
        id: record.attribution.id.slice(0, 80),
        label: record.attribution.label.slice(0, 80),
      },
      sourcePaths: [...new Set([
        ...record.dependencies.map((dependency) => dependency.path),
        ...record.evidence.map((evidence) => evidence.source.path),
        ...record.relationships.flatMap((relationship) => relationship.evidence.map((evidence) => evidence.path)),
      ])].slice(0, 4),
      evidence: record.evidence.slice(0, 3).map((evidence) => ({
        path: evidence.source.path.slice(0, 120),
        relation: evidence.relation,
        assessment: evidence.assessment,
        quote: evidence.source.quote.slice(0, 120),
      })),
      relationships: record.relationships.slice(0, 2).map((relationship) => ({
        target: relationship.target.slice(0, 120),
        relation: relationship.relation ?? null,
      })),
    });
    if (compact.length >= limit) break;
  }
  return compact;
}
