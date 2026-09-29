import { z } from "zod";
import type {
  PipelineFinding,
  PipelinePlan,
  PipelineReconsiderationAssessment,
} from "../../api/pipelines";
import { sourceRange } from "../../api/notes";
import { scopeAllows } from "../../api/scope";
import { NoteApiError, type NoteReadResult, type NoteReference, type SourceReference } from "../../api/schema";
import {
  changedIntelligenceDependencies,
  intelligenceRecordId,
  intelligenceSuppressionSubject,
  parseAllIntelligenceRecords,
  prepareIntelligenceAppend,
  withoutRetainedIntelligence,
  type IntelligenceRecord,
} from "../intelligence";
import type { PipelineContext } from "./context";

const maxNewQuestions = 12;
export const MAX_CONTEXT_RECHECK_CANDIDATES = 4;
const maxContextPassages = 8;
const maxContextPassageCharacters = 700;

const contextAssessmentSchema = z
  .object({
    assessments: z
      .array(
        z
          .object({
            candidateIndex: z.number().int().min(0).max(MAX_CONTEXT_RECHECK_CANDIDATES - 1),
            outcome: z.enum(["material-context-change", "no-material-change", "unresolved"]),
            passageIndexes: z.array(z.number().int().min(0).max(maxContextPassages - 1)).max(maxContextPassages),
            rationale: z.string().trim().min(1).max(1200),
          })
          .strict(),
      )
      .max(MAX_CONTEXT_RECHECK_CANDIDATES),
  })
  .strict();

interface ReconsiderationCandidate {
  note: NoteReadResult;
  record: IntelligenceRecord;
  recordId: string;
  retained: IntelligenceRecord[];
}

interface ContextPassage {
  reference: SourceReference;
}

interface ContextRecheck {
  candidate: ReconsiderationCandidate;
  changes: ReturnType<typeof changedIntelligenceDependencies>;
  passages: ContextPassage[];
  priorEvidence: Array<{ path: string; quote: string }>;
  priorFeedback: { reason: string; target: string; explanation: string } | null;
}

interface PendingAppend {
  note: NoteReadResult;
  updates: IntelligenceRecord[];
  findings: Array<{ record: IntelligenceRecord; finding: PipelineFinding }>;
}

export function hasQuestionForRecord(records: readonly IntelligenceRecord[], recordId: string): boolean {
  const target = `This qualifies retained record ${recordId}; it does not establish that the conclusion is false.`;
  return records.some(
    (record) =>
      record.kind === "question" &&
      record.attribution.kind === "software" &&
      ["notient-source-reconsideration", "notient-deletion"].includes(record.attribution.id) &&
      record.qualifications.includes(target),
  );
}

function changedSources(context: PipelineContext, record: IntelligenceRecord, confirmedMissing: ReadonlySet<string>) {
  const observed = new Set(context.documents.map((source) => source.note.path));
  return changedIntelligenceDependencies(
    record,
    context.documents.map((source) => ({
      path: source.note.path,
      revision: source.note.revision,
      body: source.body,
    })),
  )
    .filter(
      (change) =>
        (observed.has(change.path) || confirmedMissing.has(change.path)) &&
        (change.currentRevision === null || change.revisionChanged),
    )
    .slice(0, 20);
}

