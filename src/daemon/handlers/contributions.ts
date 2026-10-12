import { z } from "zod";
import {
  contributionListSchema,
  contributionResultSchema,
  contributionStageResultSchema,
  contributionSubmitResultSchema,
  type ContributionRecord,
} from "../../api/contributions";
import { operationInputs } from "../../api/operations";
import { contentRevision, inspectMarkdown, NoteReadService } from "../../api/notes";
import { NoteApiError, type SourceReference } from "../../api/schema";
import type { ReviewFeedbackRetention, ReviewProposal } from "../../api/proposals";
import type { ApprovalService } from "../../core/approvals/approvalService";
import type { ChangeService } from "../../core/history/changeService";
import {
  intelligenceRecordId,
  intelligenceSuppressionSubject,
  parseAllIntelligenceRecords,
  parseIntelligenceRecords,
  prepareIntelligenceAppend,
  type IntelligenceRecord,
} from "../../core/intelligence";
import { ContributionStore, type StoredContribution } from "../../core/contributions/contributionStore";
import type { SettingsService } from "../../core/settings/settingsService";
import { RpcError, type Principal, type RpcRequestContext } from "../rpc";

type ContributionOperation =
  | "contributions.submit"
  | "feedback.submit"
  | "contributions.list"
  | "contributions.get"
  | "contributions.stage"
  | "contributions.dismiss";

