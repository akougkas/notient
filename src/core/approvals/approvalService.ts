import { type ToolApproval, assertToolTarget, toolApprovalSchema } from "../chat/toolAuthority";
/**
 * SurrealDB-backed approval-and-write service.
 *
 * `approveEdge` flips an unapproved edge row through three stable states:
 *   1. `approved = false, applied = true`   (initial typed-edge proposal)
 *   2. `approved = true,  applied = false`  (writeback in flight)
 *   3. `approved = true,  applied = true`   (writeback committed)
 *
 * The filesystem and SurrealDB cannot share one atomic commit. Before the
 * first vault write, Notient therefore persists an `approval_intent` row
 * containing the exact before/after bytes, target path, approving principal,
 * and deterministic history receipt. Recovery compares the live bytes with
 * that intent: it may retry an untouched file, close an already-written file,
 * or refuse a conflicting edit. It never reconstructs a false undo snapshot.
 * The closing transaction creates history, flips `applied = true`, and deletes
 * the intent atomically; that edge flip is the commit signal consumers observe.
 *
 * `rejectEdge` is pending-only and idempotent: missing, already-approved,
 * or already-applied rows are ignored. A rejection atomically deletes the
 * pending edge and writes one non-reversible `proposal.reject` history row
 * containing the exact proposal snapshot, operator identity, and optional
 * reason. Its deterministic history id makes an uncertain retry return the
 * first committed audit record instead of creating a duplicate.
 */

import { DateTime, RecordId, type Surreal } from "surrealdb";
import { type VaultAdapter, VaultMutationBlockedError } from "../../adapters/vaultAdapter";
import type { ChangePreview, ChangeResult, PreviewEffect } from "../../api/changes";
import { NoteReadService } from "../../api/notes";
import { operationInputs } from "../../api/operations";
import type { PipelineJob, PipelinePlan } from "../../api/pipelines";
import type { ProposalProvenance, ReviewProposal } from "../../api/proposals";
import { NoteApiError, type NoteReference } from "../../api/schema";
import {
  WRITEBACK_EDGE_TABLES,
  type WritebackEdgeTable,
  isWritebackEdgeTable,
} from "../db/edgeTables";
import { unwrapNativeValue, wrapNativeValue } from "../db/nativeValue";
import { parseSurrealRelationRecordId } from "../db/recordId";
import { parseStoredUuidRecordId, stringifyUuidRecordId } from "../db/recordId";
import { withSurrealRetry } from "../db/retry";
import { lookupNoteByPath } from "../db/surreal";
import type { EventBus } from "../events/eventBus";
import type { ChangeCaller, ChangeService } from "../history/changeService";
import { EffectAuthorityRevoked } from "../history/effectAuthority";
import { bindMutationRequest } from "../history/mutationRequest";
import { applyApprovedLink, applyApprovedRelation } from "../markdown/writeback";
import { JobStore } from "../pipelines/jobStore";
import {
  proposalAcceptanceHistoryId,
  proposalApprovalIntentId,
  proposalDaemonWriteId,
  proposalRejectionHistoryId,
} from "./proposalIdentity";
import {
  PROPOSAL_EDGE_PROJECTION,
  ProposalStorageIntegrityError,
  type StoredProposalEdge,
  parseMutatedProposalEdge,
  parseNativeRecordId,
  parseProposalEdgeRecordId,
  parseProposalNotePath,
  parseSelectedProposalEdge,
  proposalStatementRows,
} from "./proposalStorage";
import { stagePendingProposal } from "./proposalWriter";
import { normalizeRejectionReason } from "./rejectionReason";
import {
  pageReviews,
  readReview,
  reviewRevision,
  reviewsForEdge,
  saveReview,
} from "./reviewStorage";

class RejectedReviewWrite extends NoteApiError {
  constructor(readonly proposal: ReviewProposal) {
    super("FORBIDDEN", "this proposal was rejected");
  }
}

export interface ApprovalServiceOptions {
  db: Surreal;
  bus: EventBus;
  /** Public vault boundary; production uses FsVault for every approval read and write. */
  vault: Pick<VaultAdapter, "read" | "writeIfUnchanged">;
  /** Canonical body hash supplied by the daemon's composition root. */
  hash: (content: string) => Promise<string>;
  /** Retention maintenance after a terminal approval history receipt is verified. */
  pruneHistory: () => Promise<void>;
  authorizeRecovery?: (
    edgeId: string,
    transition: {
      target: string;
      before: string;
      after: string;
      clientIdentity: string;
      toolApproval?: ToolApproval;
    },
  ) => Promise<void>;
}

export interface ListedEdge {
  id: RecordId;
  table: WritebackEdgeTable;
  source: RecordId<"note">;
  target: RecordId<"note">;
  agent: string;
  confidence: number;
}

export interface EdgeDecisionTarget {
  id: RecordId;
  table: WritebackEdgeTable;
}

export interface ApproveEdgeInput extends EdgeDecisionTarget {
  /** Authenticated principal responsible for accepting the proposal. */
  approvedBy: string;
  toolApproval?: ToolApproval;
}

export interface ApprovalExecutionGuard {
  before?: string;
  after?: string;
  authorize: () => Promise<void>;
}

export interface RejectEdgeInput extends EdgeDecisionTarget {
  /** Human-readable rationale. Omitted means the operator gave no reason. */
  reason?: string;
  /** Authenticated principal responsible for the decision. */
  rejectedBy: string;
}

export interface RejectEdgeResult {
  /** Deterministic, non-reversible history record for this edge decision. */
  historyId: string;
  /** Canonical persisted reason; null only when the first decision omitted it. */
  reason: string | null;
}

export interface ApproveEdgeResult {
  /** Durable history receipt for the accepted note write. */
  historyId: string;
  /** Authenticated principal that authorized the write. */
  approvedBy: string;
}

export interface ReconcileResult {
  replayed: number;
  abandoned: number;
  failed: number;
  deferred: number;
}

export interface ApprovalCancellationResult {
  cancelled: number;
  failed: number;
}

/** A delayed deletion task no longer owns the note's current tombstone. */
export class DeletionGenerationMismatchError extends Error {
  constructor(noteId: RecordId<"note">) {
    super(`deletion generation is stale for ${noteId.toString()}`);
    this.name = "DeletionGenerationMismatchError";
  }
}

interface NoteRow {
  id: RecordId<"note">;
  path: string;
}

interface ApprovalIntent {
  id: RecordId<"approval_intent">;
  edge: RecordId<WritebackEdgeTable>;
  table: WritebackEdgeTable;
  edgeCreatedAt: DateTime;
  sourceNote: RecordId<"note">;
  targetNote: RecordId<"note">;
  sourcePath: string;
  targetPath: string;
  kind: "note.append_section" | "note.frontmatter";
  beforeBody: string;
  afterBody: string;
  beforeSha: string;
  afterSha: string;
  historyId: RecordId<"history">;
  approvedBy: string;
  producer: string;
  toolApproval?: ToolApproval;
  preparedAt: DateTime;
  writeStartedAt: DateTime | undefined;
  cancelRequestedAt: DateTime | undefined;
}

type ApprovalIntentDraft = Omit<
  ApprovalIntent,
  "preparedAt" | "writeStartedAt" | "cancelRequestedAt"
>;
type IntentStep = { intent: ApprovalIntent } | { receipt: ApproveEdgeResult } | { cancelled: true };

const FRONTMATTER_RELATIONS: ReadonlyArray<WritebackEdgeTable> = WRITEBACK_EDGE_TABLES.filter(
  (table) => table !== "related_to",
);

const APPROVAL_EDGE_PROJECTION = `${PROPOSAL_EDGE_PROJECTION}, approved_by`;
const APPROVAL_INTENT_PROJECTION =
  "id, edge, table_name, edge_created_at, source_note, target_note, source_path, target_path, kind, before_body, after_body, before_sha, after_sha, history_id, approved_by, producer, tool_approval, prepared_at, write_started_at, cancel_requested_at";

function isFrontmatterRelation(table: WritebackEdgeTable): boolean {
  return FRONTMATTER_RELATIONS.includes(table);
}

function wikilinkTargetForPath(path: string): string {
  return path.replace(/\.md$/i, "");
}

export function renderApprovedRelation(
  before: string,
  table: WritebackEdgeTable,
  targetPath: string,
): string {
  const target = wikilinkTargetForPath(targetPath);
  return isFrontmatterRelation(table)
    ? applyApprovedRelation(before, { key: table, target })
    : applyApprovedLink(before, { target });
}

/** First-seen source revisions and reviewed edges named by a stored change set. */
function reviewedSources(preview: ChangePreview): { sources: NoteReference[]; edgeIds: string[] } {
  const sources = new Map<string, NoteReference>();
  const edgeIds: string[] = [];
  const add = (source: NoteReference) => {
    if (!sources.has(source.path)) sources.set(source.path, source);
  };
  const destinations = new Set<string>();
  for (const change of preview.changeSet.changes) {
    if (change.kind === "create" || destinations.has(change.source.path)) continue;
    if (change.kind === "move" || change.kind === "archive" || change.kind === "unarchive")
      destinations.add(change.destination);
    add(change.source);
    if (change.kind !== "relationship") continue;
    add(change.target);
    edgeIds.push(change.edgeId);
  }
  return { sources: [...sources.values()], edgeIds };
}

export class ApprovalService {
  private readonly intentTurns = new Map<string, Promise<void>>();

  constructor(private readonly options: ApprovalServiceOptions) {}