function questionForCandidate(
  context: PipelineContext,
  candidate: ReconsiderationCandidate,
  changes: ReturnType<typeof changedSources>,
  confirmedMissing: ReadonlySet<string>,
): { record: IntelligenceRecord; finding: PipelineFinding } | null {
  if (!changes.length) return null;
  const paths = changes.map((change) => change.path);
  const dependencies = context.documents
    .filter((source) => paths.includes(source.note.path))
    .map((source) => source.note);
  const currentEvidence = [candidate.note, ...context.documents.filter((source) => paths.includes(source.note.path))]
    .filter((source) => source.body.length > 0)
    .slice(0, 30)
    .flatMap((source) => {
      const marker = source.body.indexOf("<!-- notient-intelligence:");
      let end = Math.min(1000, marker < 0 ? source.body.length : marker);
      if (/[\uD800-\uDBFF]/u.test(source.body[end - 1] ?? "")) end--;
      return end > 0 && source.body.slice(0, end).trim()
        ? [{ ...source.note, quote: source.body.slice(0, end), range: sourceRange(source.body, 0, end) }]
        : [];
    });
  const finding: PipelineFinding = {
    kind: "question",
    title: `Reconsider understanding in ${candidate.note.note.path}`.slice(0, 300),
    explanation: `Supporting evidence changed or became unavailable in ${paths.join(", ").slice(0, 1800)}. Reassess the retained finding without treating this as proof of falsity: ${candidate.record.statement.slice(0, 5000)}`,
    evidence: currentEvidence,
    epistemic: "interpretation",
    qualifications: ["The source comparison found a retained quotation missing or a dependency unavailable."],
  };
  const record: IntelligenceRecord = {
    kind: "question",
    status: "open",
    statement: `Reconsider retained understanding${candidate.record.statement.length > 7800 ? " (excerpt)" : ""}: ${candidate.record.statement.slice(0, 7800)}`,
    attribution: { kind: "software", id: "notient-source-reconsideration", label: "Notient source comparison" },
    evidence: [],
    qualifications: [
      `Supporting evidence changed or became unavailable. The earlier finding is historical and needs fresh assessment. Sources: ${paths.join(", ").slice(0, 1800)}${paths.some((path) => confirmedMissing.has(path)) ? ". A source reported missing by the vault read was unavailable; this does not prove the retained statement false." : ""}`,
      `This qualifies retained record ${candidate.recordId}; it does not establish that the conclusion is false.`,
      ...(candidate.record.kind === "decision"
        ? ["Preserve the historical decision and its context; changed evidence is a reason to review its continuing applicability."]
        : []),
    ],
    relationships: paths.map((target) => ({
      target,
      meaning: "Supporting evidence changed; inspect this source before relying on the earlier finding.",
      provenance: "inferred",
      evidence: [],
    })),
    dependencies: [...new Map(dependencies.map((dependency) => [dependency.path, dependency])).values()],
    feedback: null,
  };
  return { record, finding };
}

function recordSourcePaths(record: IntelligenceRecord): string[] {
  return [
    ...record.dependencies.map((source) => source.path),
    ...record.evidence.map((entry) => entry.source.path),
    ...record.relationships.flatMap((relationship) => relationship.evidence.map((source) => source.path)),
  ].filter((path, index, paths) => paths.indexOf(path) === index);
}

function recordEvidenceForPath(record: IntelligenceRecord, path: string): Array<{ path: string; quote: string }> {
  return [
    ...record.evidence
      .filter((entry) => entry.source.path === path)
      .map((entry) => ({ path, quote: entry.source.quote })),
    ...record.relationships.flatMap((relationship) =>
      relationship.evidence
        .filter((entry) => entry.path === path)
        .map((entry) => ({ path, quote: entry.quote })),
    ),
  ].filter(
    (entry, index, entries) =>
      entries.findIndex((other) => other.path === entry.path && other.quote === entry.quote) === index,
  );
}

function uniqueOccurrences(text: string, quote: string): Array<{ start: number; end: number }> {
  if (!quote) return [];
  const found: Array<{ start: number; end: number }> = [];
  let offset = 0;
  while (offset <= text.length) {
    const start = text.indexOf(quote, offset);
    if (start < 0) break;
    found.push({ start, end: start + quote.length });
    if (found.length > 1) break;
    offset = start + 1;
  }
  return found;
}

function lexicalTerms(text: string): Set<string> {
  return new Set(
    text
      .normalize("NFKC")
      .toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{N}]{4,}/gu) ?? [],
  );
}

function trimRange(text: string, start: number, end: number): { start: number; end: number } | null {
  while (start < end && /\s/u.test(text[start] ?? "")) start++;
  while (end > start && /\s/u.test(text[end - 1] ?? "")) end--;
  if (start >= end) return null;
  return { start, end };
}

function paragraphRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const match of text.matchAll(/\r?\n[\t ]*\r?\n/gu)) {
    const end = match.index ?? start;
    const trimmed = trimRange(text, start, end);
    if (trimmed) ranges.push(trimmed);
    start = end + match[0].length;
  }
  const trimmed = trimRange(text, start, text.length);
  if (trimmed) ranges.push(trimmed);
  return ranges;
}

