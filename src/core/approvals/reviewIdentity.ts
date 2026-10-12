import { createHash } from "node:crypto";
import type { PipelinePlan } from "../../api/pipelines";
import { intelligenceSuppressionSubject, parseAllIntelligenceRecords, withoutRetainedIntelligence } from "../intelligence";
import { WRITEBACK_EDGE_TABLES } from "../db/edgeTables";
import { parseSurrealRelationRecordId } from "../db/recordId";

type PlannedChange = PipelinePlan["changes"][number];

const START_MARKER = /^<!-- notient-intelligence:v1:start:i-[a-f0-9]{64}:([A-Za-z0-9_-]+) -->$/gmu;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function appendSubjects(text: string): string[] {
  const subjects = new Set<string>();
  try {
    const records = parseAllIntelligenceRecords(`## Notient understanding\n${text}`);
    if (records.length !== [...text.matchAll(START_MARKER)].length || records.length === 0)
      return [`text:${digest(text)}`];
    for (const record of records) {
      const qualifiedRecords = [...new Set(record.qualifications.flatMap((qualification) => {
        const match = /^This qualifies retained record (i-[a-f0-9]{64}); it does not establish that the conclusion is false\.$/u.exec(qualification);
        return match ? [match[1]!] : [];
      }))].sort();
      const subject = record.evidence.length > 0 || record.relationships.length > 0
        ? intelligenceSuppressionSubject(record)
        : `record:${record.kind}:${digest(record)}`;
      subjects.add(
        qualifiedRecords.length > 0 || record.assessmentOf !== undefined
          ? `${subject}:targets:${digest({ qualifiedRecords, assessmentOf: record.assessmentOf ?? null })}`
          : subject,
      );
    }
    const authored = withoutRetainedIntelligence(text).split(/\r?\n/u)
      .filter((line) => line.trim().length > 0).join("\n");
    subjects.add(`authored:${digest(authored)}`);
  } catch {
    return [`text:${digest(text)}`];
  }
  return [...subjects].sort();
}

function normalized(change: PlannedChange): unknown {
  if (change.kind === "append")
    return { kind: change.kind, source: change.source, subjects: appendSubjects(change.text) };
  if (change.kind === "relationship") {
    let relation: string;
    try { relation = parseSurrealRelationRecordId(change.edgeId, WRITEBACK_EDGE_TABLES).table; }
    catch { relation = change.edgeId; }
    return { kind: change.kind, source: change.source, target: change.target, relation };
  }
  return change;
}

export function reviewEffectFingerprint(
  changes: readonly PlannedChange[],
  relationships: PipelinePlan["relationships"],
): string {
  const firstMove = changes.findIndex((change) => ["move", "archive", "unarchive"].includes(change.kind));
  const split = firstMove < 0 ? changes.length : firstMove;
  return digest(
    [
      ...changes.slice(0, split).map(normalized),
      ...relationships.map((relationship) =>
        ({ kind: "relationship", source: relationship.source, target: relationship.target, relation: relationship.relation }),
      ),
      ...changes.slice(split).map(normalized),
    ]
      .map((entry) => digest(entry)),
  );
}