  /** Review metadata indexes existing exact previews and typed graph proposals;
   * all effects continue through this service and DurableNoteWriter. */
  async stagePipelinePlan(
    job: PipelineJob,
    plan: PipelinePlan,
    changes: ChangeService,
    signal: AbortSignal,
  ): Promise<{ proposalIds: string[]; previewId: string | null; previewRevision: string | null }> {
    const empty = { proposalIds: [] as string[], previewId: null, previewRevision: null };
    if (job.policy.mode === "report" && !job.preview) return empty;
    if (!plan.changes.length && !plan.relationships.length) return empty;
    const identity = reviewRevision([
      plan.pipeline,
      [...plan.sources].sort((a, b) => a.path.localeCompare(b.path)),
    ]);
    return this.withIntentTurn(`review:${identity}`, async () => {
      signal.throwIfAborted();
      const existing = await readReview(this.options.db, identity);
      if (
        existing?.state === "rejected" ||
        existing?.state === "approved" ||
        existing?.appliedHistory.length
      )
        return empty;
      const reader = new NoteReadService(this.options.vault);
      for (const source of plan.sources) await reader.read(source);
      const edgeIds: string[] = [];
      const relationshipChanges: PipelinePlan["changes"] = [];
      for (const suggestion of plan.relationships) {
        signal.throwIfAborted();
        const from = await lookupNoteByPath(this.options.db, suggestion.source.path);
        const to = await lookupNoteByPath(this.options.db, suggestion.target.path);
        if (!from || !to)
          throw new NoteApiError(
            "CONFLICT",
            "relationship source has not been structurally indexed",
          );
        const producer =
          job.pipeline === "contradictions"
            ? "pipeline-contradictions"
            : job.pipeline === "inbox"
              ? "pipeline-inbox"
              : "pipeline-relate";
        const provenance: ProposalProvenance = {
          pipeline: job.pipeline,
          jobId: job.id,
          configurationRevision: job.configurationRevision,
          sources: [suggestion.source, suggestion.target],
          evidence: suggestion.evidence,
          rationale: suggestion.rationale,
          score: { kind: "model-assessment", value: suggestion.assessment },
        };
        const staged = await stagePendingProposal(this.options.db, {
          relation: suggestion.relation,
          from,
          to,
          source: producer,
          agent: producer,
          confidence: suggestion.assessment,
          provenance,
        });
        if (staged.kind === "unavailable")
          throw new NoteApiError("CONFLICT", "relationship endpoint disappeared during staging");
        if (staged.kind === "rejected" || staged.state === "applied") continue;
        const edgeId = staged.edge.recordId.toString();
        edgeIds.push(edgeId);
        relationshipChanges.push({
          kind: "relationship",
          source: suggestion.source,
          target: suggestion.target,
          edgeId,
        });
      }
      // Relationship writes need their sources at the original paths, so they
      // precede the first move. From that move on, the pipeline's order is
      // kept: completion markers are authored last and apply last.
      const firstMove = plan.changes.findIndex(
        (change) =>
          change.kind === "move" || change.kind === "archive" || change.kind === "unarchive",
      );
      const split = firstMove < 0 ? plan.changes.length : firstMove;
      const all = [
        ...plan.changes.slice(0, split),
        ...relationshipChanges,
        ...plan.changes.slice(split),
      ];
      if (!all.length) return empty;
      const preview = await changes.preview(
        { idempotencyKey: `pipeline-${job.id}`, changes: all },
        job.caller,
      );
      const proposal = await saveReview(
        this.options.db,
        {
          id: identity,
          revision: "0".repeat(64),
          state: "pending",
          previewId: preview.previewId,
          previewRevision: preview.revision,
          edgeIds,
          provenance: {
            pipeline: job.pipeline,
            jobId: job.id,
            configurationRevision: job.configurationRevision,
            sources: plan.sources,
            evidence: plan.findings.flatMap((finding) => finding.evidence).slice(0, 500),
            rationale: plan.findings
              .map((finding) => `${finding.title}: ${finding.explanation}`)
              .join("\n\n"),
            score: null,
          },
          createdAt: existing?.createdAt ?? Date.now(),
          decidedAt: null,
          decidedBy: null,
          appliedHistory: [],
        },
        existing?.revision ?? null,
      );
      return {
        proposalIds: [proposal.id],
        previewId: proposal.previewId,
        previewRevision: proposal.previewRevision,
      };
    });
  }

  /**
   * Store a caller's own exact preview for the human's decision. Submission
   * grants nothing: effects still require `applyReview` by the human operator,
   * which revalidates every source revision, and a rejection stays recorded.
   */
  async submitReview(
    input: unknown,
    caller: ChangeCaller,
    changes: ChangeService,
  ): Promise<ReviewProposal> {
    const parsed = operationInputs["proposals.submit"].safeParse(input);
    if (!parsed.success) throw new NoteApiError("INVALID_PARAMS", parsed.error.message);
    const request = parsed.data;
    if (!caller.scopes.includes("write"))
      throw new NoteApiError("FORBIDDEN", "submitting a change for review requires write scope");
    const preview = await changes.get(request.previewId, caller);
    if (preview.owner !== caller.id)
      throw new NoteApiError("FORBIDDEN", "only the preview's owner may submit it for review");
    const id = reviewRevision(["request", caller.id, preview.previewId]);
    return this.withIntentTurn(`review:${id}`, async () => {
      await bindMutationRequest(this.options.db, "proposals", caller, request.idempotencyKey, {
        action: "submit",
        ...request,
      });
      const existing = await readReview(this.options.db, id);
      if (existing) return existing;
      if (preview.revision !== request.previewRevision)
        throw new NoteApiError("CONFLICT", "preview revision changed");
      if (preview.conflicts.length)
        throw new NoteApiError("CONFLICT", "resolve the reference ambiguities before submitting");
      const { sources, edgeIds } = reviewedSources(preview);
      const reader = new NoteReadService(this.options.vault);
      for (const source of sources) await reader.read(source);
      for (const source of request.evidence)
        await reader.read({ path: source.path, revision: source.revision });
      return saveReview(
        this.options.db,
        {
          id,
          revision: "0".repeat(64),
          state: "pending",
          previewId: preview.previewId,
          previewRevision: preview.revision,
          edgeIds,
          provenance: {
            requestedBy: { id: caller.id, kind: caller.kind },
            sources,
            evidence: request.evidence,
            rationale: request.rationale,
            score: null,
          },
          createdAt: Date.now(),
          decidedAt: null,
          decidedBy: null,
          appliedHistory: [],
        },
        null,
      );
    });
  }

  async getReview(id: string): Promise<ReviewProposal> {
    const proposal = await readReview(this.options.db, id);
    if (!proposal) throw new NoteApiError("NOT_FOUND", "review proposal does not exist");
    if (proposal.state === "pending") {
      const reader = new NoteReadService(this.options.vault);
      for (const source of proposal.provenance.sources) {
        try {
          await reader.read(source);
        } catch (error) {
          if (
            error instanceof NoteApiError &&
            (error.code === "CONFLICT" || error.code === "NOT_FOUND")
          )
            return { ...proposal, state: "stale" };
          throw error;
        }
      }
    }
    return proposal;
  }
  async pageReview(input: unknown, signal: AbortSignal) {
    const cache = new Map<string, string | null>();
    const reader = new NoteReadService(this.options.vault);
    return pageReviews(this.options.db, input, async (proposal) => {
      if (proposal.state !== "pending") return proposal;
      for (const source of proposal.provenance.sources) {
        signal.throwIfAborted();
        if (!cache.has(source.path)) {
          if (cache.size >= 1000)
            throw new NoteApiError(
              "LIMIT_EXCEEDED",
              "review page exceeds 1000 evidence notes; use a smaller page",
            );
          try {
            cache.set(source.path, (await reader.read({ path: source.path })).note.revision);
          } catch (error) {
            if (!(error instanceof NoteApiError) || error.code !== "NOT_FOUND") throw error;
            cache.set(source.path, null);
          }
        }
        if (cache.get(source.path) !== source.revision) return { ...proposal, state: "stale" };
      }
      return proposal;
    });
  }
  async applyReview(
    input: { id: string; previewId: string; previewRevision: string; idempotencyKey: string },
    caller: ChangeCaller,
    changes: ChangeService,
    signal: AbortSignal,
    authority?: (preview: ChangePreview, effect: PreviewEffect) => Promise<void>,
  ) {
    const request = operationInputs["proposals.approve"].parse(input);
    if (caller.kind !== "human" && !authority)
      throw new NoteApiError("FORBIDDEN", "only the human operator may approve a review");
    if (!caller.scopes.includes("write"))
      throw new NoteApiError("FORBIDDEN", "review approval requires write scope");
    return this.withIntentTurn(`review:${request.id}`, async () => {
      signal.throwIfAborted();
      await bindMutationRequest(this.options.db, "proposals", caller, request.idempotencyKey, {
        action: "approve",
        ...request,
      });
      const proposal = await readReview(this.options.db, request.id);
      if (!proposal) throw new NoteApiError("NOT_FOUND", "review proposal does not exist");
      if (proposal.state === "rejected")
        throw new NoteApiError("FORBIDDEN", "this proposal was rejected");
      if (
        proposal.previewId !== request.previewId ||
        proposal.previewRevision !== request.previewRevision
      )
        throw new NoteApiError("CONFLICT", "review preview changed; inspect the current proposal");
      if (proposal.state === "approved" && proposal.application?.state === "applied") {
        await this.updateReviewedJob(proposal, proposal.application);
        return proposal.application;
      }
      const result = await changes.apply(
        {
          previewId: request.previewId,
          previewRevision: request.previewRevision,
          idempotencyKey: request.idempotencyKey,
        },
        caller,
        signal,
        async (preview, effect) => {
          signal.throwIfAborted();
          await changes.validateSources(preview, proposal.provenance.sources);
          await authority?.(preview, effect);
        },
        proposal.id,
      );
      const history = [
        ...new Set([
          ...proposal.appliedHistory,
          ...result.effects.flatMap((effect) => (effect.historyId ? [effect.historyId] : [])),
        ]),
      ];
      if (
        (result.state === "applied" && proposal.state !== "approved") ||
        history.length !== proposal.appliedHistory.length
      ) {
        await saveReview(
          this.options.db,
          {
            ...proposal,
            state: result.state === "applied" ? "approved" : "pending",
            decidedAt: result.state === "applied" ? Date.now() : null,
            decidedBy: result.state === "applied" ? caller.id : null,
            appliedHistory: history,
            application: result,
          },
          proposal.revision,
        );
      }
      await this.updateReviewedJob(proposal, result);
      return result;
    });
  }
  async rejectReview(
    input: { id: string; revision: string; idempotencyKey: string },
    caller: ChangeCaller,
  ): Promise<ReviewProposal> {
    const request = operationInputs["proposals.reject"].parse(input);
    if (caller.kind !== "human" || !caller.scopes.includes("write"))
      throw new NoteApiError("FORBIDDEN", "review rejection requires the human operator");
    return this.withIntentTurn(`review:${request.id}`, async () => {
      await bindMutationRequest(this.options.db, "proposals", caller, request.idempotencyKey, {
        action: "reject",
        ...request,
      });
      const proposal = await readReview(this.options.db, request.id);
      if (!proposal) throw new NoteApiError("NOT_FOUND", "review proposal does not exist");
      if (
        proposal.state !== "rejected" &&
        (proposal.revision !== request.revision || proposal.state === "approved")
      )
        throw new NoteApiError("CONFLICT", "proposal changed before rejection");
      // Persist the rejection before removing graph candidates. A crash or a
      // later generation failure cannot erase the operator's decision.
      const rejected =
        proposal.state === "rejected"
          ? proposal
          : await saveReview(
              this.options.db,
              { ...proposal, state: "rejected", decidedAt: Date.now(), decidedBy: caller.id },
              proposal.revision,
            );
      for (const id of proposal.edgeIds) {
        const edge = parseSurrealRelationRecordId(id, WRITEBACK_EDGE_TABLES);
        await this.withIntentTurn(id, async () => {
          const intent = await this.readApprovalIntent(
            await proposalApprovalIntentId(edge.recordId),
          );
          if (!intent) return;
          try {
            await this.runWriteback({ id: edge.recordId, table: edge.table }, intent);
          } catch (error) {
            if (!(error instanceof RejectedReviewWrite)) throw error;
          }
        });
        await this.rejectEdge({ id: edge.recordId, table: edge.table, rejectedBy: caller.id });
      }
      await this.updateReviewedJob(rejected, null);
      return rejected;
    });
  }