function passageReferences(
  note: NoteReadResult,
  excludedQuotes: readonly string[],
  statement: string,
  maximum: number,
): SourceReference[] {
  if (maximum < 1) return [];
  const authored = withoutRetainedIntelligence(note.body);
  const excluded: Array<{ start: number; end: number }> = [];
  for (const quote of excludedQuotes) {
    const matches = uniqueOccurrences(authored, quote);
    if (matches.length !== 1) return [];
    excluded.push(matches[0]!);
  }
  const sortedExcluded = [...excluded].sort((left, right) => left.start - right.start);
  const terms = lexicalTerms(statement);
  const candidates: Array<{ start: number; end: number }> = [];
  for (const paragraph of paragraphRanges(authored).slice(-300)) {
    let cursor = paragraph.start;
    for (const range of sortedExcluded) {
      if (range.end <= cursor || range.start >= paragraph.end) continue;
      const before = trimRange(authored, cursor, Math.min(range.start, paragraph.end));
      if (before) candidates.push(...splitPassageRange(authored, before.start, before.end));
      cursor = Math.max(cursor, range.end);
    }
    const after = trimRange(authored, cursor, paragraph.end);
    if (after) candidates.push(...splitPassageRange(authored, after.start, after.end));
  }
  const scored = candidates
    .map((range) => {
      const content = authored.slice(range.start, range.end);
      const overlap = [...lexicalTerms(content)].filter((term) => terms.has(term)).length;
      const tailBias = range.end >= authored.length - 2400 ? 0.25 : 0;
      return { ...range, score: overlap + tailBias };
    })
    .sort((left, right) => right.score - left.score || right.end - left.end || left.start - right.start)
    .slice(0, maximum)
    .sort((left, right) => left.start - right.start);
  return scored.flatMap((range) => {
    const quote = note.body.slice(range.start, range.end);
    if (
      !quote.trim() ||
      authored.slice(range.start, range.end) !== quote ||
      withoutRetainedIntelligence(quote) !== quote
    )
      return [];
    return [{
      ...note.note,
      range: sourceRange(note.body, range.start, range.end),
      quote,
    }];
  });
}

function splitPassageRange(text: string, start: number, end: number): Array<{ start: number; end: number }> {
  const result: Array<{ start: number; end: number }> = [];
  for (let cursor = start; cursor < end; ) {
    let next = Math.min(end, cursor + maxContextPassageCharacters);
    if (next < end && /[\uD800-\uDBFF]/u.test(text[next - 1] ?? "")) next--;
    const trimmed = trimRange(text, cursor, next);
    if (trimmed) result.push(trimmed);
    cursor = next;
  }
  return result;
}

function matchingFeedback(
  record: IntelligenceRecord,
  records: readonly IntelligenceRecord[],
): { reason: string; target: string; explanation: string } | null {
  let targetKey: string;
  try {
    targetKey = intelligenceSuppressionSubject(record);
  } catch {
    return null;
  }
  const feedback = [...records].reverse().find(
    (entry) => entry.kind === "feedback" && entry.feedback?.targetKey === targetKey,
  );
  return feedback?.feedback
    ? {
        reason: feedback.feedback.reason,
        target: feedback.feedback.target.slice(0, 1000),
        explanation: feedback.feedback.explanation.slice(0, 1200),
      }
    : null;
}

function contextualChangesFor(
  context: PipelineContext,
  candidate: ReconsiderationCandidate,
  changes: ReturnType<typeof changedSources>,
): ReturnType<typeof changedSources> {
  const coveredPaths = new Set(
    (context.options.priorReconsiderationAssessments ?? [])
      .filter(
        (assessment) =>
          assessment.recordId === candidate.recordId &&
          assessment.target.path === candidate.note.note.path &&
          assessment.target.revision === candidate.note.note.revision &&
          assessment.outcome !== "material-context-change" &&
          assessment.sourceRevisions.every((reference) =>
            context.documents.some(
              (document) =>
                document.note.path === reference.path &&
                document.note.revision === reference.revision,
            ),
          ),
      )
      .flatMap((assessment) => assessment.sourceRevisions.map((source) => source.path)),
  );
  const relevant = changes.filter(
    (change) =>
      change.currentRevision !== null &&
      change.revisionChanged &&
      change.changedEvidence.length === 0 &&
      !coveredPaths.has(change.path),
  );
  return relevant;
}