export function makeContributionHandlers(options: {
  store: ContributionStore;
  notes: NoteReadService;
  settings: SettingsService;
  approvals: ApprovalService;
  changes: ChangeService;
}) {
  const call = <Name extends ContributionOperation>(
    name: Name,
    scope: "read" | "write",
    action: (
      context: RpcRequestContext,
      params: z.infer<(typeof operationInputs)[Name]>,
    ) => Promise<Record<string, unknown>>,
  ) =>
    async (context: RpcRequestContext) => {
      if (!context.principal.scopes.includes(scope))
        throw new RpcError("FORBIDDEN", `contribution operation requires ${scope} scope`);
      const parsed = operationInputs[name].safeParse(context.params);
      if (!parsed.success) throw new RpcError("INVALID_PARAMS", parsed.error.message);
      try {
        context.signal?.throwIfAborted();
        return await action(
          context,
          parsed.data as z.infer<(typeof operationInputs)[Name]>,
        );
      } catch (error) {
        if (error instanceof NoteApiError) throw new RpcError(error.code, error.message);
        throw error;
      }
    };

  const trustedSections = async (): Promise<string[]> => {
    await options.settings.refreshBackground();
    const sections = new Set<string>();
    for (const policy of Object.values(options.settings.background().settings.pipelines))
      for (const section of policy.allowedSections) sections.add(section);
    return [...sections].sort((left, right) => left.localeCompare(right));
  };

  const validateEvidence = async (evidence: readonly SourceReference[]) => {
    for (const source of evidence) {
      const result = await options.notes.read({
        path: source.path,
        revision: source.revision,
        selector: { kind: "range", start: source.range.start, end: source.range.end },
      });
      if (
        result.selected === null ||
        result.selected.path !== source.path ||
        result.selected.revision !== source.revision ||
        result.selected.range.start !== source.range.start ||
        result.selected.range.end !== source.range.end ||
        result.selected.range.startLine !== source.range.startLine ||
        result.selected.range.endLine !== source.range.endLine ||
        result.selected.quote !== source.quote ||
        source.quote.trim().length === 0
      )
        throw new NoteApiError("INVALID_PARAMS", `evidence does not match the saved passage in ${source.path}`);
    }
  };

  const principalAttribution = (principal: Principal) => ({
    id: principal.id,
    kind: principal.kind,
    label: principal.id,
  });

  const submit = call("contributions.submit", "write", async ({ principal, signal }, params) => {
    signal?.throwIfAborted();
    const requestHash = requestIdentity("contributions.submit", principal, params);
    const replay = await options.store.findReplay(principal.id, params.idempotencyKey, requestHash);
    if (replay)
      return contributionSubmitResultSchema.parse({
        ok: true,
        contribution: replay.record,
        replayed: true,
      });
    await options.notes.read(params.target);
    await validateEvidence(params.evidence);
    const result = await options.store.submit({
      idempotencyKey: params.idempotencyKey,
      requestHash,
      principalId: principal.id,
      kind: "contribution",
      contributionKind: params.kind,
      target: params.target,
      statement: params.statement,
      evidence: params.evidence,
      attribution: principalAttribution(principal),
      origin: params.origin ?? null,
      feedback: null,
    });
    return contributionSubmitResultSchema.parse({
      ok: true,
      contribution: result.value.record,
      replayed: result.replayed,
    });
  });

  const submitFeedback = call("feedback.submit", "read", async ({ principal, signal }, params) => {
    signal?.throwIfAborted();
    const requestHash = requestIdentity("feedback.submit", principal, params);
    const replay = await options.store.findReplay(principal.id, params.idempotencyKey, requestHash);
    if (replay)
      return contributionSubmitResultSchema.parse({
        ok: true,
        contribution: replay.record,
        replayed: true,
      });
    const target = await options.notes.read(params.target);
    await validateEvidence(params.evidence);
    const sections = await trustedSections();
    if (sections.length === 0)
      throw new NoteApiError("FORBIDDEN", "no trusted note intelligence section is designated");
    const records = parseAllIntelligenceRecords(target.body);
    const intelligence = records.find((record) => intelligenceRecordId(record) === params.targetRecordId);
    if (!intelligence || intelligence.kind === "feedback")
      throw new NoteApiError("NOT_FOUND", "target intelligence record does not exist in the note");
    let targetKey: string;
    try {
      targetKey = intelligenceSuppressionSubject(intelligence);
    } catch {
      throw new NoteApiError(
        "INVALID_PARAMS",
        "target intelligence has no stable claim, contributor, evidence or relationship identity for feedback",
      );
    }
    const targetDependencies = new Map<string, { path: string; revision: string }>();
    const addTargetDependency = (reference: { path: string; revision: string }) => {
      const current = targetDependencies.get(reference.path);
      if (current && current.revision !== reference.revision)
        throw new NoteApiError("CONFLICT", "target intelligence has inconsistent source revisions");
      if (reference.path !== params.target.path)
        targetDependencies.set(reference.path, { path: reference.path, revision: reference.revision });
    };
    for (const reference of intelligence.dependencies) addTargetDependency(reference);
    for (const evidence of intelligence.evidence) addTargetDependency(evidence.source);
    for (const relationship of intelligence.relationships)
      for (const evidence of relationship.evidence) addTargetDependency(evidence);
    if (targetDependencies.size > 30)
      throw new NoteApiError("LIMIT_EXCEEDED", "target intelligence references too many source notes");
    const targetEvidence = new Map<string, SourceReference>();
    for (const evidence of intelligence.evidence) targetEvidence.set(sourceIdentity(evidence.source), evidence.source);
    for (const relationship of intelligence.relationships)
      for (const evidence of relationship.evidence) targetEvidence.set(sourceIdentity(evidence), evidence);
    if (targetEvidence.size > 30)
      throw new NoteApiError("LIMIT_EXCEEDED", "target intelligence quotes too many source passages");
    for (const source of params.evidence) {
      const targetDependency = targetDependencies.get(source.path);
      const targetQuote = [...targetEvidence.values()].find((candidate) => candidate.path === source.path);
      if (
        (targetDependency && targetDependency.revision !== source.revision) ||
        (targetQuote && targetQuote.revision !== source.revision)
      )
        throw new NoteApiError(
          "CONFLICT",
          `feedback evidence for ${source.path} uses a different revision than the target intelligence`,
        );
    }
    const result = await options.store.submit({
      idempotencyKey: params.idempotencyKey,
      requestHash,
      principalId: principal.id,
      kind: "feedback",
      contributionKind: null,
      target: params.target,
      statement: params.explanation,
      evidence: params.evidence,
      attribution: principalAttribution(principal),
      origin: null,
      feedback: {
        reason: params.reason,
        target: intelligence.statement,
        targetRecordId: params.targetRecordId,
        targetKey,
        explanation: params.explanation,
        targetEvidence: [...targetEvidence.values()],
        targetDependencies: [...targetDependencies.values()],
      },
    });
    return contributionSubmitResultSchema.parse({
      ok: true,
      contribution: result.value.record,
      replayed: result.replayed,
    });
  });

  const resolvedRecord = async (stored: StoredContribution): Promise<ContributionRecord> => {
    if (stored.record.proposalId === null) return stored.record;
    const proposal = await options.approvals.getReview(stored.record.proposalId);
    const status: ContributionRecord["status"] =
      proposal.state === "approved"
        ? "retained"
        : proposal.state === "rejected"
          ? "rejected"
          : proposal.state === "stale"
            ? "stale"
            : "awaiting-review";
    return { ...stored.record, status };
  };

  const list = call("contributions.list", "read", async ({ principal }, params) => {
    const page = await options.store.list({
      principalId: principal.kind === "human" ? null : principal.id,
      kind: params.kind,
      state: params.state,
      path: params.path,
      proposalId: params.proposalId,
      limit: params.limit,
      cursor: params.cursor,
    });
    const contributions = await Promise.all(page.contributions.map(resolvedRecord));
    return contributionListSchema.parse({
      ok: true,
      contributions: contributions.filter((record) => params.state === undefined || record.status === params.state),
      snapshot: page.snapshot,
      nextCursor: page.nextCursor,
    });
  });

  const get = call("contributions.get", "read", async ({ principal }, params) => {
    const stored = await options.store.get(params.id);
    if (!stored) throw new NoteApiError("NOT_FOUND", "contribution does not exist");
    if (principal.kind !== "human" && stored.principalId !== principal.id)
      throw new NoteApiError("FORBIDDEN", "contribution belongs to another principal");
    return contributionResultSchema.parse({ ok: true, contribution: await resolvedRecord(stored) });
  });

  const stage = call("contributions.stage", "write", async ({ principal, signal }, params) => {
    signal?.throwIfAborted();
    const stored = await options.store.get(params.id);
    if (!stored) throw new NoteApiError("NOT_FOUND", "contribution does not exist");
    if (principal.kind !== "human" && stored.principalId !== principal.id)
      throw new NoteApiError("FORBIDDEN", "only the contributor or human operator may stage this item");
    if (stored.record.status === "awaiting-review") {
      if (stored.stageKey !== params.idempotencyKey)
        throw new NoteApiError("CONFLICT", "contribution was already staged under another request");
      const proposal = await options.approvals.getReview(stored.record.proposalId as string);
      return contributionStageResultSchema.parse({
        ok: true,
        contribution: await resolvedRecord(stored),
        proposal,
      });
    }
    if (stored.record.status !== "pending")
      throw new NoteApiError("CONFLICT", "only a pending contribution can be staged");
    if (stored.record.revision !== params.revision)
      throw new NoteApiError("CONFLICT", "contribution changed; refresh before staging");
    const target = await options.notes.read(stored.record.target);
    await validateEvidence(stored.record.evidence);
    const sections = await trustedSections();
    let section = params.section;
    if (section !== undefined && !sections.includes(section) && principal.kind !== "human")
      throw new NoteApiError("FORBIDDEN", "agents may stage only within a trusted designated section");
    if (section === undefined) {
      if (sections.length === 1) section = sections[0];
      else {
        const present = sections.filter((candidate) =>
          target.structure.headings.some((heading) => heading.level === 2 && heading.text === candidate),
        );
        if (present.length === 1) section = present[0];
      }
    }
    if (section === undefined)
      throw new NoteApiError(
        "INVALID_PARAMS",
        sections.length === 0
          ? "select a note section for this reviewed append"
          : "select one existing trusted section for this reviewed append",
      );
    const record = buildIntelligenceRecord(stored.record);
    const append = prepareIntelligenceAppend(target.body, section, [record]);
    if (append.text.length === 0)
      throw new NoteApiError("CONFLICT", "this contribution is already retained in the selected section");
    const previewKey = `contribution-stage:${contentRevision(JSON.stringify([principal.id, params.idempotencyKey]))}`;
    const preview = await options.changes.preview(
      {
        idempotencyKey: previewKey,
        changes: [{ kind: "append", source: stored.record.target, text: append.text }],
      },
      principal,
    );
    const proposal = await options.approvals.submitReview(
      {
        previewId: preview.previewId,
        previewRevision: preview.revision,
        rationale: stored.record.feedback
          ? `Retain ${stored.record.feedback.reason} feedback from ${stored.record.attribution.kind} ${stored.record.attribution.id} in “${section}”.

Target: ${stored.record.feedback.target.slice(0, 180)}

Reason: ${stored.record.feedback.explanation}

Inherited quotations identify the feedback target; they do not establish the feedback reason.`
          : `Retain a reviewed ${stored.record.kind} from ${stored.record.attribution.kind} ${stored.record.attribution.id} in “${section}”.`,
        evidence: stored.record.evidence,
        idempotencyKey: params.idempotencyKey,
      },
      principal,
      options.changes,
    );
    const staged = await options.store.stage(
      params.id,
      params.revision,
      params.idempotencyKey,
      proposal.id,
    );
    return contributionStageResultSchema.parse({
      ok: true,
      contribution: await resolvedRecord(staged),
      proposal,
    });
  });

  const dismiss = call("contributions.dismiss", "write", async ({ principal }, params) => {
    const stored = await options.store.get(params.id);
    if (!stored) throw new NoteApiError("NOT_FOUND", "contribution does not exist");
    if (principal.kind !== "human" && stored.principalId !== principal.id)
      throw new NoteApiError("FORBIDDEN", "only the contributor or human operator may dismiss this item");
    const dismissed = await options.store.dismiss(
      params.id,
      params.revision,
      params.idempotencyKey,
      params.reason,
    );
    return contributionResultSchema.parse({ ok: true, contribution: dismissed.record });
  });

  return { submit, submitFeedback, list, get, stage, dismiss };
}