  private async updateReviewedJob(
    proposal: ReviewProposal,
    result: ChangeResult | null,
  ): Promise<void> {
    if (!("jobId" in proposal.provenance)) return;
    const store = new JobStore(this.options.db);
    const job = await store.get(proposal.provenance.jobId);
    if (!job || job.previewId !== proposal.previewId || job.state === "running") return;
    // The durable decision may have committed before a lost reply or crash.
    // Replaying that decision also repairs its job's presentation and receipt.
    const applied = result?.state === "applied";
    const partial = result?.state === "partial" || (!result && proposal.appliedHistory.length > 0);
    const state = result
      ? applied
        ? "completed"
        : partial
          ? "partial"
          : job.state
      : partial
        ? "partial"
        : "cancelled";
    const stage = result
      ? applied
        ? "reviewed-and-applied"
        : "review-needs-attention"
      : partial
        ? "remaining-changes-rejected"
        : "review-rejected";
    if (
      job.state === state &&
      job.stage === stage &&
      (!result || JSON.stringify(job.effects) === JSON.stringify(result))
    )
      return;
    const updated = await store.update(
      job.id,
      (draft) => {
        draft.state = state;
        draft.stage = stage;
        if (result) draft.effects = result;
      },
      job.revision,
    );
    this.options.bus.emit({
      type: "job:changed",
      jobId: updated.id,
      pipeline: updated.pipeline,
      state: updated.state,
      revision: updated.revision,
      stage: updated.stage,
    });
  }

  async describeEdge(
    input: EdgeDecisionTarget,
  ): Promise<{ fromPath: string; toPath: string; table: WritebackEdgeTable }> {
    const edge = await this.selectPendingEdge(input);
    if (!edge) throw new Error("relationship proposal is no longer pending");
    const from = await this.selectNote(edge.fromId);
    const to = await this.selectNote(edge.toId);
    if (!from || !to) throw new Error("relationship endpoint is unavailable");
    return { fromPath: from.path, toPath: to.path, table: input.table };
  }

  /**
   * Lists every edge in a writeback-capable table whose `approved` flag is
   * still `false`. Result is sorted newest first by `created_at` so the
   * /links inbox UI shows the latest proposals first.
   */
  async listPendingEdges(): Promise<ListedEdge[]> {
    const edges: Array<ListedEdge & { createdAt: number }> = [];
    for (const table of WRITEBACK_EDGE_TABLES) {
      // SurrealDB 3.0.5 requires every ORDER BY field to appear in the
      // projection. The shared proposal decoder owns the projected row.
      const sql = `SELECT ${PROPOSAL_EDGE_PROJECTION} FROM ${table} WHERE approved = false AND applied = true ORDER BY created_at DESC;`;
      const raw: unknown = await this.options.db.query(sql).collect();
      const rows = proposalStatementRows(raw, `${table} pending approval list`);
      for (const value of rows) {
        const row = parseSelectedProposalEdge(value, table, "pending");
        edges.push({
          id: row.recordId,
          table,
          source: row.fromId,
          target: row.toId,
          agent: row.agent,
          confidence: row.confidence,
          createdAt: row.createdAt.toDate().getTime(),
        });
      }
    }
    return edges
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(({ createdAt: _createdAt, ...edge }) => edge);
  }

  /**
   * Promotes a typed-edge proposal through the pending-state contract. Steps:
   *
   *   A. Read the pending edge, resolve both live paths, and compute the exact
   *      byte change without mutating the edge or filesystem.
   *   B. In one transaction, compare the proposal's complete identity,
   *      stamp `approved = true, applied = false`, and persist the
   *      deterministic `approval_intent` containing those exact bytes.
   *   C. Re-read the file and require it to equal the intent's before or
   *      after bytes; any third value is a user-edit conflict.
   *   D. Insert `daemon_write`, then durably stamp `write_started_at`.
   *   E. Atomic file write when the before bytes are still present.
   *   F. One transaction creates the deterministic history receipt, flips
   *      `applied = true`, and deletes the intent.
   */
  async approveEdge(
    input: ApproveEdgeInput,
    guard?: ApprovalExecutionGuard,
  ): Promise<ApproveEdgeResult | null> {
    const canonical = parseApprovalInput(input, "approveEdge", [
      "id",
      "table",
      "approvedBy",
      "toolApproval",
    ]);
    const approvedBy = normalizeDecisionPrincipal(input.approvedBy, "approving");
    if (input.toolApproval)
      assertToolTarget(input.toolApproval, approvedBy, { edgeId: canonical.id.toString() });
    if (
      (!guard || guard.before === undefined || guard.after === undefined) &&
      (await reviewsForEdge(this.options.db, canonical.id.toString())).length
    )
      throw new NoteApiError(
        "PENDING_APPROVAL",
        "this relationship belongs to a stored review; use proposals.approve",
      );
    const receipt = await this.withIntentTurn(canonical.id.toString(), () =>
      this.approveCanonical(canonical, approvedBy, guard, input.toolApproval),
    );
    if (receipt !== null) await this.pruneAfterReceipt(receipt.historyId);
    return receipt;
  }

  private async approveCanonical(
    canonical: EdgeDecisionTarget,
    approvedBy: string,
    guard?: ApprovalExecutionGuard,
    toolApproval?: ToolApproval,
  ): Promise<ApproveEdgeResult | null> {
    const [intentId, historyId] = await Promise.all([
      proposalApprovalIntentId(canonical.id),
      proposalAcceptanceHistoryId(canonical.id),
    ]);
    const existingReceipt = await this.selectAcceptanceReceipt(historyId, canonical);
    if (existingReceipt !== null) return existingReceipt;

    const existingIntent = await this.selectApprovalIntent(
      intentId,
      canonical,
      approvedBy,
      historyId,
    );
    if (existingIntent !== null) {
      const resumed = await this.runWriteback(canonical, existingIntent, guard);
      if (resumed.committed && resumed.receipt !== null) {
        this.emitAccepted(canonical, resumed.receipt);
      }
      return resumed.receipt;
    }

    const edge = await this.selectPendingEdge(canonical);
    if (edge === null) {
      // A concurrent decision may have committed between the receipt/intent
      // lookups and the pending-state read.
      return await this.selectAcceptanceReceipt(historyId, canonical);
    }
    const intent = await this.prepareApprovalIntent(
      canonical,
      edge,
      approvedBy,
      intentId,
      historyId,
      guard,
      toolApproval,
    );
    if (intent === null) return await this.selectAcceptanceReceipt(historyId, canonical);

    const result = await this.runWriteback(canonical, intent, guard);
    if (result.committed && result.receipt !== null) {
      this.emitAccepted(canonical, result.receipt);
    }
    return result.receipt;
  }

  private emitAccepted(input: EdgeDecisionTarget, result: ApproveEdgeResult): void {
    this.options.bus.emit({
      type: "approval:decided",
      kind: "edge",
      id: input.id.toString(),
      decision: "accepted",
      decidedBy: result.approvedBy,
      historyId: result.historyId,
    });
  }

  /**
   * Pending-only reject: deletes a state-1 proposal. Rows that have already
   * been approved or applied are live graph history and are not removed by
   * the rejection path.
   */
  async rejectEdge(input: RejectEdgeInput): Promise<RejectEdgeResult | null> {
    const canonical = parseApprovalInput(input, "rejectEdge", [
      "id",
      "table",
      "reason",
      "rejectedBy",
    ]);
    const reason = normalizeRejectionReason(input.reason);
    if (input.reason !== undefined && reason !== input.reason) {
      throw new Error("rejection reason must already be canonical");
    }
    const rejectedBy = normalizeRejectingPrincipal(input.rejectedBy);
    const historyId = await proposalRejectionHistoryId(canonical.id);
    const existingAudit = await this.selectRejectionAudit(historyId, canonical);
    if (existingAudit !== null) {
      await this.pruneAfterReceipt(existingAudit.historyId);
      return existingAudit;
    }

    const edge = await this.selectPendingEdge(canonical);
    if (edge === null) return null;

    const before = wrapNativeValue({
      id: edge.recordId,
      table: canonical.table,
      in: edge.fromId,
      out: edge.toId,
      source: edge.source,
      class: "INFERRED",
      agent: edge.agent,
      confidence: edge.confidence,
      evidence: edge.evidence === undefined ? [] : edge.evidence,
      approved: edge.approved,
      applied: edge.applied,
      created_at: edge.createdAt,
    });
    const after = wrapNativeValue({
      decision: "rejected",
      reason: reason === undefined ? null : reason,
    });
    const transaction = `BEGIN;
LET $pending = (SELECT VALUE id FROM ONLY $edgeId WHERE approved = false AND applied = true AND created_at = $createdAt);
LET $alreadyAudited = record::exists($historyId);
LET $created = $pending = $edgeId AND !$alreadyAudited;
IF $created {
  CREATE ONLY $historyId CONTENT {
    kind: 'proposal.reject',
    target: $target,
    before: $before,
    after: $after,
    client_identity: $rejectedBy
  };
  DELETE $edgeId;
};
COMMIT;
RETURN $created;`;
    const transactionResults: unknown = await withSurrealRetry(async () => {
      const raw: unknown = await this.options.db
        .query(transaction, {
          edgeId: canonical.id,
          createdAt: edge.createdAt,
          historyId,
          target: canonical.id.toString(),
          before,
          after,
          rejectedBy,
        })
        .collect();
      return raw;
    });
    const created = parseRejectionTransactionAck(transactionResults);
    const audit = await this.selectRejectionAudit(historyId, canonical);
    if (created && audit === null) {
      throw new Error("approval storage integrity: rejection committed without its audit row");
    }
    if (audit === null) return null;
    await this.pruneAfterReceipt(audit.historyId);
    if (created) {
      this.options.bus.emit({
        type: "approval:decided",
        kind: "edge",
        id: canonical.id.toString(),
        decision: "rejected",
        reason: audit.reason,
        decidedBy: rejectedBy,
        historyId: audit.historyId,
      });
    }
    return audit;
  }

  /**
   * Durably supersede every in-flight approval touching a deleted or newly
   * excluded note, but only for the exact persisted deletion generation the
   * caller observed. This method never creates or refreshes a tombstone: a
   * delayed watcher task therefore cannot re-delete a note that has already
   * reappeared at the same path.
   *
   * Cancellation is deliberately recoverable. The request remains in
   * `approval_intent` until the exact filesystem transition has been handled
   * and the applying edge, daemon-write attribution, and intent are deleted
   * together. Daemon bootstrap resumes any request interrupted by a crash.
   */
  async cancelForNoteDeletion(
    noteId: RecordId<"note">,
    tombstonedAt: DateTime,
  ): Promise<ApprovalCancellationResult> {
    const note = parseNativeRecordId(noteId, "note", "approval cancellation note");
    if (!(tombstonedAt instanceof DateTime)) {
      throw new TypeError("approval cancellation requires a native tombstone generation");
    }
    const transaction = `BEGIN;
LET $current = (SELECT VALUE id FROM ONLY $note WHERE tombstoned_at = $tombstonedAt);
UPDATE approval_intent SET cancel_requested_at = time::now()
  WHERE $current = $note AND (source_note = $note OR target_note = $note) AND cancel_requested_at IS NONE
  RETURN NONE;
COMMIT;
RETURN $current = $note;`;
    const rawMatch: unknown = await withSurrealRetry(() =>
      this.options.db.query(transaction, { note, tombstonedAt }).collect(),
    );
    const matched = parseCancellationGenerationAck(rawMatch);
    if (!matched) throw new DeletionGenerationMismatchError(note);

    const raw: unknown = await this.options.db
      .query(
        `SELECT ${APPROVAL_INTENT_PROJECTION} FROM approval_intent WHERE (source_note = $note OR target_note = $note) AND cancel_requested_at != NONE;`,
        { note },
      )
      .collect();
    const intents = proposalStatementRows(raw, "approval cancellation lookup").map((row) =>
      parseApprovalIntent(row),
    );
    let cancelled = 0;
    let failed = 0;
    for (const intent of intents) {
      try {
        const applied = await this.withIntentTurn(intent.edge.toString(), async () => {
          const current = await this.readApprovalIntent(intent.id);
          if (current === null) return false;
          assertIntentSame(current, intent);
          return await this.cancelMarkedIntent(current);
        });
        if (applied) cancelled += 1;
      } catch (error) {
        failed += 1;
        this.emitReconciliationFailure(intent.edge.toString(), errorMessage(error));
      }
    }
    return { cancelled, failed };
  }

