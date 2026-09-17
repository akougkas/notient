import { createHash } from "node:crypto";
import type { RecordId, Surreal } from "surrealdb";
import { type ProposalProvenance, proposalProvenanceSchema } from "../../api/proposals";
import type { WritebackEdgeTable } from "../db/edgeTables";
import { withSurrealRetry } from "../db/retry";
import { proposalRejectionHistoryId, proposalRelationRecordId } from "./proposalIdentity";
import {
  PROPOSAL_EDGE_PROJECTION,
  type ProposalSource,
  ProposalStorageIntegrityError,
  type StoredProposalEdge,
  type StoredProposalState,
  parseMutatedProposalEdge,
  parseNativeRecordId,
  parseSelectedProposalEdge,
  proposalProvenanceIssue,
} from "./proposalStorage";

export interface StagePendingProposalInput {
  readonly relation: WritebackEdgeTable;
  readonly from: RecordId<"note">;
  readonly to: RecordId<"note">;
  readonly source: ProposalSource;
  readonly agent: string;
  readonly confidence: number;
  readonly evidence?: readonly RecordId<"chunk">[];
  readonly provenance?: ProposalProvenance;
}

export type StagePendingProposalResult =
  | { readonly kind: "rejected"; readonly edgeId: RecordId<WritebackEdgeTable> }
  | { readonly kind: "unavailable"; readonly edgeId: RecordId<WritebackEdgeTable> }
  | {
      readonly kind: "created" | "existing";
      readonly edgeId: RecordId<WritebackEdgeTable>;
      readonly state: StoredProposalState;
      readonly edge: StoredProposalEdge;
    };

/**
 * System-wide pending-edge writer. Every producer converges on the same
 * typed endpoint identity, and a durable human rejection is terminal.
 */
export async function stagePendingProposal(
  db: Surreal,
  input: StagePendingProposalInput,
): Promise<StagePendingProposalResult> {
  const from = parseNativeRecordId(input.from, "note", "proposal source endpoint");
  const to = parseNativeRecordId(input.to, "note", "proposal target endpoint");
  if (from.toString() === to.toString()) {
    throw new ProposalStorageIntegrityError("proposal endpoints must be different notes");
  }
  const provenanceIssue = proposalProvenanceIssue({
    source: input.source,
    agent: input.agent,
    table: input.relation,
    confidence: input.confidence,
    evidenceCount: input.evidence?.length ?? 0,
  });
  if (provenanceIssue !== null) throw new ProposalStorageIntegrityError(provenanceIssue);
  const provenance =
    input.provenance === undefined ? undefined : proposalProvenanceSchema.parse(input.provenance);
  const evidenceRevision =
    provenance === undefined
      ? undefined
      : createHash("sha256").update(JSON.stringify(provenance.sources)).digest("hex");
  const edgeId = proposalRelationRecordId(input.relation, from, to, evidenceRevision);
  const rejectionHistoryId = await proposalRejectionHistoryId(edgeId);
  const transaction = `BEGIN;
LET $liveEndpoints = (SELECT VALUE id FROM note WHERE id IN [$from, $to] AND tombstoned_at IS NONE);
LET $existing = (SELECT ${PROPOSAL_EDGE_PROJECTION} FROM ${input.relation} WHERE id = $edgeId OR (in = $from AND out = $to AND (!$versioned OR (approved = true AND applied = true))));
LET $rejected = record::exists($rejectionHistoryId);
IF array::len($liveEndpoints) != 2 {
  { unavailable: true }
} ELSE IF $rejected {
  { rejected: true }
} ELSE {
  IF array::len($existing) = 0 {
    RELATE ONLY $from->$edgeId->$to CONTENT { source: $source, class: 'INFERRED', confidence: $confidence, evidence: $evidence, provenance: $provenance, agent: $agent, approved: false, applied: true } RETURN AFTER
  } ELSE {
    $existing
  }
};
COMMIT;`;
  const raw = await withSurrealRetry(
    async () =>
      (await db
        .query(transaction, {
          edgeId,
          rejectionHistoryId,
          from,
          to,
          source: input.source,
          agent: input.agent,
          confidence: input.confidence,
          evidence: input.evidence,
          versioned: provenance !== undefined,
          provenance: provenance === undefined ? undefined : JSON.stringify(provenance),
        })
        .collect()) as unknown,
    { idempotencyKey: edgeId.toString() },
  );
  return parseStagePendingProposal(raw, { ...input, from, to }, edgeId);
}

