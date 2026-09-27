import { sourceRange } from "../../api/notes";
import type { PipelineFinding } from "../../api/pipelines";
import type { NoteReadResult, SourceReference } from "../../api/schema";
import type { IntelligenceEvidence, IntelligenceKind, IntelligenceStatus } from "../intelligence/types";

export interface PipelineIntelligenceAssessment {
  kind: IntelligenceKind;
  status: IntelligenceStatus;
  statement: string;
  evidence: IntelligenceEvidence[];
  qualifications: string[];
}

function exactAuthoredEvidence(source: SourceReference, documents: readonly NoteReadResult[]): boolean {
  const document = documents.find((candidate) => candidate.note.path === source.path);
  if (!document || document.note.revision !== source.revision) return false;
  const { start, end } = source.range;
  if (start < 0 || end <= start || end > document.body.length) return false;
  const actualRange = sourceRange(document.body, start, end);
  if (
    actualRange.startLine !== source.range.startLine ||
    actualRange.endLine !== source.range.endLine ||
    document.body.slice(start, end) !== source.quote
  ) return false;
  for (const match of document.body.matchAll(
    /<!-- notient-intelligence:v1:start:[\s\S]*?<!-- notient-intelligence:v1:end:i-[a-f0-9]{64} -->/gu,
  )) {
    const retainedStart = match.index ?? 0;
    const retainedEnd = retainedStart + match[0].length;
    if (start < retainedEnd && end > retainedStart) return false;
  }
  return true;
}

export function assessPipelineFinding(
  finding: PipelineFinding,
  documents: readonly NoteReadResult[],
  retainAsRelationship: boolean,
): PipelineIntelligenceAssessment {
  const exactEvidence = finding.evidence.every((source) => exactAuthoredEvidence(source, documents));
  const matchingAssessment =
    exactEvidence &&
    finding.evidenceScope !== undefined &&
    finding.evidenceAssessment !== undefined &&
    finding.evidenceScope === finding.evidenceAssessment &&
    finding.evidenceAssessment !== "interpretation" &&
    finding.evidenceScope !== "interpretation" &&
    finding.epistemic !== "interpretation";
  const eligibleSummary =
    (finding.kind === "summary" || (finding.kind === "claim" && finding.assessmentOf !== undefined)) &&
    !retainAsRelationship &&
    finding.epistemic !== "interpretation" &&
    finding.epistemic !== "decision";
  const sourceReportPrefix = "The cited source reports: ";
  const sourceReportFits = finding.explanation.length + sourceReportPrefix.length <= 8000;
  const sourceReport =
    eligibleSummary && matchingAssessment && finding.evidenceScope === "source-report" && sourceReportFits;
  const directSupport =
    eligibleSummary && matchingAssessment && finding.evidenceScope === "direct-support";
  const sourceReportTooLong =
    eligibleSummary && matchingAssessment && finding.evidenceScope === "source-report" && !sourceReportFits;
  const classificationDisagrees =
    finding.evidenceScope !== undefined &&
    finding.evidenceAssessment !== undefined &&
    finding.evidenceScope !== finding.evidenceAssessment;
  const interpretation =
    finding.evidenceScope === "interpretation" ||
    finding.evidenceAssessment === "interpretation" ||
    finding.epistemic === "interpretation";
  const kind: IntelligenceKind = finding.kind === "question"
    ? "question"
    : retainAsRelationship
      ? "relationship"
      : finding.epistemic === "decision"
        ? "decision"
        : interpretation
          ? "interpretation"
          : "finding";
  const statement = sourceReport
    ? `${sourceReportPrefix}${finding.explanation}`
    : finding.explanation;
  const evidence: IntelligenceEvidence[] = finding.evidence.map((source) => {
    if (sourceReport) return { source, relation: "reports", assessment: "source-assertion" };
    if (directSupport) return { source, relation: "supports", assessment: "direct" };
    if (finding.evidenceScope === undefined && exactEvidence)
      return { source, relation: "reports", assessment: "source-assertion" };
    return { source, relation: "supports", assessment: "unverified" };
  });
  let assessmentQualification: string;
  if (sourceReport) {
    assessmentQualification =
      "The retained statement is scoped to the cited source's report and its stated time and scope; it does not establish the underlying assertion, source independence, or external verification.";
  } else if (directSupport) {
    assessmentQualification =
      "A separate semantic assessment found that the cited passage directly supports this bounded claim within its stated context, time, and scope; source independence and external verification are not established.";
  } else if (interpretation) {
    assessmentQualification = "This is an interpretation of the cited material and remains provisional.";
  } else if (finding.epistemic === "decision") {
    assessmentQualification =
      "This source-grounded decision description remains provisional and does not create or confirm an operator decision.";
  } else if (sourceReportTooLong) {
    assessmentQualification =
      "The source-report statement exceeds the retained statement limit when explicitly scoped, so it remains provisional.";
  } else if (classificationDisagrees || (finding.evidenceScope === undefined && finding.evidenceAssessment !== undefined)) {
    assessmentQualification =
      "The proposed scope and separate semantic assessment do not agree or are incomplete; the finding remains provisional.";
  } else if (!exactEvidence) {
    assessmentQualification =
      "Current source bytes did not verify every cited range and quotation in authored content; the finding remains provisional and unverified.";
  } else if (retainAsRelationship) {
    assessmentQualification =
      "This is an inferred connection between the cited passages and remains provisional. Exact quotations preserve the evidence considered; they do not independently establish or verify the relationship.";
  } else if (finding.evidenceAssessment === undefined) {
    assessmentQualification =
      "No separate semantic assessment of this bounded claim is retained; the finding remains provisional.";
  } else if (!eligibleSummary) {
    assessmentQualification = "This is not an adoptable factual summary and remains provisional.";
  } else {
    assessmentQualification = "The finding remains provisional.";
  }
  const qualifications = [assessmentQualification, ...(finding.qualifications ?? [])].slice(0, 20);
  return {
    kind,
    status: sourceReport || directSupport ? "supported" : finding.kind === "question" ? "open" : "provisional",
    statement,
    evidence,
    qualifications,
  };
}