  /**
   * Daemon-bootstrap entry point. Replays every durable write-ahead intent,
   * then reports any state-2 edge (`approved = true AND applied = false`)
   * that has neither an intent nor its deterministic receipt as corruption.
   * Returns counters; the daemon supervisor logs the summary.
   */
  async reconcilePendingApplications(): Promise<ReconcileResult> {
    let replayed = 0;
    let abandoned = 0;
    let failed = 0;
    let deferred = 0;
    const rawIntents: unknown = await this.options.db
      .query(`SELECT ${APPROVAL_INTENT_PROJECTION} FROM approval_intent;`)
      .collect();
    const intentRows = proposalStatementRows(rawIntents, "approval intent reconciliation");
    const intents = intentRows.map((row) => parseApprovalIntent(row));
    const intentEdges = new Set(intents.map((intent) => intent.edge.toString()));

    for (const intent of intents) {
      const result = await this.withIntentTurn(intent.edge.toString(), () =>
        this.reconcileIntent(intent),
      );
      if (result === "deferred") deferred += 1;
      else if (result === "abandoned") abandoned += 1;
      else if (result) replayed += 1;
      else failed += 1;
    }
    failed += await this.reportOrphanApplyingEdges(intentEdges);
    return { replayed, abandoned, failed, deferred };
  }

  private async reconcileIntent(
    intent: ApprovalIntent,
  ): Promise<boolean | "deferred" | "abandoned"> {
    const input = { id: intent.edge, table: intent.table };
    try {
      if (intent.cancelRequestedAt !== undefined) {
        await this.cancelMarkedIntent(intent);
        return true;
      }
      const result = await this.runWriteback(input, intent);
      if (result.receipt !== null) await this.pruneAfterReceipt(result.receipt.historyId);
      return true;
    } catch (error) {
      const receipt = await this.selectAcceptanceReceipt(intent.historyId, input, intent);
      if (receipt !== null) {
        await this.pruneAfterReceipt(receipt.historyId);
        return true;
      }
      if (error instanceof VaultMutationBlockedError) return "deferred";
      if (error instanceof RejectedReviewWrite || error instanceof EffectAuthorityRevoked)
        return "abandoned";
      this.emitReconciliationFailure(intent.edge.toString(), errorMessage(error));
      return false;
    }
  }

  /** A committed decision stays successful even when best-effort retention maintenance fails. */
  private async pruneAfterReceipt(historyId: string): Promise<void> {
    try {
      await this.options.pruneHistory();
    } catch (error) {
      this.options.bus.emit({
        type: "indexer:error",
        path: historyId,
        phase: "history-retention",
        message: errorMessage(error),
      });
    }
  }

  private async reportOrphanApplyingEdges(intentEdges: ReadonlySet<string>): Promise<number> {
    let failures = 0;
    // State 2 without a write-ahead plan is corruption, not an invitation to
    // rebuild "before" bytes from a potentially already-mutated file.
    for (const table of WRITEBACK_EDGE_TABLES) {
      const sql = `SELECT ${APPROVAL_EDGE_PROJECTION} FROM ${table} WHERE approved = true AND applied = false;`;
      const raw: unknown = await this.options.db.query(sql).collect();
      const rows = proposalStatementRows(raw, `${table} writeback reconciliation`);
      const edges = rows.map((row) => parseApprovalEdge(row, table, "applying", "selected"));
      for (const edge of edges) {
        if (await this.hasLateIntentOrReceipt(edge, table, intentEdges)) continue;
        failures += 1;
        this.emitReconciliationFailure(
          edge.recordId.toString(),
          "approval storage integrity: applying edge has no durable write intent",
        );
      }
    }
    return failures;
  }

  private async hasLateIntentOrReceipt(
    edge: ApprovalStoredProposalEdge,
    table: WritebackEdgeTable,
    intentEdges: ReadonlySet<string>,
  ): Promise<boolean> {
    if (intentEdges.has(edge.recordId.toString())) return true;
    const intentId = await proposalApprovalIntentId(edge.recordId);
    if ((await this.readApprovalIntent(intentId)) !== null) return true;
    const historyId = await proposalAcceptanceHistoryId(edge.recordId);
    return (await this.selectAcceptanceReceipt(historyId, { id: edge.recordId, table })) !== null;
  }

  private emitReconciliationFailure(path: string, message: string): void {
    this.options.bus.emit({
      type: "indexer:error",
      path,
      phase: "approval-reconciliation",
      message,
    });
  }

  private async runWriteback(
    input: EdgeDecisionTarget,
    intent: ApprovalIntent,
    guard?: ApprovalExecutionGuard,
  ): Promise<{ receipt: ApproveEdgeResult | null; committed: boolean }> {
    const currentIntent = await this.readApprovalIntent(intent.id);
    if (currentIntent === null) {
      const receipt = await this.selectAcceptanceReceipt(intent.historyId, input, intent);
      if (receipt !== null) return { receipt, committed: false };
      throw new ProposalStorageIntegrityError(
        "approval intent disappeared without a terminal receipt",
      );
    }
    assertIntentSame(currentIntent, intent);
    if (currentIntent.cancelRequestedAt !== undefined) {
      await this.cancelMarkedIntent(currentIntent);
      return { receipt: null, committed: false };
    }

    const ready = await this.requireIntentReady(input, currentIntent);
    if ("receipt" in ready) return { receipt: ready.receipt, committed: false };
    if ("cancelled" in ready) return { receipt: null, committed: false };

    const currentBody = await this.options.vault.read(ready.intent.sourcePath);
    const resolved = await this.resolveIntentForCurrentBytes(input, ready.intent, currentBody);
    if ("receipt" in resolved) return { receipt: resolved.receipt, committed: false };
    if ("cancelled" in resolved) return { receipt: null, committed: false };

    if (
      guard &&
      (guard.before !== undefined || guard.after !== undefined) &&
      (guard.before !== resolved.intent.beforeBody || guard.after !== resolved.intent.afterBody)
    )
      throw new Error("approval conflict: durable intent differs from the reviewed preview");
    await this.authorizeWriteback(resolved.intent, guard);
    const written = await this.persistIntentBytes(input, resolved.intent, currentBody, guard);
    if ("receipt" in written) return { receipt: written.receipt, committed: false };
    if ("cancelled" in written) return { receipt: null, committed: false };

    // Step F.
    const committed = await this.closeWriteback(input, written.intent);
    if (!committed) {
      const refreshed = await this.readApprovalIntent(written.intent.id);
      if (refreshed?.cancelRequestedAt !== undefined) {
        assertIntentSame(refreshed, written.intent);
        await this.cancelMarkedIntent(refreshed);
        return { receipt: null, committed: false };
      }
    }
    const receipt = await this.selectAcceptanceReceipt(
      written.intent.historyId,
      input,
      written.intent,
    );
    if (receipt === null) {
      throw new ProposalStorageIntegrityError(
        "terminal approval is missing its deterministic history receipt",
      );
    }
    return { receipt, committed };
  }

  private async requireIntentReady(
    input: EdgeDecisionTarget,
    intent: ApprovalIntent,
  ): Promise<IntentStep> {
    try {
      await this.validateApprovalIntent(intent, input, intent.approvedBy, intent.historyId);
      await this.requireApplyingEdge(input, intent);
      return { intent };
    } catch (error) {
      const receipt = await this.selectAcceptanceReceipt(intent.historyId, input, intent);
      if (receipt !== null) return { receipt };
      throw error;
    }
  }

  private async resolveIntentForCurrentBytes(
    input: EdgeDecisionTarget,
    intent: ApprovalIntent,
    currentBody: string,
  ): Promise<IntentStep> {
    // Step D. Recovery is byte-exact: never infer a fresh "before" snapshot
    // from a file that an earlier attempt may already have changed.
    if (currentBody !== intent.beforeBody && currentBody !== intent.afterBody) {
      throw new Error(
        `approval write conflict: '${intent.sourcePath}' changed after the decision was prepared`,
      );
    }

    if (
      intent.beforeBody !== intent.afterBody &&
      currentBody === intent.afterBody &&
      intent.writeStartedAt === undefined
    ) {
      const refreshed = await this.readApprovalIntent(intent.id);
      if (refreshed === null) {
        const receipt = await this.selectAcceptanceReceipt(intent.historyId, input, intent);
        if (receipt !== null) return { receipt };
        throw new ProposalStorageIntegrityError(
          "approval intent disappeared without a terminal receipt",
        );
      }
      assertIntentSame(refreshed, intent);
      if (refreshed.writeStartedAt === undefined) {
        throw new Error(
          `approval write conflict: '${refreshed.sourcePath}' reached the intended bytes outside Notient`,
        );
      }
      return { intent: refreshed };
    }
    return { intent };
  }

  private async persistIntentBytes(
    input: EdgeDecisionTarget,
    intent: ApprovalIntent,
    currentBody: string,
    guard?: ApprovalExecutionGuard,
  ): Promise<IntentStep> {
    if (intent.afterBody !== intent.beforeBody && currentBody === intent.beforeBody) {
      return await this.writePreparedIntent(input, intent, guard);
    }
    if (
      intent.afterBody !== intent.beforeBody &&
      currentBody === intent.afterBody &&
      intent.writeStartedAt !== undefined
    ) {
      // A prior rename landed. Refresh the same deterministic audit row in
      // case recovery was delayed beyond Tier 1's normal lookup window.
      await this.upsertApprovalDaemonWrite(intent);
    }
    return { intent };
  }