function parseStagePendingProposal(
  raw: unknown,
  input: StagePendingProposalInput,
  edgeId: RecordId<WritebackEdgeTable>,
): StagePendingProposalResult {
  const branch = stageTransactionBranch(raw);
  if (isRecord(branch) && hasExactKeys(branch, ["rejected"]) && branch.rejected === true) {
    return { kind: "rejected", edgeId };
  }
  if (isRecord(branch) && hasExactKeys(branch, ["unavailable"]) && branch.unavailable === true) {
    return { kind: "unavailable", edgeId };
  }
  return parseLiveStageBranch(branch, input, edgeId);
}

function stageTransactionBranch(raw: unknown): unknown {
  if (
    !Array.isArray(raw) ||
    raw.length !== 6 ||
    raw[0] !== undefined ||
    raw[1] !== undefined ||
    raw[2] !== undefined ||
    raw[3] !== undefined ||
    raw[5] !== undefined
  ) {
    throw new ProposalStorageIntegrityError(
      "pending proposal transaction returned an invalid statement envelope",
    );
  }
  return raw[4];
}

function parseLiveStageBranch(
  branch: unknown,
  input: StagePendingProposalInput,
  edgeId: RecordId<WritebackEdgeTable>,
): Exclude<StagePendingProposalResult, { kind: "rejected" }> {
  const existing = Array.isArray(branch);
  if (existing && branch.length !== 1) {
    throw new ProposalStorageIntegrityError(
      "duplicate relation lookup must return exactly one edge",
    );
  }
  const state = existing ? storedProposalState(branch[0]) : "pending";
  const edge = existing
    ? parseSelectedProposalEdge(branch[0], input.relation, state)
    : parseMutatedProposalEdge(branch, input.relation, state);
  if (
    edge.fromId.toString() !== input.from.toString() ||
    edge.toId.toString() !== input.to.toString()
  ) {
    throw new ProposalStorageIntegrityError(
      "pending proposal transaction returned different relation endpoints",
    );
  }
  if (!existing) assertCreatedProposal(edge, input, edgeId);
  return { kind: existing ? "existing" : "created", edgeId, state, edge };
}

function assertCreatedProposal(
  edge: StoredProposalEdge,
  input: StagePendingProposalInput,
  edgeId: RecordId<WritebackEdgeTable>,
): void {
  const requestedEvidence = input.evidence?.map((entry) => entry.toString()) ?? [];
  const storedEvidence = edge.evidence?.map((entry) => entry.toString()) ?? [];
  const mismatchedEvidence =
    storedEvidence.length !== requestedEvidence.length ||
    storedEvidence.some((entry, index) => entry !== requestedEvidence[index]);
  if (
    edge.recordId.toString() !== edgeId.toString() ||
    edge.source !== input.source ||
    edge.agent !== input.agent ||
    edge.confidence !== input.confidence ||
    mismatchedEvidence
  ) {
    throw new ProposalStorageIntegrityError(
      "created pending proposal does not match the requested provenance",
    );
  }
}

function storedProposalState(value: unknown): StoredProposalState {
  if (!isRecord(value)) {
    throw new ProposalStorageIntegrityError("duplicate lookup row must be an object");
  }
  if (value.approved === false && value.applied === true) return "pending";
  if (value.approved === true && value.applied === false) return "applying";
  if (value.approved === true && value.applied === true) return "applied";
  throw new ProposalStorageIntegrityError("duplicate lookup returned an invalid proposal state");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((field) => Object.hasOwn(value, field))
  );
}