function contextRechecks(
  context: PipelineContext,
  candidate: ReconsiderationCandidate,
  changes: ReturnType<typeof changedSources>,
): ContextRecheck | null {
  const relevant = contextualChangesFor(context, candidate, changes);
  if (!relevant.length) return null;
  const passages: ContextPassage[] = [];
  const priorEvidence: Array<{ path: string; quote: string }> = [];
  const perSource = Math.max(1, Math.floor(maxContextPassages / Math.min(relevant.length, 4)));
  for (const change of relevant.slice(0, 4)) {
    const source = context.documents.find((document) => document.note.path === change.path);
    if (!source || source.note.revision !== change.currentRevision) continue;
    const evidence = recordEvidenceForPath(candidate.record, change.path);
    for (const entry of evidence.slice(0, 4)) {
      const authored = withoutRetainedIntelligence(source.body);
      if (uniqueOccurrences(authored, entry.quote).length === 1)
        priorEvidence.push(entry);
    }
    const references = passageReferences(
      source,
      evidence.map((entry) => entry.quote),
      candidate.record.statement,
      perSource,
    );
    passages.push(...references.map((reference) => ({ reference })));
  }
  const supplied = passages.slice(0, maxContextPassages);
  if (!supplied.length) return null;
  const suppliedPaths = new Set(supplied.map(({ reference }) => reference.path));
  return {
    candidate,
    changes: relevant.filter((change) => suppliedPaths.has(change.path)),
    passages: supplied,
    priorEvidence: priorEvidence.filter((entry) => suppliedPaths.has(entry.path)).slice(0, 12),
    priorFeedback: matchingFeedback(candidate.record, candidate.retained),
  };
}

function addAssessmentReceipt(
  plan: PipelinePlan,
  candidate: ReconsiderationCandidate,
  outcome: PipelineReconsiderationAssessment["outcome"],
  sourceRevisions: readonly NoteReference[],
): void {
  const current = plan.reconsiderationAssessments ?? [];
  if (current.length >= 20) return;
  const byPath = new Map<string, NoteReference>([[candidate.note.note.path, candidate.note.note]]);
  for (const source of sourceRevisions) {
    const previous = byPath.get(source.path);
    if (previous && previous.revision !== source.revision) return;
    byPath.set(source.path, source);
  }
  plan.reconsiderationAssessments = [
    ...current,
    {
      recordId: candidate.recordId,
      target: candidate.note.note,
      sourceRevisions: [...byPath.values()],
      outcome,
    },
  ];
}

function assessmentSourceRevisions(recheck: ContextRecheck): NoteReference[] {
  return [...new Map(
    recheck.passages.map(({ reference }) => [reference.path, {
      path: reference.path,
      revision: reference.revision,
    }]),
  ).values()];
}

function contextQuestion(
  recheck: ContextRecheck,
  assessment: z.infer<typeof contextAssessmentSchema>["assessments"][number],
): { record: IntelligenceRecord; finding: PipelineFinding } | null {
  const indexes = [...new Set(assessment.passageIndexes)];
  if (!indexes.length || indexes.some((index) => index >= recheck.passages.length)) return null;
  const evidence = indexes.map((index) => recheck.passages[index]!.reference);
  if (!evidence.length || evidence.some((reference) => !reference.quote || reference.revision.length !== 64))
    return null;
  const sourcePaths = [...new Set(evidence.map((reference) => reference.path))];
  const dependencies = [...new Map(
    sourcePaths.flatMap((path) => {
      const reference = evidence.find((entry) => entry.path === path)!;
      return [[path, { path, revision: reference.revision }] as const];
    }),
  ).values()];
  const explanation = `A bounded semantic recheck found current authored context materially relevant to retained understanding. ${assessment.rationale}`.slice(0, 8000);
  const finding: PipelineFinding = {
    kind: "question",
    title: `Reassess retained understanding: ${recheck.candidate.record.statement}`.slice(0, 300),
    explanation,
    evidence,
    epistemic: "interpretation",
    qualifications: [
      "This is a bounded relevance assessment of current authored passages, not a before-and-after diff or external verification.",
      "The current passages do not establish that their text was newly added or that the earlier record is false.",
    ],
  };
  const record: IntelligenceRecord = {
    kind: "question",
    status: "open",
    statement: `Reassess retained understanding in light of current authored context: ${recheck.candidate.record.statement}`.slice(0, 8000),
    attribution: { kind: "software", id: "notient-source-reconsideration", label: "Notient source comparison" },
    evidence: evidence.map((source) => ({
      source,
      relation: "qualifies",
      assessment: "unverified",
    })),
    qualifications: [
      `A bounded semantic recheck found these current passages materially relevant: ${assessment.rationale}`.slice(0, 2000),
      "The passages are current authored context, not a before-and-after diff. They do not prove the earlier understanding false or externally verify it.",
      `This qualifies retained record ${recheck.candidate.recordId}; it does not establish that the conclusion is false.`,
      ...(recheck.candidate.record.kind === "decision"
        ? ["Preserve the historical decision and its context; review its continuing applicability without rewriting it."]
        : []),
      ...(recheck.priorFeedback
        ? [`Prior ${recheck.priorFeedback.reason} feedback remains recorded and unchanged: ${recheck.priorFeedback.explanation}`.slice(0, 2000)]
        : []),
    ],
    relationships: sourcePaths.map((target) => ({
      target,
      meaning: "Current authored context may qualify this retained understanding; inspect the cited passage before relying on it.",
      provenance: "inferred",
      evidence: evidence.filter((source) => source.path === target),
    })),
    dependencies,
    feedback: null,
  };
  return { record, finding };
}