  private async writePreparedIntent(
    input: EdgeDecisionTarget,
    intent: ApprovalIntent,
    guard?: ApprovalExecutionGuard,
  ): Promise<IntentStep> {
    // The deterministic row prevents find-then-create races between
    // reconcilers. Refreshing its server timestamp immediately before each
    // real attempt keeps Tier 1's watcher attribution window honest.
    await this.upsertApprovalDaemonWrite(intent);
    const marked = await this.markIntentWriteStarted(intent);
    if (marked === null) {
      const receipt = await this.selectAcceptanceReceipt(intent.historyId, input, intent);
      if (receipt !== null) return { receipt };
      throw new ProposalStorageIntegrityError(
        "approval intent disappeared before the filesystem write",
      );
    }
    if (marked.cancelRequestedAt !== undefined) {
      await this.cancelMarkedIntent(marked);
      return { cancelled: true };
    }
    const authorize = () => this.authorizeWriteback(marked, guard);
    await authorize();
    const written = await this.options.vault.writeIfUnchanged(
      marked.sourcePath,
      marked.beforeBody,
      marked.afterBody,
      authorize,
    );
    if (!written) {
      const observed = await this.options.vault.read(marked.sourcePath);
      if (observed !== marked.afterBody) {
        throw new Error(
          `approval write conflict: '${marked.sourcePath}' changed immediately before writeback`,
        );
      }
    }
    return { intent: marked };
  }

  private async authorizeWriteback(
    intent: ApprovalIntent,
    guard?: ApprovalExecutionGuard,
  ): Promise<void> {
    try {
      if ((await this.readVaultBodyOrMissing(intent.sourcePath)) === intent.beforeBody) {
        const rejected = (await reviewsForEdge(this.options.db, intent.edge.toString())).find(
          (proposal) => proposal.state === "rejected",
        );
        if (rejected) throw new RejectedReviewWrite(rejected);
        if (!guard)
          await this.options.authorizeRecovery?.(intent.edge.toString(), {
            target: intent.sourcePath,
            before: intent.beforeBody,
            after: intent.afterBody,
            clientIdentity: intent.approvedBy,
            toolApproval: intent.toolApproval,
          });
      }
      await guard?.authorize();
    } catch (error) {
      // No effect has landed in this branch. Return the relationship to review
      // and discard its write intent so a restart cannot bypass revoked authority.
      if ((await this.readVaultBodyOrMissing(intent.sourcePath)) === intent.beforeBody) {
        await withSurrealRetry(() =>
          this.options.db
            .query(
              `BEGIN;
            LET $ready = (SELECT VALUE id FROM ONLY $intent WHERE history_id = $history
              AND edge = $edge AND cancel_requested_at IS NONE);
            IF $ready = $intent {
              UPDATE ONLY $edge SET approved = false, applied = true, approved_by = NONE
                WHERE approved = true AND applied = false RETURN NONE;
              DELETE daemon_write WHERE approval_intent = $intent RETURN NONE;
              DELETE ONLY $intent RETURN NONE;
            };
            COMMIT;`,
              { intent: intent.id, history: intent.historyId, edge: intent.edge },
            )
            .collect(),
        );
        if (error instanceof RejectedReviewWrite)
          await this.rejectEdge({
            id: intent.edge,
            table: intent.table,
            rejectedBy: error.proposal.decidedBy ?? intent.approvedBy,
          });
      }
      throw error;
    }
  }

  private async prepareApprovalIntent(
    input: EdgeDecisionTarget,
    edge: StoredProposalEdge,
    approvedBy: string,
    intentId: RecordId<"approval_intent">,
    historyId: RecordId<"history">,
    guard?: ApprovalExecutionGuard,
    toolApproval?: ToolApproval,
  ): Promise<ApprovalIntent | null> {
    const sourceNote = await this.selectNote(edge.fromId);
    const targetNote = await this.selectNote(edge.toId);
    if (sourceNote === null || targetNote === null) return null;

    const beforeBody = await this.options.vault.read(sourceNote.path);
    const kind = isFrontmatterRelation(input.table) ? "note.frontmatter" : "note.append_section";
    const afterBody = renderApprovedRelation(beforeBody, input.table, targetNote.path);
    if (
      guard &&
      (guard.before !== undefined || guard.after !== undefined) &&
      (guard.before !== beforeBody || guard.after !== afterBody)
    )
      throw new Error("approval conflict: current bytes differ from the reviewed preview");
    await guard?.authorize();
    const [beforeSha, afterSha] = await Promise.all([
      this.options.hash(beforeBody),
      this.options.hash(afterBody),
    ]);
    assertSha256(beforeSha, "ApprovalService before hash");
    assertSha256(afterSha, "ApprovalService after hash");

    const draft: ApprovalIntentDraft = {
      id: intentId,
      edge: edge.recordId,
      table: input.table,
      edgeCreatedAt: edge.createdAt,
      sourceNote: edge.fromId,
      targetNote: edge.toId,
      sourcePath: sourceNote.path,
      targetPath: targetNote.path,
      kind,
      beforeBody,
      afterBody,
      beforeSha,
      afterSha,
      historyId,
      approvedBy,
      producer: edge.agent,
      toolApproval: toolApproval === undefined ? undefined : toolApprovalSchema.parse(toolApproval),
    };

    const transaction = `BEGIN;
LET $pending = (SELECT VALUE id FROM ONLY $edgeId WHERE approved = false AND applied = true AND created_at = $edgeCreatedAt AND in = $sourceNote AND out = $targetNote AND in.path = $sourcePath AND out.path = $targetPath AND source = $source AND agent = $producer AND confidence = $confidence AND in.tombstoned_at IS NONE AND out.tombstoned_at IS NONE);
LET $claimable = $pending = $edgeId AND !record::exists($intentId) AND !record::exists($historyId);
IF $claimable {
  UPDATE ONLY $edgeId SET approved = true, applied = false, approved_by = $approvedBy RETURN NONE;
  CREATE ONLY $intentId CONTENT {
    edge: $edgeId,
    table_name: $tableName,
    edge_created_at: $edgeCreatedAt,
    source_note: $sourceNote,
    target_note: $targetNote,
    source_path: $sourcePath,
    target_path: $targetPath,
    kind: $kind,
    before_body: $beforeBody,
    after_body: $afterBody,
    before_sha: $beforeSha,
    after_sha: $afterSha,
    history_id: $historyId,
    approved_by: $approvedBy,
    producer: $producer,
    tool_approval: $toolApproval
  } RETURN NONE;
};
COMMIT;
RETURN $claimable;`;
    await withSurrealRetry(() =>
      this.options.db
        .query(transaction, {
          edgeId: draft.edge,
          edgeCreatedAt: draft.edgeCreatedAt,
          sourceNote: draft.sourceNote,
          targetNote: draft.targetNote,
          sourcePath: draft.sourcePath,
          targetPath: draft.targetPath,
          source: edge.source,
          producer: draft.producer,
          confidence: edge.confidence,
          intentId: draft.id,
          historyId: draft.historyId,
          tableName: draft.table,
          kind: draft.kind,
          beforeBody: draft.beforeBody,
          afterBody: draft.afterBody,
          beforeSha: draft.beforeSha,
          afterSha: draft.afterSha,
          approvedBy: draft.approvedBy,
          toolApproval:
            draft.toolApproval === undefined ? undefined : JSON.stringify(draft.toolApproval),
        })
        .collect(),
    );

    const intent = await this.readApprovalIntent(intentId);
    if (intent === null || intent.approvedBy !== approvedBy) return null;
    await this.validateApprovalIntent(intent, input, approvedBy, historyId);
    assertIntentEqualsDraft(intent, draft);
    return intent;
  }

  private async selectApprovalIntent(
    intentId: RecordId<"approval_intent">,
    input: EdgeDecisionTarget,
    approvedBy: string,
    historyId: RecordId<"history">,
  ): Promise<ApprovalIntent | null> {
    const intent = await this.readApprovalIntent(intentId);
    if (intent === null || intent.approvedBy !== approvedBy) return null;
    await this.validateApprovalIntent(intent, input, approvedBy, historyId);
    return intent;
  }

  private async readApprovalIntent(
    intentId: RecordId<"approval_intent">,
  ): Promise<ApprovalIntent | null> {
    const raw: unknown = await this.options.db
      .query(
        `SELECT ${APPROVAL_INTENT_PROJECTION} FROM approval_intent WHERE id = $intentId LIMIT 1;`,
        { intentId },
      )
      .collect();
    const rows = proposalStatementRows(raw, "approval intent lookup");
    if (rows.length === 0) return null;
    if (rows.length !== 1) {
      throw new ProposalStorageIntegrityError("approval intent lookup returned multiple rows");
    }
    return parseApprovalIntent(rows[0]);
  }

  private async validateApprovalIntent(
    intent: ApprovalIntent,
    input: EdgeDecisionTarget,
    approvedBy: string,
    historyId: RecordId<"history">,
  ): Promise<void> {
    const expectedIntentId = await proposalApprovalIntentId(input.id);
    if (
      intent.id.toString() !== expectedIntentId.toString() ||
      intent.edge.toString() !== input.id.toString() ||
      intent.table !== input.table ||
      intent.historyId.toString() !== historyId.toString() ||
      intent.approvedBy !== approvedBy
    ) {
      throw new ProposalStorageIntegrityError("approval intent identity does not match its edge");
    }
    const [beforeSha, afterSha] = await Promise.all([
      this.options.hash(intent.beforeBody),
      this.options.hash(intent.afterBody),
    ]);
    if (beforeSha !== intent.beforeSha || afterSha !== intent.afterSha) {
      throw new ProposalStorageIntegrityError("approval intent body hash does not match its bytes");
    }
    const expectedKind = isFrontmatterRelation(input.table)
      ? "note.frontmatter"
      : "note.append_section";
    if (intent.kind !== expectedKind) {
      throw new ProposalStorageIntegrityError(
        "approval intent history kind does not match its edge",
      );
    }
  }

  private async requireApplyingEdge(
    input: EdgeDecisionTarget,
    intent: ApprovalIntent,
  ): Promise<ApprovalStoredProposalEdge> {
    const sql = `SELECT ${APPROVAL_EDGE_PROJECTION} FROM ${input.table} WHERE id = $id LIMIT 1;`;
    const raw: unknown = await this.options.db.query(sql, { id: input.id }).collect();
    const rows = proposalStatementRows(raw, `${input.table} applying approval lookup`);
    if (rows.length !== 1) {
      throw new ProposalStorageIntegrityError(
        `${input.table} applying approval lookup must return exactly one row`,
      );
    }
    const edge = parseApprovalEdge(rows[0], input.table, "applying", "selected");
    assertExpectedEdgeId(edge, input, "applying approval lookup");
    if (
      edge.approvedBy !== intent.approvedBy ||
      edge.createdAt.toString() !== intent.edgeCreatedAt.toString() ||
      edge.fromId.toString() !== intent.sourceNote.toString() ||
      edge.toId.toString() !== intent.targetNote.toString() ||
      edge.agent !== intent.producer
    ) {
      throw new ProposalStorageIntegrityError("applying edge does not match its write intent");
    }
    const [source, target] = await Promise.all([
      this.selectNote(intent.sourceNote),
      this.selectNote(intent.targetNote),
    ]);
    if (source?.path !== intent.sourcePath || target?.path !== intent.targetPath) {
      throw new ProposalStorageIntegrityError("approval intent endpoint path changed after claim");
    }
    return edge;
  }

