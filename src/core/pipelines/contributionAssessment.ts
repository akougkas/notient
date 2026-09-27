import type { NoteReadResult, NoteReference, SourceReference } from "../../api/schema";
import { intelligenceRecordId, parseAllIntelligenceRecords } from "../intelligence";
import type { IntelligenceRecord } from "../intelligence/types";

export interface RetainedContributionCandidate {
  recordId: string;
  target: NoteReference;
  record: IntelligenceRecord;
  evidence: SourceReference[];
  reboundEvidence: boolean;
}

export type CurrentContributionEvidenceResolver = (
  reference: SourceReference,
) => Promise<SourceReference | null>;

const maximumCandidates = 4;
const maximumExaminedCandidates = 16;
const maximumEvidencePerCandidate = 6;
const maximumEvidenceCharacters = 12000;
const maximumEvidenceReferences = 24;
const maximumCandidateInputCharacters = 16000;

export async function collectRetainedContributionCandidates(
  selected: readonly NoteReadResult[],
  resolveCurrentEvidence: CurrentContributionEvidenceResolver,
): Promise<RetainedContributionCandidate[]> {
  const candidates: RetainedContributionCandidate[] = [];
  const seenRecordIds = new Set<string>();
  let evidenceCharacters = 0;
  let candidateInputCharacters = 0;
  let examinedCandidates = 0;
  let resolvedReferences = 0;
  for (const target of selected) {
    const records = parseAllIntelligenceRecords(target.body);
    const existingAssessments = new Map<string, IntelligenceRecord[]>();
    for (const record of records) {
      if (record.assessmentOf === undefined) continue;
      const prior = existingAssessments.get(record.assessmentOf) ?? [];
      prior.push(record);
      existingAssessments.set(record.assessmentOf, prior);
    }
    for (const record of [...records].reverse()) {
      if (
        !record.capturedContribution ||
        record.kind !== "finding" ||
        record.status !== "provisional" ||
        record.evidence.length === 0 ||
        record.evidence.length > maximumEvidencePerCandidate
      )
        continue;
      if (
        record.evidence.some(
          (entry) => entry.relation !== "reports" || entry.assessment !== "source-assertion",
        )
      )
        continue;
      const recordId = intelligenceRecordId(record);
      const targetIdentity = JSON.stringify([target.note.path, recordId]);
      if (seenRecordIds.has(targetIdentity)) continue;
      seenRecordIds.add(targetIdentity);
      const capturedEvidenceIdentity = new Set(
        record.evidence.map((entry) => JSON.stringify([entry.source.path, entry.source.quote])),
      );
      if (hasPriorAssessment(existingAssessments.get(recordId), capturedEvidenceIdentity)) continue;
      if (
        candidates.length >= maximumCandidates ||
        examinedCandidates >= maximumExaminedCandidates
      )
        break;
      examinedCandidates += 1;
      const uniqueEvidence = new Map<string, SourceReference>();
      for (const entry of record.evidence) {
        const key = JSON.stringify([entry.source.path, entry.source.quote]);
        uniqueEvidence.set(key, entry.source);
      }
      const requiredCharacters = [...uniqueEvidence.values()].reduce(
        (sum, source) => sum + source.quote.length,
        0,
      );
      if (
        uniqueEvidence.size === 0 ||
        uniqueEvidence.size > maximumEvidencePerCandidate ||
        evidenceCharacters + requiredCharacters > maximumEvidenceCharacters ||
        candidateInputCharacters + requiredCharacters + record.statement.length >
          maximumCandidateInputCharacters ||
        resolvedReferences + uniqueEvidence.size > maximumEvidenceReferences
      )
        continue;
      resolvedReferences += uniqueEvidence.size;
      const evidence: SourceReference[] = [];
      let complete = true;
      let reboundEvidence = false;
      for (const source of uniqueEvidence.values()) {
        const current = await resolveCurrentEvidence(source);
        if (!current) {
          complete = false;
          break;
        }
        reboundEvidence ||= current.revision !== source.revision;
        evidence.push(current);
      }
      if (!complete || evidence.length !== uniqueEvidence.size) continue;
      const currentEvidenceIdentity = new Set(
        evidence.map((source) => JSON.stringify([source.path, source.quote])),
      );
      if (hasPriorAssessment(existingAssessments.get(recordId), currentEvidenceIdentity))
        continue;
      evidenceCharacters += requiredCharacters;
      candidateInputCharacters += requiredCharacters + record.statement.length;
      candidates.push({ recordId, target: target.note, record, evidence, reboundEvidence });
    }
    if (
      candidates.length >= maximumCandidates ||
      examinedCandidates >= maximumExaminedCandidates
    )
      break;
  }
  return candidates;
}

function hasPriorAssessment(
  assessments: readonly IntelligenceRecord[] | undefined,
  evidenceIdentity: ReadonlySet<string>,
): boolean {
  return assessments?.some(
    (assessment) =>
      assessment.status !== "superseded" &&
      assessment.evidence.length > 0 &&
      assessment.evidence.every((entry) =>
        evidenceIdentity.has(JSON.stringify([entry.source.path, entry.source.quote])),
      ),
  ) ?? false;
}
