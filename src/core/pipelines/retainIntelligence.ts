import type { PipelinePlan } from "../../api/pipelines";
import type { IntelligenceRecord } from "../intelligence/types";
import {
  changedIntelligenceDependencies,
  feedbackSuppresses,
  intelligenceRecordId,
  intelligenceSuppressionSubject,
  parseAllIntelligenceRecords,
  prepareIntelligenceAppend,
} from "../intelligence";
import type { PipelineContext } from "./context";
import { assessPipelineFinding } from "./intelligenceAssessment";

export function retainPipelineIntelligence(context: PipelineContext, plan: PipelinePlan): void {
  if (plan.pipeline === "index-extract" || plan.pipeline === "archive") return;
  const section = context.options.policy.allowedSections[0] ?? "Notient understanding";
  const retained: PipelinePlan["changes"] = [];
  const currentSources = context.documents.map((document) => ({
    path: document.note.path,
    revision: document.note.revision,
    body: document.body,
  }));
  for (const note of context.selected) {
    const existing = parseAllIntelligenceRecords(note.body);
    const findings = plan.findings
      .filter((finding) => {
        if (finding.kind === "metadata") return false;
        if (finding.assessmentOf !== undefined && finding.target === undefined) return false;
        if (finding.target !== undefined) {
          const destination = context.selected.find(
            (candidate) => candidate.note.path === finding.target?.path,
          );
          if (
            !destination ||
            destination.note.revision !== finding.target.revision ||
            destination.note.path !== note.note.path
          )
            return false;
          if (finding.assessmentOf !== undefined) {
            return existing.some(
              (record) =>
                record.capturedContribution === true &&
                intelligenceRecordId(record) === finding.assessmentOf,
            );
          }
          return true;
        }
        return finding.evidence.some((source) => source.path === note.note.path);
      })
      .slice(0, 6);
    const records: IntelligenceRecord[] = findings.map((finding) => {
      const relationships = plan.relationships
        .filter((relationship) =>
          relationship.rationale === finding.explanation &&
          [relationship.source.path, relationship.target.path].includes(note.note.path),
        )
        .map((relationship) => ({
          target: relationship.source.path === note.note.path
            ? relationship.target.path
            : relationship.source.path,
          relation: relationship.relation,
          meaning: `${relationship.source.path} ${relationship.relation} ${relationship.target.path}: ${relationship.rationale}`,
          provenance: "inferred" as const,
          evidence: relationship.evidence,
        }));
      const dependencies = new Map(finding.evidence.map((source) => [source.path, { path: source.path, revision: source.revision }]));
      const assessment = assessPipelineFinding(finding, context.documents, relationships.length > 0);
      const assessedContribution = finding.assessmentOf === undefined
        ? undefined
        : existing.find(
            (record) =>
              record.capturedContribution === true &&
              intelligenceRecordId(record) === finding.assessmentOf,
          );
      const contributionQualifications = assessedContribution
        ? [
            `Automated evidence assessment of retained contribution record ${finding.assessmentOf}.`,
            `Original authenticated contributor: ${assessedContribution.attribution.kind} — ${assessedContribution.attribution.label} (${assessedContribution.attribution.id}); this attribution identifies the submitter and grants no authority or evidentiary status.`,
            ...assessedContribution.qualifications,
            ...(assessedContribution.evidence.some((entry) =>
              finding.evidence.some(
                (source) =>
                  source.path === entry.source.path &&
                  source.quote === entry.source.quote &&
                  source.revision !== entry.source.revision,
              ),
            )
              ? [
                  "A cited source revision changed; the exact quotation was uniquely rebound in current authored text, and this assessment applies only to that quotation in its current context.",
                ]
              : []),
          ]
        : [];
      return {
        ...assessment,
        ...(finding.assessmentOf === undefined ? {} : { assessmentOf: finding.assessmentOf }),
        attribution: { kind: "agent", id: `pipeline-${plan.pipeline}`, label: `Notient ${plan.pipeline} visitor` },
        qualifications: [
          ...new Set([
            ...assessment.qualifications,
            ...contributionQualifications,
            ...context.contextLimitations(),
          ]),
        ].slice(0, 20),
        relationships,
        dependencies: [...dependencies.values()],
        feedback: null,
      };
    });
    if (!records.length) continue;
    const deferredRelevant =
      context.options.deferredRelevanceReason !== undefined &&
      context.options.deferredRelevancePaths?.includes(note.note.path) === true;
    const feedback = existing
      .filter((record) => record.kind === "feedback" && record.feedback !== null)
      .map((record) => {
        const dependencies = changedIntelligenceDependencies(record, currentSources);
        return {
          value: record.feedback,
          changedPaths: dependencies
            .filter((dependency) => dependency.currentRevision !== null && dependency.changedEvidence.length > 0)
            .map((dependency) => dependency.path),
        };
      })
      .filter((record): record is { value: NonNullable<IntelligenceRecord["feedback"]>; changedPaths: string[] } => record.value !== null);
    const eligible = records.filter((record) => {
      const subject = intelligenceSuppressionSubject(record);
      return !feedback.some(
        (entry) =>
          entry.value !== null &&
          feedbackSuppresses(
            entry.value,
            subject,
            entry.changedPaths,
            deferredRelevant,
          ),
      );
    });
    if (!eligible.length) continue;
    const append = prepareIntelligenceAppend(note.body, section, eligible);
    if (append.text) retained.push({ kind: "append", source: note.note, text: append.text });
  }
  plan.changes.unshift(...retained);
}