  private async upsertApprovalDaemonWrite(intent: ApprovalIntent): Promise<void> {
    const daemonWriteId = await proposalDaemonWriteId(intent.edge);
    const transaction = `BEGIN;
LET $exists = record::exists($daemonWriteId);
IF !$exists {
  CREATE ONLY $daemonWriteId CONTENT { note: $note, sha: $sha, agent: $producer, targets: [$target], approval_intent: $intentId } RETURN NONE;
} ELSE {
  UPDATE ONLY $daemonWriteId SET written_at = time::now() WHERE note = $note AND sha = $sha AND agent = $producer AND targets = [$target] AND approval_intent = $intentId RETURN NONE;
};
COMMIT;`;
    await withSurrealRetry(() =>
      this.options.db
        .query(transaction, {
          daemonWriteId,
          note: intent.sourceNote,
          sha: intent.afterSha,
          producer: intent.producer,
          target: intent.targetNote,
          intentId: intent.id,
        })
        .collect(),
    );
    const raw: unknown = await this.options.db
      .query(
        "SELECT id, note, sha, agent, targets, approval_intent, written_at FROM daemon_write WHERE id = $id LIMIT 1;",
        { id: daemonWriteId },
      )
      .collect();
    const rows = proposalStatementRows(raw, "approval daemon-write lookup");
    if (rows.length !== 1) {
      throw new ProposalStorageIntegrityError(
        "approval daemon-write lookup must return exactly one row",
      );
    }
    parseApprovalDaemonWrite(rows[0], daemonWriteId, intent);
  }

  private async markIntentWriteStarted(intent: ApprovalIntent): Promise<ApprovalIntent | null> {
    await withSurrealRetry(() =>
      this.options.db
        .query(
          "UPDATE ONLY $intentId SET write_started_at = time::now() WHERE edge = $edgeId AND edge_created_at = $edgeCreatedAt AND approved_by = $approvedBy AND write_started_at IS NONE AND cancel_requested_at IS NONE RETURN NONE;",
          {
            intentId: intent.id,
            edgeId: intent.edge,
            edgeCreatedAt: intent.edgeCreatedAt,
            approvedBy: intent.approvedBy,
          },
        )
        .collect(),
    );
    const refreshed = await this.readApprovalIntent(intent.id);
    if (refreshed === null) return null;
    assertIntentSame(refreshed, intent);
    if (refreshed.cancelRequestedAt !== undefined) return refreshed;
    if (refreshed.writeStartedAt === undefined) {
      throw new ProposalStorageIntegrityError("approval intent write-start stamp did not persist");
    }
    return refreshed;
  }

  private async closeWriteback(
    input: EdgeDecisionTarget,
    intent: ApprovalIntent,
  ): Promise<boolean> {
    const transaction = `BEGIN;
LET $edgeReady = (SELECT VALUE id FROM ONLY $edgeId WHERE approved = true AND applied = false AND approved_by = $approvedBy AND created_at = $edgeCreatedAt AND in = $sourceNote AND out = $targetNote AND in.path = $sourcePath AND out.path = $targetPath);
LET $intentReady = (SELECT VALUE id FROM ONLY $intentId WHERE edge = $edgeId AND edge_created_at = $edgeCreatedAt AND history_id = $historyId AND approved_by = $approvedBy AND source_note = $sourceNote AND target_note = $targetNote AND source_path = $sourcePath AND target_path = $targetPath AND before_sha = $beforeSha AND after_sha = $afterSha AND cancel_requested_at IS NONE);
LET $ready = $edgeReady = $edgeId AND $intentReady = $intentId AND !record::exists($historyId);
IF $ready {
  CREATE ONLY $historyId CONTENT {
    kind: $kind,
    target: $sourcePath,
    before: $before,
    after: $after,
    client_identity: $approvedBy,
    tool_approval: $toolApproval,
    proposal_edge: $edgeId,
    proposal_created_at: $edgeCreatedAt
  } RETURN NONE;
  UPDATE ONLY $edgeId SET applied = true WHERE approved = true AND applied = false AND approved_by = $approvedBy AND created_at = $edgeCreatedAt RETURN NONE;
  DELETE $intentId RETURN NONE;
};
COMMIT;
RETURN $ready;`;
    const raw: unknown = await withSurrealRetry(() =>
      this.options.db
        .query(transaction, {
          edgeId: input.id,
          edgeCreatedAt: intent.edgeCreatedAt,
          sourceNote: intent.sourceNote,
          targetNote: intent.targetNote,
          sourcePath: intent.sourcePath,
          targetPath: intent.targetPath,
          approvedBy: intent.approvedBy,
          toolApproval:
            intent.toolApproval === undefined ? undefined : JSON.stringify(intent.toolApproval),
          intentId: intent.id,
          historyId: intent.historyId,
          beforeSha: intent.beforeSha,
          afterSha: intent.afterSha,
          kind: intent.kind,
          before: wrapNativeValue(intent.beforeBody),
          after: wrapNativeValue(intent.afterBody),
        })
        .collect(),
    );
    return parseCloseTransactionAck(raw);
  }

  /**
   * Finish one durable cancellation. Exact `after_body` is reverted only when
   * `write_started_at` proves Notient began the write. Untouched `before_body`,
   * a missing source file, an unstarted byte-identical operator edit, and any
   * third value are all preserved byte-for-byte.
   */
  private async cancelMarkedIntent(intent: ApprovalIntent): Promise<boolean> {
    if (intent.cancelRequestedAt === undefined) {
      throw new ProposalStorageIntegrityError(
        "approval cancellation requires a durable cancellation request",
      );
    }
    await this.validateApprovalIntent(
      intent,
      { id: intent.edge, table: intent.table },
      intent.approvedBy,
      intent.historyId,
    );
    await this.requireCancellingEdge(intent);

    const body = await this.readVaultBodyOrMissing(intent.sourcePath);
    if (
      intent.writeStartedAt !== undefined &&
      intent.beforeBody !== intent.afterBody &&
      body !== null &&
      body === intent.afterBody
    ) {
      const restored = await this.options.vault.writeIfUnchanged(
        intent.sourcePath,
        intent.afterBody,
        intent.beforeBody,
      );
      if (!restored) {
        const observed = await this.readVaultBodyOrMissing(intent.sourcePath);
        // A human edit, deletion, or already-restored body wins. Seeing the
        // exact Notient bytes again means no safe transition was established;
        // leave the durable intent for a later retry.
        if (observed === intent.afterBody) {
          throw new Error(
            `approval cancellation conflict: '${intent.sourcePath}' could not be restored`,
          );
        }
      }
    }

    const transaction = `BEGIN;
LET $edgeReady = (SELECT VALUE id FROM ONLY $edgeId WHERE approved = true AND applied = false AND approved_by = $approvedBy AND created_at = $edgeCreatedAt AND in = $sourceNote AND out = $targetNote);
LET $intentReady = (SELECT VALUE id FROM ONLY $intentId WHERE edge = $edgeId AND edge_created_at = $edgeCreatedAt AND source_note = $sourceNote AND target_note = $targetNote AND before_sha = $beforeSha AND after_sha = $afterSha AND cancel_requested_at != NONE);
LET $ready = $edgeReady = $edgeId AND $intentReady = $intentId;
IF $ready {
  DELETE daemon_write WHERE approval_intent = $intentId RETURN NONE;
  DELETE ONLY $edgeId RETURN NONE;
  DELETE ONLY $intentId RETURN NONE;
};
COMMIT;
RETURN $ready;`;
    const raw: unknown = await withSurrealRetry(() =>
      this.options.db
        .query(transaction, {
          edgeId: intent.edge,
          edgeCreatedAt: intent.edgeCreatedAt,
          sourceNote: intent.sourceNote,
          targetNote: intent.targetNote,
          approvedBy: intent.approvedBy,
          toolApproval:
            intent.toolApproval === undefined ? undefined : JSON.stringify(intent.toolApproval),
          intentId: intent.id,
          beforeSha: intent.beforeSha,
          afterSha: intent.afterSha,
        })
        .collect(),
    );
    const cancelled = parseCancellationTransactionAck(raw);
    if (!cancelled) {
      throw new ProposalStorageIntegrityError(
        "approval cancellation lost its applying edge or durable intent",
      );
    }
    return true;
  }

  private async requireCancellingEdge(intent: ApprovalIntent): Promise<ApprovalStoredProposalEdge> {
    const sql = `SELECT ${APPROVAL_EDGE_PROJECTION} FROM ${intent.table} WHERE id = $id LIMIT 1;`;
    const raw: unknown = await this.options.db.query(sql, { id: intent.edge }).collect();
    const rows = proposalStatementRows(raw, `${intent.table} cancelling approval lookup`);
    if (rows.length !== 1) {
      throw new ProposalStorageIntegrityError(
        `${intent.table} cancelling approval lookup must return exactly one row`,
      );
    }
    const edge = parseApprovalEdge(rows[0], intent.table, "applying", "selected");
    if (
      edge.recordId.toString() !== intent.edge.toString() ||
      edge.approvedBy !== intent.approvedBy ||
      edge.createdAt.toString() !== intent.edgeCreatedAt.toString() ||
      edge.fromId.toString() !== intent.sourceNote.toString() ||
      edge.toId.toString() !== intent.targetNote.toString() ||
      edge.agent !== intent.producer
    ) {
      throw new ProposalStorageIntegrityError("cancelling edge does not match its approval intent");
    }
    return edge;
  }

  private async readVaultBodyOrMissing(path: string): Promise<string | null> {
    try {
      return await this.options.vault.read(path);
    } catch (error) {
      if (isMissingVaultEntry(error)) return null;
      throw error;
    }
  }