export function makeRejectedReviewFeedbackRetainer(options: {
  store: ContributionStore;
  notes: NoteReadService;
  changes: ChangeService;
  authorize?: (principal: Principal) => void;
  getReview?: (id: string) => Promise<ReviewProposal>;
  stage?: (
    input: { id: string; revision: string; idempotencyKey: string; section: string },
    principal: Principal,
  ) => Promise<ReviewProposal>;
}) {
  return async (proposal: ReviewProposal, principal: Principal): Promise<ReviewFeedbackRetention> => {
    const retention: ReviewFeedbackRetention = { reviewCount: 0, pendingCount: 0 };
    const feedback = proposal.feedback;
    if (
      (principal.kind !== "human" && principal.vaultOwner !== true) ||
      feedback?.category === null ||
      feedback?.category === undefined ||
      !feedback.reason
    )
      return retention;
    options.authorize?.(principal);
    const preview = await options.changes.get(proposal.previewId, principal);
    for (const effect of preview.effects) {
      if (effect.kind !== "write") continue;
      const afterSections = new Set(
        inspectMarkdown(effect.after).headings
          .filter((heading) => heading.level === 2)
          .map((heading) => heading.text),
      );
      const beforeSections = new Set(
        inspectMarkdown(effect.before ?? "").headings
          .filter((heading) => heading.level === 2)
          .map((heading) => heading.text),
      );
      const beforeIds = new Set<string>();
      const afterRecords = new Map<string, IntelligenceRecord>();
      const recordSections = new Map<string, string>();
      try {
        for (const section of beforeSections)
          for (const record of parseIntelligenceRecords(effect.before ?? "", section))
            beforeIds.add(intelligenceRecordId(record));
        for (const section of afterSections)
          for (const record of parseIntelligenceRecords(effect.after, section)) {
            afterRecords.set(intelligenceRecordId(record), record);
            recordSections.set(intelligenceRecordId(record), section);
          }
      } catch {
        continue;
      }
      for (const [targetRecordId, targetRecord] of afterRecords) {
        if (beforeIds.has(targetRecordId) || targetRecord.kind === "feedback") continue;
        let targetKey: string;
        try {
          targetKey = intelligenceSuppressionSubject(targetRecord);
        } catch {
          continue;
        }
        const idempotencyKey = `review-feedback:${contentRevision(
          JSON.stringify([proposal.id, targetRecordId, feedback.category]),
        )}`;
        const requestHash = contentRevision(
          JSON.stringify([
            "review-feedback",
            { id: principal.id, kind: principal.kind },
            proposal.id,
            targetRecordId,
            feedback.category,
            feedback.reason,
          ]),
        );
        const existing = await options.store.findReplay(principal.id, idempotencyKey, requestHash);
        if (existing && existing.record.status !== "pending") {
          if (existing.record.status === "awaiting-review" && existing.record.proposalId && options.getReview) {
            const linked = await options.getReview(existing.record.proposalId);
            if (linked.state === "pending") retention.reviewCount += 1;
          }
          continue;
        }
        let target: Awaited<ReturnType<NoteReadService["read"]>>;
        try {
          target = await options.notes.read({ path: effect.path });
        } catch (error) {
          if (error instanceof NoteApiError && error.code === "NOT_FOUND") continue;
          throw error;
        }
        const targetDependencies = new Map<string, { path: string; revision: string }>();
        const targetEvidence = new Map<string, SourceReference>();
        for (const evidence of targetRecord.evidence)
          targetEvidence.set(sourceIdentity(evidence.source), evidence.source);
        for (const relationship of targetRecord.relationships)
          for (const evidence of relationship.evidence)
            targetEvidence.set(sourceIdentity(evidence), evidence);
        let inconsistent = false;
        const addDependency = (reference: { path: string; revision: string }) => {
          if (reference.path === effect.path) return;
          const existing = targetDependencies.get(reference.path);
          if (existing && existing.revision !== reference.revision) inconsistent = true;
          else targetDependencies.set(reference.path, { path: reference.path, revision: reference.revision });
        };
        for (const reference of targetRecord.dependencies) addDependency(reference);
        for (const evidence of targetRecord.evidence) addDependency(evidence.source);
        for (const relationship of targetRecord.relationships)
          for (const evidence of relationship.evidence) addDependency(evidence);
        if (inconsistent || targetDependencies.size > 30 || targetEvidence.size > 30) continue;
        options.authorize?.(principal);
        const submitted = existing ?? (await options.store.submit({
          idempotencyKey,
          requestHash,
          principalId: principal.id,
          kind: "feedback",
          contributionKind: null,
          target: target.note,
          statement: feedback.reason,
          evidence: [],
          attribution: principalAttribution(principal),
          origin: null,
          feedback: {
            reason: feedback.category,
            target: targetRecord.statement,
            targetRecordId,
            targetKey,
            explanation: feedback.reason,
            targetEvidence: [...targetEvidence.values()],
            targetDependencies: [...targetDependencies.values()],
          },
        })).value;
        if (!options.stage) {
          retention.pendingCount += 1;
          continue;
        }
        try {
          options.authorize?.(principal);
          const staged = await options.stage({
            id: submitted.record.id,
            revision: submitted.record.revision,
            idempotencyKey: `review-feedback-stage:${contentRevision(JSON.stringify([proposal.id, targetRecordId]))}`,
            section: recordSections.get(targetRecordId)!,
          }, principal);
          if (staged.state === "pending") retention.reviewCount += 1;
        } catch {
          retention.pendingCount += 1;
        }
      }
    }
    return retention;
  };
}

