import { createHash } from "node:crypto";
import type { PipelinePlan } from "../../api/pipelines";
import { intelligenceRecordSchema, intelligenceSuppressionSubject } from "../intelligence";

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
  for (const match of text.matchAll(START_MARKER)) {
    try {
      const record = intelligenceRecordSchema.parse(
        JSON.parse(Buffer.from(match[1] ?? "", "base64url").toString("utf8")),
      );
      subjects.add(
        record.evidence.length > 0 || record.relationships.length > 0
          ? intelligenceSuppressionSubject(record)
          : `record:${record.kind}:${digest(record)}`,
      );
    } catch {
      subjects.add(`raw:${digest(match[1] ?? "")}`);
    }
  }
  return subjects.size > 0 ? [...subjects].sort() : [`text:${digest(text)}`];
}

function normalized(change: PlannedChange): unknown {
  if (change.kind === "append")
    return { kind: change.kind, source: change.source, subjects: appendSubjects(change.text) };
  if (change.kind === "relationship")
    return { kind: change.kind, source: change.source, target: change.target };
  return change;
}

export function reviewEffectFingerprint(
  changes: readonly PlannedChange[],
  relationships: PipelinePlan["relationships"],
): string {
  return digest(
    [
      ...changes.map(normalized),
      ...relationships.map((relationship) =>
        normalized({ kind: "relationship", source: relationship.source, target: relationship.target, edgeId: "" } as PlannedChange),
      ),
    ]
      .map((entry) => digest(entry))
      .sort(),
  );
}