async function assessCurrentContext(
  context: PipelineContext,
  plan: PipelinePlan,
  candidates: ContextRecheck[],
  retain: (candidate: ReconsiderationCandidate, result: { record: IntelligenceRecord; finding: PipelineFinding }) => void,
): Promise<void> {
  if (!candidates.length) return;
  if (context.options.policy.budget.modelCalls < 1 || context.options.policy.budget.tokens < 1) {
    plan.reconsiderationDeferred = "capacity";
    context.retrievalLimitations.add(
      "A contextual recheck was deferred because this policy has no model-call or token budget; retained understanding and feedback remain unchanged.",
    );
    return;
  }
  const bounded = candidates.slice(0, Math.min(MAX_CONTEXT_RECHECK_CANDIDATES, context.options.policy.budget.candidates));
  if (candidates.length > bounded.length)
    context.retrievalLimitations.add("Additional contextual rechecks were deferred by the configured candidate budget.");
  const taskCandidates = bounded.map((candidate, candidateIndex) => ({
    candidateIndex,
    note: candidate.candidate.note.note.path,
    recordId: candidate.candidate.recordId,
    statement: candidate.candidate.record.statement,
    epistemicStatus: candidate.candidate.record.status,
    priorEvidence: candidate.priorEvidence.map((entry) => entry),
    priorFeedback: candidate.priorFeedback,
    changedSourcePaths: candidate.changes.map((change) => change.path),
    currentAuthoredPassages: candidate.passages.map((passage, passageIndex) => ({
      passageIndex,
      path: passage.reference.path,
      revision: passage.reference.revision,
      quote: passage.reference.quote,
    })),
  }));
  const instructions =
    "For each fixed candidate, decide whether any supplied current authored passage materially changes the context for assessing the exact retained statement: material-context-change, no-material-change, or unresolved. A whole-note revision change is only a trigger for this recheck, never evidence of changed support by itself. Current passages are not a before-and-after diff; do not infer that they were newly added. Compare them with the supplied prior exact quotations when present. A source with no prior quotation has no quoted baseline, so use unresolved unless a bounded relevance judgment is supported by the passages. Prior feedback is historical human guidance, not evidence or authority; leave its status unchanged and do not reopen it merely because a revision changed. Return indexes only for exact currentAuthoredPassages in that same candidate. A material-context-change requires at least one passage index that directly supports why the current context is relevant; no-material-change and unresolved should return an empty passageIndexes array. Do not declare the retained statement true or false, externally verify a source, or propose a replacement claim. Give a short reason grounded only in the selected passages. Describe the cited source and substantive conditions in ordinary language; do not mention candidate indexes, passage indexes, or other internal identifiers.";
  let result: z.infer<typeof contextAssessmentSchema>;
  try {
    result = await context.model(
      "reassess-retained-context",
      instructions,
      contextAssessmentSchema,
      { candidates: taskCandidates },
      { taskOnly: true },
    );
  } catch (error) {
    context.options.signal.throwIfAborted();
    if (error instanceof NoteApiError && error.code === "LIMIT_EXCEEDED") {
      plan.reconsiderationDeferred = "capacity";
      context.retrievalLimitations.add(
        "The configured run budget could not admit a complete contextual recheck; retained understanding and feedback remain unchanged.",
      );
      return;
    }
    throw error;
  }
  const grouped = new Map<number, typeof result.assessments>();
  for (const assessment of result.assessments) {
    const group = grouped.get(assessment.candidateIndex) ?? [];
    group.push(assessment);
    grouped.set(assessment.candidateIndex, group);
  }
  for (const [candidateIndex, assessments] of grouped) {
    if (assessments.length !== 1) {
      plan.reconsiderationDeferred = "assessment";
      context.retrievalLimitations.add("A contextual assessment returned conflicting duplicate candidate indexes; those results were ignored.");
      continue;
    }
    const assessment = assessments[0]!;
    const candidate = bounded[candidateIndex];
    if (!candidate) {
      plan.reconsiderationDeferred = "assessment";
      context.retrievalLimitations.add("A contextual assessment referenced an unknown candidate; that result was ignored.");
      continue;
    }
    if (assessment.outcome === "no-material-change") {
      if (assessment.passageIndexes.length) {
        plan.reconsiderationDeferred = "assessment";
        context.retrievalLimitations.add("A no-material assessment referenced passages unexpectedly; its result was ignored.");
        continue;
      }
      addAssessmentReceipt(plan, candidate.candidate, assessment.outcome, assessmentSourceRevisions(candidate));
      continue;
    }
    if (assessment.outcome === "unresolved") {
      if (assessment.passageIndexes.length) {
        plan.reconsiderationDeferred = "assessment";
        context.retrievalLimitations.add("An unresolved assessment referenced passages unexpectedly; its result was ignored.");
        continue;
      }
      addAssessmentReceipt(plan, candidate.candidate, assessment.outcome, assessmentSourceRevisions(candidate));
      context.retrievalLimitations.add("A bounded contextual recheck was inconclusive; the retained record and prior feedback remain unchanged.");
      continue;
    }
    const question = contextQuestion(candidate, assessment);
    if (!question) {
      plan.reconsiderationDeferred = "assessment";
      context.retrievalLimitations.add("A material contextual assessment lacked valid exact passage support; no note question was retained.");
      continue;
    }
    addAssessmentReceipt(plan, candidate.candidate, assessment.outcome, assessmentSourceRevisions(candidate));
    retain(candidate.candidate, question);
  }
  if (grouped.size < bounded.length) {
    plan.reconsiderationDeferred = "assessment";
    context.retrievalLimitations.add("Some contextual candidates received no assessment result and remain unchanged.");
  }
}