  private async withIntentTurn<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.intentTurns.get(key);
    let release = (): void => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.intentTurns.set(key, current);
    if (previous !== undefined) await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.intentTurns.get(key) === current) this.intentTurns.delete(key);
    }
  }

  private async selectAcceptanceReceipt(
    historyId: RecordId<"history">,
    input: EdgeDecisionTarget,
    expectedIntent?: ApprovalIntent,
  ): Promise<ApproveEdgeResult | null> {
    const raw: unknown = await this.options.db
      .query(
        "SELECT id, kind, target, before, after, client_identity, proposal_edge, proposal_created_at, created_at FROM history WHERE id = $historyId LIMIT 1;",
        { historyId },
      )
      .collect();
    const rows = proposalStatementRows(raw, "proposal acceptance audit lookup");
    if (rows.length === 0) return null;
    if (rows.length !== 1) {
      throw new ProposalStorageIntegrityError(
        "proposal acceptance audit lookup returned multiple rows",
      );
    }
    const audit = parseAcceptanceAudit(rows[0], historyId, input);
    const edge = await this.requireTerminalAppliedEdge(input, audit.approvedBy);
    if (edge.createdAt.toString() !== audit.edgeCreatedAt.toString()) {
      throw new ProposalStorageIntegrityError(
        "acceptance receipt belongs to a different proposal revision",
      );
    }
    if (expectedIntent !== undefined) assertAcceptanceMatchesIntent(audit, expectedIntent);
    return {
      historyId: stringifyUuidRecordId(historyId, "history", "approval history id"),
      approvedBy: audit.approvedBy,
    };
  }

  private async selectPendingEdge(input: EdgeDecisionTarget): Promise<StoredProposalEdge | null> {
    const sql = `SELECT ${PROPOSAL_EDGE_PROJECTION} FROM ${input.table} WHERE id = $id AND approved = false AND applied = true LIMIT 1;`;
    const raw: unknown = await this.options.db.query(sql, { id: input.id }).collect();
    const rows = proposalStatementRows(raw, `${input.table} pending approval lookup`);
    if (rows.length === 0) return null;
    if (rows.length !== 1) {
      throw new ProposalStorageIntegrityError(
        `${input.table} pending approval lookup returned multiple rows`,
      );
    }
    const edge = parseSelectedProposalEdge(rows[0], input.table, "pending");
    assertExpectedEdgeId(edge, input, "pending approval lookup");
    return edge;
  }

  private async requireTerminalAppliedEdge(
    input: EdgeDecisionTarget,
    approvedBy: string,
  ): Promise<StoredProposalEdge> {
    const sql = `SELECT ${APPROVAL_EDGE_PROJECTION} FROM ${input.table} WHERE id = $id LIMIT 1;`;
    const raw: unknown = await this.options.db.query(sql, { id: input.id }).collect();
    const rows = proposalStatementRows(raw, `${input.table} terminal approval lookup`);
    if (rows.length !== 1) {
      throw new ProposalStorageIntegrityError(
        `${input.table} terminal approval lookup must return exactly one row`,
      );
    }
    const edge = parseApprovalEdge(rows[0], input.table, "applied", "selected");
    assertExpectedEdgeId(edge, input, "terminal approval lookup");
    if (edge.approvedBy !== approvedBy) {
      throw new ProposalStorageIntegrityError(
        "terminal approval lookup returned a different approving principal",
      );
    }
    return edge;
  }

  private async selectRejectionAudit(
    historyId: RecordId<"history">,
    input: EdgeDecisionTarget,
  ): Promise<RejectEdgeResult | null> {
    const raw: unknown = await this.options.db
      .query(
        "SELECT id, kind, target, before, after, client_identity, created_at FROM history WHERE id = $historyId LIMIT 1;",
        { historyId },
      )
      .collect();
    const rows = proposalStatementRows(raw, "proposal rejection audit lookup");
    if (rows.length === 0) return null;
    if (rows.length !== 1) {
      throw new Error("approval storage integrity: rejection audit lookup returned multiple rows");
    }
    return parseRejectionAudit(rows[0], historyId, input);
  }

  private async selectNote(noteId: RecordId<"note">): Promise<NoteRow | null> {
    const raw: unknown = await this.options.db
      .query("SELECT id, path FROM note WHERE id = $id AND tombstoned_at IS NONE LIMIT 1;", {
        id: noteId,
      })
      .collect();
    const rows = proposalStatementRows(raw, "approval note lookup");
    if (rows.length === 0) return null;
    if (rows.length !== 1) {
      throw new Error("approval storage integrity: note lookup returned multiple rows");
    }
    return parseNoteRow(rows[0], noteId);
  }
}