function principalAttribution(principal: Principal) {
  return { id: principal.id, kind: principal.kind, label: principal.id };
}

function sourceIdentity(source: SourceReference): string {
  return JSON.stringify([
    source.path,
    source.revision,
    source.range.start,
    source.range.end,
    source.range.startLine,
    source.range.endLine,
    source.quote,
  ]);
}

function buildIntelligenceRecord(contribution: ContributionRecord): IntelligenceRecord {
  if (contribution.kind === "feedback") {
    const feedback = contribution.feedback;
    if (feedback === null) throw new NoteApiError("INTERNAL_ERROR", "feedback details are missing");
    const targetEvidence = feedback.targetEvidence ?? [];
    const uniqueDependencies = new Map<string, { path: string; revision: string }>();
    for (const dependency of feedback.targetDependencies ?? [])
      uniqueDependencies.set(dependency.path, dependency);
    const evidence: IntelligenceRecord["evidence"] = targetEvidence.map((source) => ({
      source,
      relation: "reports",
      assessment: "source-assertion",
    }));
    for (const source of contribution.evidence) {
      const existing = uniqueDependencies.get(source.path);
      if (existing && existing.revision !== source.revision)
        throw new NoteApiError("CONFLICT", `feedback evidence for ${source.path} has a conflicting source revision`);
      uniqueDependencies.set(source.path, { path: source.path, revision: source.revision });
      evidence.push({
        source,
        relation: feedback.reason === "false" ? "disputes" : "qualifies",
        assessment: "source-assertion",
      });
    }
    if (uniqueDependencies.size > 30)
      throw new NoteApiError("LIMIT_EXCEEDED", "feedback references too many source notes to retain");
    return {
      kind: "feedback",
      status: "retained",
      statement: feedback.explanation,
      attribution: contribution.attribution,
      evidence,
      qualifications: [
        `Feedback addresses intelligence record ${feedback.targetRecordId}.`,
        ...(targetEvidence.length
          ? ["Inherited quotations identify the targeted intelligence and do not prove this feedback reason."]
          : feedback.targetEvidence === undefined
            ? ["This earlier feedback item has no retained target quotations; its source-based suppression can be reconsidered only from its stored dependencies."]
            : ["The targeted intelligence supplied no quoted source passages. This feedback identifies its recorded claim; it does not independently establish or disprove it."]),
      ],
      relationships: [],
      dependencies: [...uniqueDependencies.values()],
      feedback: {
        reason: feedback.reason,
        target: feedback.target,
        targetKey: feedback.targetKey,
        explanation: feedback.explanation,
      },
    };
  }
  const status: IntelligenceRecord["status"] =
    contribution.contributionKind === "question"
      ? "open"
      : contribution.contributionKind === "decision" && contribution.attribution.kind === "human"
        ? "decided"
        : "provisional";
  const qualifications = contribution.origin
    ? [
        `Reported origin: ${contribution.origin.kind} — ${contribution.origin.label}${
          contribution.origin.sourceUrl ? ` (${contribution.origin.sourceUrl})` : ""
        }. This origin was supplied by the contributor.`,
      ]
    : [];
  return {
    kind: contribution.contributionKind as IntelligenceRecord["kind"],
    status,
    statement: contribution.statement,
    attribution: contribution.attribution,
    capturedContribution: true,
    evidence: contribution.evidence.map((source) => ({
      source,
      relation: "reports",
      assessment: "source-assertion",
    })),
    qualifications,
    relationships: [],
    dependencies: [...new Map(
      contribution.evidence.map((source) => [source.path, { path: source.path, revision: source.revision }]),
    ).values()],
    feedback: null,
  };
}

function requestIdentity(
  operation: ContributionOperation,
  principal: Principal,
  request: unknown,
): string {
  return contentRevision(JSON.stringify([operation, { id: principal.id, kind: principal.kind }, request]));
}