export async function reconsiderPipelineIntelligence(context: PipelineContext, plan: PipelinePlan): Promise<void> {
  if (plan.pipeline === "index-extract" || plan.pipeline === "archive") return;
  const designation = context.options.policy.allowedSections[0] ?? "Notient understanding";
  const affectedCandidates: Array<{ candidate: ReconsiderationCandidate; changes: ReturnType<typeof changedSources> }> = [];
  const pendingSources: ReconsiderationCandidate[] = [];
  const pendingAppend = new Map<string, PendingAppend>();
  const confirmedMissing = new Set<string>();
  const attemptedSourceReads = new Set(context.documents.map((source) => source.note.path));
  const dependencyReadLimit = Math.max(0, context.options.policy.budget.notes - context.documents.length);
  let dependencyReadAttempts = 0;
  let dependencyReadBudgetExhausted = false;
  let newQuestions = 0;
  const affectedKeys = new Set<string>();

  for (const note of context.selected) {
    const retained = parseAllIntelligenceRecords(note.body);
    const seenRecords = new Set<string>();
    for (const record of retained) {
      if (record.kind === "feedback" || record.kind === "question" || record.status === "superseded") continue;
      const recordId = intelligenceRecordId(record);
      if (seenRecords.has(recordId) || hasQuestionForRecord(retained, recordId)) continue;
      seenRecords.add(recordId);
      const candidate = { note, record, recordId, retained };
      const key = `${note.note.path}\u0000${recordId}`;
      const changes = changedSources(context, record, confirmedMissing);
      if (changes.length) {
        affectedCandidates.push({ candidate, changes });
        affectedKeys.add(key);
      }
      else if (
        changedIntelligenceDependencies(
          record,
          context.documents.map((source) => ({
            path: source.note.path,
            revision: source.note.revision,
            body: source.body,
          })),
        ).some((change) => change.currentRevision === null)
      ) {
        pendingSources.push(candidate);
      }
    }
  }

  for (const candidate of pendingSources) {
    if (newQuestions >= maxNewQuestions || dependencyReadBudgetExhausted) break;
    const observed = new Set(context.documents.map((source) => source.note.path));
    for (const path of recordSourcePaths(candidate.record)) {
      if (observed.has(path) || attemptedSourceReads.has(path)) continue;
      if (!scopeAllows({ ...context.options.policy.readScope, tags: [], excludeTags: [] }, path, [])) continue;
      if (dependencyReadAttempts >= dependencyReadLimit) {
        dependencyReadBudgetExhausted = true;
        context.retrievalLimitations.add(
          "Further supporting source checks were deferred by the configured note budget; unavailable sources remain unknown.",
        );
        break;
      }
      dependencyReadAttempts++;
      attemptedSourceReads.add(path);
      try {
        await context.read({ path });
        observed.add(path);
      } catch (error) {
        context.options.signal.throwIfAborted();
        if (error instanceof NoteApiError && error.code === "NOT_FOUND") {
          confirmedMissing.add(path);
          context.retrievalLimitations.add(`Supporting source ${path} no longer exists in the vault.`);
        } else {
          context.retrievalLimitations.add(
            `Supporting source ${path} could not be inspected; its current support remains unknown.`,
          );
        }
      }
    }
    const changes = changedSources(context, candidate.record, confirmedMissing);
    const key = `${candidate.note.note.path}\u0000${candidate.recordId}`;
    if (changes.length && !affectedKeys.has(key)) {
      affectedCandidates.push({ candidate, changes });
      affectedKeys.add(key);
    }
  }

  const deterministic = new Map<string, { candidate: ReconsiderationCandidate; changes: ReturnType<typeof changedSources> }>();
  const semantic: ContextRecheck[] = [];
  for (const { candidate, changes } of affectedCandidates) {
    const stale = changes.filter(
      (change) => change.currentRevision === null || change.changedEvidence.length > 0,
    );
    if (stale.length) {
      deterministic.set(`${candidate.note.note.path}\u0000${candidate.recordId}`, { candidate, changes: stale });
      continue;
    }
    const recheck = contextRechecks(context, candidate, changes);
    if (recheck) semantic.push(recheck);
    else {
      const unresolved = contextualChangesFor(context, candidate, changes);
      if (unresolved.length) {
        plan.reconsiderationDeferred = "assessment";
        context.retrievalLimitations.add(
          `Current authored context for ${candidate.recordId} did not yield an exact bounded passage to assess; the record remains unchanged.`,
        );
      }
    }
  }

  const retainQuestion = (
    candidate: ReconsiderationCandidate,
    question: { record: IntelligenceRecord; finding: PipelineFinding },
  ) => {
    if (newQuestions >= maxNewQuestions) return;
    let entry = pendingAppend.get(candidate.note.note.path);
    if (!entry) {
      entry = { note: candidate.note, updates: [], findings: [] };
      pendingAppend.set(candidate.note.note.path, entry);
    }
    entry.updates.push(question.record);
    if (question.finding.evidence.length) entry.findings.push(question);
    newQuestions++;
  };

  for (const { candidate, changes } of deterministic.values()) {
    const question = questionForCandidate(context, candidate, changes, confirmedMissing);
    if (question) retainQuestion(candidate, question);
    if (newQuestions >= maxNewQuestions) break;
  }

  if (plan.pipeline === "reconsider" && newQuestions < maxNewQuestions) {
    const boundedSemantic = semantic.slice(0, Math.min(MAX_CONTEXT_RECHECK_CANDIDATES, context.options.policy.budget.candidates));
    if (semantic.length > boundedSemantic.length) {
      context.retrievalLimitations.add("Additional contextual rechecks were deferred by the configured candidate budget.");
    }
    await assessCurrentContext(context, plan, boundedSemantic, retainQuestion);
  }

  for (const { note, updates, findings } of pendingAppend.values()) {
    const existingAppend = plan.changes
      .filter((change) => change.kind === "append" && change.source.path === note.note.path)
      .reduce((body, change) => body + (change.kind === "append" ? change.text : ""), note.body);
    const pending = prepareIntelligenceAppend(existingAppend, designation, updates);
    if (!pending.text) continue;
    const append = prepareIntelligenceAppend(
      note.body,
      designation,
      updates.filter((record) => pending.appendedIds.includes(intelligenceRecordId(record))),
    );
    if (!append.text) continue;
    plan.changes.unshift({ kind: "append", source: note.note, text: append.text });
    plan.findings.push(
      ...findings
        .filter((entry) => append.appendedIds.includes(intelligenceRecordId(entry.record)))
        .map((entry) => entry.finding),
    );
  }
}