function normalizeDecisionPrincipal(value: unknown, decision: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${decision} principal must be a canonical nonblank string`);
  }
  return value;
}

function normalizeRejectingPrincipal(value: unknown): string {
  return normalizeDecisionPrincipal(value, "rejecting");
}

function parseApprovalInput(
  input: EdgeDecisionTarget,
  operation: string,
  allowedFields: readonly string[],
): EdgeDecisionTarget {
  if (!isRecord(input) || !hasOnlyKeys(input, allowedFields)) {
    throw new Error(`${operation}: input contains an unknown field`);
  }
  if (!isWritebackEdgeTable(input.table)) {
    throw new Error(`${operation}: table is not writeback-capable`);
  }
  const id = parseProposalEdgeRecordId(input.id, input.table).recordId;
  return { id, table: input.table };
}

function assertExpectedEdgeId(
  edge: StoredProposalEdge,
  input: EdgeDecisionTarget,
  operation: string,
): void {
  if (edge.recordId.toString() !== input.id.toString()) {
    throw new ProposalStorageIntegrityError(`${operation} returned a different edge id`);
  }
}

type ApprovalStoredProposalEdge = StoredProposalEdge & { approvedBy: string };

interface AcceptanceAudit {
  historyId: RecordId<"history">;
  kind: "note.append_section" | "note.frontmatter";
  target: string;
  beforeBody: string;
  afterBody: string;
  approvedBy: string;
  edge: RecordId<WritebackEdgeTable>;
  edgeCreatedAt: DateTime;
  createdAt: DateTime;
}

function parseApprovalIntent(value: unknown): ApprovalIntent {
  const fields = [
    "id",
    "edge",
    "table_name",
    "edge_created_at",
    "source_note",
    "target_note",
    "source_path",
    "target_path",
    "kind",
    "before_body",
    "after_body",
    "before_sha",
    "after_sha",
    "history_id",
    "approved_by",
    "producer",
    "tool_approval",
    "prepared_at",
    "write_started_at",
    "cancel_requested_at",
  ];
  if (!isRecord(value) || value instanceof RecordId || !hasExactKeys(value, fields)) {
    throw new ProposalStorageIntegrityError("approval intent row is malformed");
  }
  if (typeof value.table_name !== "string" || !isWritebackEdgeTable(value.table_name)) {
    throw new ProposalStorageIntegrityError("approval intent table is not writeback-capable");
  }
  const table = value.table_name;
  const edge = parseProposalEdgeRecordId(value.edge, table).recordId;
  const sourceNote = parseNativeRecordId(value.source_note, "note", "approval intent source");
  const targetNote = parseNativeRecordId(value.target_note, "note", "approval intent target");
  if (sourceNote.toString() === targetNote.toString()) {
    throw new ProposalStorageIntegrityError("approval intent endpoints must be different notes");
  }
  const kind = value.kind;
  if (kind !== "note.append_section" && kind !== "note.frontmatter") {
    throw new ProposalStorageIntegrityError("approval intent history kind is invalid");
  }
  if (typeof value.before_body !== "string" || typeof value.after_body !== "string") {
    throw new ProposalStorageIntegrityError("approval intent bodies must be strings");
  }
  assertSha256(value.before_sha, "approval intent before hash");
  assertSha256(value.after_sha, "approval intent after hash");
  const writeStartedAt =
    value.write_started_at === undefined
      ? undefined
      : parseNativeDateTime(value.write_started_at, "approval intent write_started_at");
  const cancelRequestedAt =
    value.cancel_requested_at === undefined
      ? undefined
      : parseNativeDateTime(value.cancel_requested_at, "approval intent cancel_requested_at");
  return {
    id: parseStoredUuidRecordId(value.id, "approval_intent", "approval intent id"),
    edge,
    table,
    edgeCreatedAt: parseNativeDateTime(value.edge_created_at, "approval intent edge_created_at"),
    sourceNote,
    targetNote,
    sourcePath: parseProposalNotePath(value.source_path, "approval intent source path"),
    targetPath: parseProposalNotePath(value.target_path, "approval intent target path"),
    kind,
    beforeBody: value.before_body,
    afterBody: value.after_body,
    beforeSha: value.before_sha,
    afterSha: value.after_sha,
    historyId: parseStoredUuidRecordId(value.history_id, "history", "approval intent history id"),
    approvedBy: normalizeDecisionPrincipal(value.approved_by, "stored approving"),
    producer: normalizeDecisionPrincipal(value.producer, "stored producing"),
    toolApproval:
      value.tool_approval === undefined
        ? undefined
        : toolApprovalSchema.parse(JSON.parse(String(value.tool_approval))),
    preparedAt: parseNativeDateTime(value.prepared_at, "approval intent prepared_at"),
    writeStartedAt,
    cancelRequestedAt,
  };
}

function parseApprovalDaemonWrite(
  value: unknown,
  expectedId: RecordId<"daemon_write">,
  intent: ApprovalIntent,
): void {
  const fields = ["id", "note", "sha", "agent", "targets", "approval_intent", "written_at"];
  if (!isRecord(value) || value instanceof RecordId || !hasExactKeys(value, fields)) {
    throw new ProposalStorageIntegrityError("approval daemon-write row is malformed");
  }
  const id = parseStoredUuidRecordId(value.id, "daemon_write", "approval daemon-write id");
  const note = parseNativeRecordId(value.note, "note", "approval daemon-write note");
  const intentId = parseStoredUuidRecordId(
    value.approval_intent,
    "approval_intent",
    "approval daemon-write intent",
  );
  if (
    id.toString() !== expectedId.toString() ||
    note.toString() !== intent.sourceNote.toString() ||
    value.sha !== intent.afterSha ||
    value.agent !== intent.producer ||
    intentId.toString() !== intent.id.toString() ||
    !Array.isArray(value.targets) ||
    value.targets.length !== 1 ||
    !(value.targets[0] instanceof RecordId) ||
    value.targets[0].toString() !== intent.targetNote.toString()
  ) {
    throw new ProposalStorageIntegrityError("approval daemon-write row changed identity");
  }
  parseNativeDateTime(value.written_at, "approval daemon-write written_at");
}

function parseAcceptanceAudit(
  value: unknown,
  expectedHistoryId: RecordId<"history">,
  input: EdgeDecisionTarget,
): AcceptanceAudit {
  const fields = [
    "id",
    "kind",
    "target",
    "before",
    "after",
    "client_identity",
    "proposal_edge",
    "proposal_created_at",
    "created_at",
  ];
  if (!isRecord(value) || value instanceof RecordId || !hasExactKeys(value, fields)) {
    throw new ProposalStorageIntegrityError("proposal acceptance audit row is malformed");
  }
  const historyId = parseStoredUuidRecordId(value.id, "history", "proposal acceptance audit id");
  const edge = parseProposalEdgeRecordId(value.proposal_edge, input.table).recordId;
  const expectedKind = isFrontmatterRelation(input.table)
    ? "note.frontmatter"
    : "note.append_section";
  const beforeBody = unwrapNativeValue(value.before, "proposal acceptance before");
  const afterBody = unwrapNativeValue(value.after, "proposal acceptance after");
  if (
    historyId.toString() !== expectedHistoryId.toString() ||
    edge.toString() !== input.id.toString() ||
    value.kind !== expectedKind ||
    typeof beforeBody !== "string" ||
    typeof afterBody !== "string"
  ) {
    throw new ProposalStorageIntegrityError("proposal acceptance audit identity is malformed");
  }
  return {
    historyId,
    kind: expectedKind,
    target: parseProposalNotePath(value.target, "proposal acceptance target"),
    beforeBody,
    afterBody,
    approvedBy: normalizeDecisionPrincipal(value.client_identity, "stored approving"),
    edge,
    edgeCreatedAt: parseNativeDateTime(
      value.proposal_created_at,
      "proposal acceptance edge revision",
    ),
    createdAt: parseNativeDateTime(value.created_at, "proposal acceptance created_at"),
  };
}

function assertIntentEqualsDraft(intent: ApprovalIntent, draft: ApprovalIntentDraft): void {
  const actual = approvalIntentIdentity(intent);
  const expected = approvalIntentIdentity(draft);
  if (actual !== expected) {
    throw new ProposalStorageIntegrityError(
      "stored approval intent differs from its prepared plan",
    );
  }
}

function assertIntentSame(actual: ApprovalIntent, expected: ApprovalIntent): void {
  if (
    approvalIntentIdentity(actual) !== approvalIntentIdentity(expected) ||
    actual.preparedAt.toString() !== expected.preparedAt.toString()
  ) {
    throw new ProposalStorageIntegrityError("approval intent changed during writeback");
  }
}

function approvalIntentIdentity(intent: ApprovalIntentDraft): string {
  return JSON.stringify({
    id: intent.id.toString(),
    edge: intent.edge.toString(),
    table: intent.table,
    edgeCreatedAt: intent.edgeCreatedAt.toString(),
    sourceNote: intent.sourceNote.toString(),
    targetNote: intent.targetNote.toString(),
    sourcePath: intent.sourcePath,
    targetPath: intent.targetPath,
    kind: intent.kind,
    beforeBody: intent.beforeBody,
    afterBody: intent.afterBody,
    beforeSha: intent.beforeSha,
    afterSha: intent.afterSha,
    historyId: intent.historyId.toString(),
    approvedBy: intent.approvedBy,
    producer: intent.producer,
    toolApproval: intent.toolApproval,
  });
}

function assertAcceptanceMatchesIntent(audit: AcceptanceAudit, intent: ApprovalIntent): void {
  if (
    audit.historyId.toString() !== intent.historyId.toString() ||
    audit.edge.toString() !== intent.edge.toString() ||
    audit.edgeCreatedAt.toString() !== intent.edgeCreatedAt.toString() ||
    audit.kind !== intent.kind ||
    audit.target !== intent.sourcePath ||
    audit.beforeBody !== intent.beforeBody ||
    audit.afterBody !== intent.afterBody ||
    audit.approvedBy !== intent.approvedBy
  ) {
    throw new ProposalStorageIntegrityError("acceptance receipt differs from its write intent");
  }
}

function parseNativeDateTime(value: unknown, label: string): DateTime {
  if (!(value instanceof DateTime) || !Number.isFinite(value.toDate().getTime())) {
    throw new ProposalStorageIntegrityError(`${label} must be a native valid datetime`);
  }
  return value;
}

function parseApprovalEdge(
  value: unknown,
  table: WritebackEdgeTable,
  state: "pending",
  operation: "selected" | "mutation",
): StoredProposalEdge & { approvedBy: undefined };
function parseApprovalEdge(
  value: unknown,
  table: WritebackEdgeTable,
  state: "applying" | "applied",
  operation: "selected" | "mutation",
): ApprovalStoredProposalEdge;
function parseApprovalEdge(
  value: unknown,
  table: WritebackEdgeTable,
  state: "pending" | "applying" | "applied",
  operation: "selected" | "mutation",
): StoredProposalEdge & { approvedBy: string | undefined } {
  if (!isRecord(value) || value instanceof RecordId) {
    throw new ProposalStorageIntegrityError(`${table} approval edge must be an object`);
  }
  if (operation === "selected" && !Object.hasOwn(value, "approved_by")) {
    throw new ProposalStorageIntegrityError("selected approval edge omitted approved_by");
  }
  const { approved_by: approvedByRaw, ...proposalRow } = value;
  const edge =
    operation === "selected"
      ? parseSelectedProposalEdge(proposalRow, table, state)
      : parseMutatedProposalEdge(proposalRow, table, state);
  if (state === "pending") {
    if (approvedByRaw !== undefined) {
      throw new ProposalStorageIntegrityError("pending proposal must not have approved_by");
    }
    return { ...edge, approvedBy: undefined };
  }
  try {
    return {
      ...edge,
      approvedBy: normalizeDecisionPrincipal(approvedByRaw, "stored approving"),
    };
  } catch (cause) {
    throw new ProposalStorageIntegrityError(
      `${state} proposal must retain its approving principal`,
      { cause },
    );
  }
}

function parseNoteRow(value: unknown, expectedId: RecordId<"note">): NoteRow {
  if (!isRecord(value) || value instanceof RecordId || !hasExactKeys(value, ["id", "path"])) {
    throw new Error("approval storage integrity: note lookup returned a malformed row");
  }
  const id = parseNativeRecordId(value.id, "note", "approval note id");
  if (id.toString() !== expectedId.toString()) {
    throw new Error("approval storage integrity: note lookup returned a different id");
  }
  return { id, path: parseProposalNotePath(value.path, "approval note path") };
}

function parseCloseTransactionAck(raw: unknown): boolean {
  if (
    !Array.isArray(raw) ||
    raw.length !== 7 ||
    raw[0] !== undefined ||
    raw[1] !== undefined ||
    raw[2] !== undefined ||
    raw[3] !== undefined ||
    raw[5] !== undefined ||
    typeof raw[6] !== "boolean"
  ) {
    throw new Error("approval storage integrity: close transaction returned an invalid envelope");
  }
  if (raw[6] === false) {
    if (raw[4] !== undefined) {
      throw new Error("approval storage integrity: skipped close returned an invalid branch");
    }
    return false;
  }
  if (!Array.isArray(raw[4]) || raw[4].length !== 0) {
    throw new Error("approval storage integrity: applied close returned an invalid branch");
  }
  return true;
}

function parseCancellationTransactionAck(raw: unknown): boolean {
  if (
    !Array.isArray(raw) ||
    raw.length !== 7 ||
    raw[0] !== undefined ||
    raw[1] !== undefined ||
    raw[2] !== undefined ||
    raw[3] !== undefined ||
    raw[5] !== undefined ||
    raw[6] !== true ||
    raw[4] !== undefined
  ) {
    throw new Error(
      "approval storage integrity: cancellation transaction returned an invalid envelope",
    );
  }
  return true;
}

function parseCancellationGenerationAck(raw: unknown): boolean {
  if (
    !Array.isArray(raw) ||
    raw.length !== 5 ||
    raw[0] !== undefined ||
    raw[1] !== undefined ||
    !Array.isArray(raw[2]) ||
    raw[2].length !== 0 ||
    raw[3] !== undefined ||
    typeof raw[4] !== "boolean"
  ) {
    throw new Error(
      "approval storage integrity: deletion generation transaction returned an invalid envelope",
    );
  }
  return raw[4];
}

function parseRejectionTransactionAck(raw: unknown): boolean {
  if (
    !Array.isArray(raw) ||
    raw.length !== 7 ||
    raw[0] !== undefined ||
    raw[1] !== undefined ||
    raw[2] !== undefined ||
    raw[3] !== undefined ||
    raw[5] !== undefined ||
    typeof raw[6] !== "boolean"
  ) {
    throw new Error(
      "approval storage integrity: rejection transaction returned an invalid envelope",
    );
  }
  if (raw[6] === true) {
    if (!Array.isArray(raw[4]) || raw[4].length !== 0) {
      throw new Error(
        "approval storage integrity: rejection transaction returned an invalid applied branch",
      );
    }
    return true;
  }
  if (raw[4] !== undefined) {
    throw new Error(
      "approval storage integrity: rejection transaction returned an invalid skipped branch",
    );
  }
  return false;
}

function parseRejectionAudit(
  value: unknown,
  expectedHistoryId: RecordId<"history">,
  input: EdgeDecisionTarget,
): RejectEdgeResult {
  const fields = ["id", "kind", "target", "before", "after", "client_identity", "created_at"];
  if (!isRecord(value) || value instanceof RecordId || !hasExactKeys(value, fields)) {
    throw new Error("approval storage integrity: rejection audit row is malformed");
  }
  const historyId = stringifyUuidRecordId(value.id, "history", "proposal rejection audit id");
  if (historyId !== expectedHistoryId.toString()) {
    throw new Error("approval storage integrity: rejection audit lookup returned a different id");
  }
  if (
    value.kind !== "proposal.reject" ||
    value.target !== input.id.toString() ||
    typeof value.client_identity !== "string" ||
    value.client_identity.length === 0 ||
    value.client_identity.trim() !== value.client_identity ||
    !(value.created_at instanceof DateTime) ||
    !Number.isFinite(value.created_at.toDate().getTime())
  ) {
    throw new Error("approval storage integrity: rejection audit metadata is malformed");
  }
  parseRejectionProposalSnapshot(value.before, input);
  return { historyId, reason: rejectionReasonFromAudit(value.after) };
}

function parseRejectionProposalSnapshot(raw: unknown, input: EdgeDecisionTarget): void {
  const parsed = unwrapNativeValue(raw, "proposal rejection audit before");
  const fields = [
    "id",
    "table",
    "in",
    "out",
    "source",
    "class",
    "agent",
    "confidence",
    "evidence",
    "approved",
    "applied",
    "created_at",
  ];
  if (!isRecord(parsed) || !hasExactKeys(parsed, fields) || parsed.table !== input.table) {
    throw new Error("approval storage integrity: rejection audit proposal snapshot is malformed");
  }
  if (!Array.isArray(parsed.evidence)) {
    throw new Error("approval storage integrity: rejection audit evidence must be an array");
  }
  const evidence =
    parsed.evidence.length === 0
      ? undefined
      : parsed.evidence.map((entry) =>
          parseNativeRecordId(entry, "chunk", "proposal rejection audit evidence"),
        );
  const edge = parseSelectedProposalEdge(
    {
      id: parsed.id,
      in: parsed.in,
      out: parsed.out,
      source: parsed.source,
      class: parsed.class,
      agent: parsed.agent,
      confidence: parsed.confidence,
      evidence,
      approved: parsed.approved,
      applied: parsed.applied,
      created_at: parsed.created_at,
    },
    input.table,
    "pending",
  );
  assertExpectedEdgeId(edge, input, "rejection audit snapshot");
}

function rejectionReasonFromAudit(raw: unknown): string | null {
  const parsed = unwrapNativeValue(raw, "proposal rejection audit");
  if (!isRecord(parsed) || !hasExactKeys(parsed, ["decision", "reason"])) {
    throw new Error("proposal rejection audit has an invalid decision payload");
  }
  if (parsed.decision !== "rejected") {
    throw new Error("proposal rejection audit does not describe a rejected decision");
  }
  if (parsed.reason === null) return null;
  if (typeof parsed.reason !== "string") {
    throw new Error("proposal rejection audit has an invalid reason");
  }
  const canonical = normalizeRejectionReason(parsed.reason);
  if (canonical !== parsed.reason) {
    throw new Error("proposal rejection audit has a noncanonical reason");
  }
  return parsed.reason;
}

function assertSha256(raw: unknown, label: string): asserts raw is string {
  if (typeof raw !== "string" || !/^[a-f0-9]{64}$/.test(raw)) {
    throw new Error(`${label} must be a lowercase SHA-256 hex digest`);
  }
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function hasOnlyKeys(raw: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(raw).every((field) => allowed.includes(field));
}

function hasExactKeys(raw: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Object.keys(raw).length === expected.length &&
    expected.every((field) => Object.hasOwn(raw, field))
  );
}

function isMissingVaultEntry(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return "non-Error approval reconciliation failure";
}
