import { DateTime, RecordId } from "surrealdb";
import { type ProposalProvenance, proposalProvenanceSchema } from "../../api/proposals";
import { isCanonicalAgentId } from "../auth/agentIdentity";
import { nativeDateTimeToEpochMillis } from "../db/dateTime";
import type { WritebackEdgeTable } from "../db/edgeTables";
import { parseSurrealRelationRecordId } from "../db/recordId";
import { isCanonicalOrdinaryNotePath } from "../vault/publicPath";

export const PENDING_PROPOSAL_PROJECTION =
  "id, in AS fromId, out AS toId, in.path AS fromPath, out.path AS toPath, source, class, agent, confidence, evidence, approved, applied, created_at";

/** Canonical persisted edge projection used by approval state transitions. */
export const PROPOSAL_EDGE_PROJECTION =
  "id, in, out, source, class, agent, confidence, evidence, approved, applied, created_at, provenance";

export type ProposalProducer =
  | "linker"
  | "synthesizer"
  | "contradictionHunter"
  | "pipeline-relate"
  | "pipeline-contradictions"
  | "pipeline-inbox";

/** Authority recorded on a pending edge proposal. */
export type ProposalSource = ProposalProducer | "user";

export function isProposalProducer(value: unknown): value is ProposalProducer {
  return (
    value === "linker" ||
    value === "synthesizer" ||
    value === "contradictionHunter" ||
    value === "pipeline-relate" ||
    value === "pipeline-contradictions" ||
    value === "pipeline-inbox"
  );
}

export function isProposalSource(value: unknown): value is ProposalSource {
  return value === "user" || isProposalProducer(value);
}

/** Agent filter accepts both authenticated clients and autonomous producers. */
export function isProposalAgentFilter(value: unknown): value is string {
  return isProposalProducer(value) || isCanonicalAgentId(value);
}

export class ProposalStorageIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`proposal storage integrity: ${message}`, options);
    this.name = "ProposalStorageIntegrityError";
  }
}

export interface StoredPendingProposal {
  id: string;
  recordId: RecordId<WritebackEdgeTable>;
  table: WritebackEdgeTable;
  fromId: RecordId<"note">;
  toId: RecordId<"note">;
  fromPath: string;
  toPath: string;
  source: ProposalSource;
  agent: string;
  confidence: number;
  evidence: Array<RecordId<"chunk">>;
  createdAt: number;
}

export type StoredProposalState = "pending" | "applying" | "applied";

/** Native proposal row retained for approval writeback and audit snapshots. */
export interface StoredProposalEdge {
  provenance?: ProposalProvenance;
  recordId: RecordId<WritebackEdgeTable>;
  table: WritebackEdgeTable;
  fromId: RecordId<"note">;
  toId: RecordId<"note">;
  source: ProposalSource;
  agent: string;
  confidence: number;
  evidence: Array<RecordId<"chunk">> | undefined;
  approved: boolean;
  applied: boolean;
  createdAt: DateTime;
}

function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decode exactly one SurrealQL statement's row array. */
export function proposalStatementRows(raw: unknown, operation: string): unknown[] {
  if (!Array.isArray(raw) || raw.length !== 1 || !Array.isArray(raw[0])) {
    throw new ProposalStorageIntegrityError(`${operation} returned an invalid statement envelope`);
  }
  return raw[0];
}

export function parseNativeRecordId<TableName extends string>(
  value: unknown,
  table: TableName,
  field: string,
): RecordId<TableName> {
  if (!isNativeRecordIdForTable(value, table)) {
    throw new ProposalStorageIntegrityError(`${field} must be a native ${table} record id`);
  }
  return value;
}

function isNativeRecordIdForTable<TableName extends string>(
  value: unknown,
  table: TableName,
): value is RecordId<TableName> {
  return value instanceof RecordId && value.table.name === table;
}

export function parseProposalEdgeRecordId(
  value: unknown,
  table: WritebackEdgeTable,
): { id: string; recordId: RecordId<WritebackEdgeTable> } {
  if (!(value instanceof RecordId)) {
    throw new ProposalStorageIntegrityError("id must be a native SurrealDB relation record id");
  }
  try {
    const parsed = parseSurrealRelationRecordId(value.toString(), [table], "stored proposal id");
    return {
      id: parsed.id,
      recordId: parseNativeRecordId(value, table, "stored proposal id"),
    };
  } catch (cause) {
    throw new ProposalStorageIntegrityError(`id must be a canonical ${table} relation record id`, {
      cause,
    });
  }
}

export function parseProposalNotePath(value: unknown, field: string): string {
  if (!isCanonicalOrdinaryNotePath(value)) {
    throw new ProposalStorageIntegrityError(
      `${field} must resolve to a non-empty note path in canonical vault-relative form`,
    );
  }
  return value;
}

export interface ProposalProvenanceInput {
  source: unknown;
  agent: unknown;
  table: WritebackEdgeTable;
  confidence: number;
  evidenceCount: number;
}

/** One authority matrix shared by database and untrusted wire decoders. */
export function proposalProvenanceIssue(input: ProposalProvenanceInput): string | null {
  const { source, agent, table, confidence, evidenceCount } = input;
  if (!Number.isSafeInteger(evidenceCount) || evidenceCount < 0) {
    return "proposal evidence count must be a nonnegative safe integer";
  }
  if (source === "user") {
    if (!isCanonicalAgentId(agent)) {
      return "a user proposal agent must be a canonical authenticated client identity";
    }
    if (confidence !== 1) return "an explicit user proposal must have confidence 1";
    if (evidenceCount !== 0) return "an explicit user proposal must not invent evidence";
    return null;
  }
  if (!isProposalProducer(source)) return "source is not a proposal-producing authority";
  if (agent !== source) return "agent must exactly match the proposal source";
  if (source === "synthesizer" && table !== "synthesizes") {
    return "synthesizer may only author synthesizes proposals";
  }
  if (source === "contradictionHunter" && table !== "contradicts") {
    return "contradictionHunter may only author contradicts proposals";
  }
  return null;
}

function proposalAuthor(
  source: unknown,
  agent: unknown,
  table: WritebackEdgeTable,
  confidence: number,
  evidenceCount: number,
): { source: ProposalSource; agent: string } {
  const issue = proposalProvenanceIssue({ source, agent, table, confidence, evidenceCount });
  if (issue !== null) throw new ProposalStorageIntegrityError(issue);
  return { source: source as ProposalSource, agent: agent as string };
}

function proposalConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ProposalStorageIntegrityError("confidence must be a finite number from 0 through 1");
  }
  return value;
}

function nativeProposalEvidence(value: unknown): Array<RecordId<"chunk">> | undefined {
  // SurrealDB 3.0.5 returns an option field set to NONE as `undefined`.
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProposalStorageIntegrityError(
      "evidence must be NONE or a non-empty array of native chunk record ids",
    );
  }
  const evidence = value.map((entry) => parseNativeRecordId(entry, "chunk", "evidence entry"));
  const ids = new Set(evidence.map((entry) => entry.toString()));
  if (ids.size !== evidence.length) {
    throw new ProposalStorageIntegrityError("evidence must not contain duplicate chunk ids");
  }
  return evidence;
}

function nativeProposalCreatedAt(value: unknown): DateTime {
  if (!(value instanceof DateTime)) {
    throw new ProposalStorageIntegrityError("created_at must be a native SurrealDB datetime");
  }
  const epoch = nativeDateTimeToEpochMillis(value);
  if (epoch === null || !Number.isFinite(epoch)) {
    throw new ProposalStorageIntegrityError("created_at is not a valid datetime");
  }
  return value;
}

function proposalCreatedAt(value: unknown): number {
  return nativeProposalCreatedAt(value).toDate().getTime();
}

const HYDRATED_PROPOSAL_FIELDS = [
  "id",
  "fromId",
  "toId",
  "fromPath",
  "toPath",
  "source",
  "class",
  "agent",
  "confidence",
  "evidence",
  "approved",
  "applied",
  "created_at",
] as const;

const PROPOSAL_EDGE_FIELDS = [
  "id",
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
] as const;

const PROPOSAL_EDGE_FIELDS_WITHOUT_NONE_EVIDENCE = PROPOSAL_EDGE_FIELDS.filter(
  (field) => field !== "evidence",
);

/** Decode one explicitly projected proposal edge in an exact persisted state. */
export function parseSelectedProposalEdge(
  value: unknown,
  table: WritebackEdgeTable,
  state: StoredProposalState,
): StoredProposalEdge {
  return parseProposalEdge(value, table, state, "selected");
}

/**
 * Decode `UPDATE ... RETURN BEFORE|AFTER`. SurrealDB 3.0.5 omits an option
 * field whose value is NONE from mutation-return objects, while an explicit
 * SELECT projection includes the same field as `undefined`.
 */
export function parseMutatedProposalEdge(
  value: unknown,
  table: WritebackEdgeTable,
  state: StoredProposalState,
): StoredProposalEdge {
  return parseProposalEdge(value, table, state, "mutation");
}

function parseProposalEdge(
  value: unknown,
  table: WritebackEdgeTable,
  state: StoredProposalState,
  operation: "selected" | "mutation",
): StoredProposalEdge {
  if (!isRow(value) || value instanceof RecordId) {
    throw new ProposalStorageIntegrityError(`${table} proposal edge must be an object`);
  }
  const { provenance: rawProvenance, ...fields } = value;
  assertProposalEdgeKeys(fields, operation);
  const provenance =
    rawProvenance === undefined
      ? undefined
      : proposalProvenanceSchema.parse(JSON.parse(String(rawProvenance)));
  const id = parseProposalEdgeRecordId(value.id, table);
  const { fromId, toId } = proposalEndpoints(value.in, value.out);
  if (value.class !== "INFERRED") {
    throw new ProposalStorageIntegrityError("class must be INFERRED");
  }
  const confidence = proposalConfidence(value.confidence);
  const evidence = nativeProposalEvidence(value.evidence);
  const author = proposalAuthor(
    value.source,
    value.agent,
    table,
    confidence,
    evidence?.length ?? 0,
  );
  const expected = proposalState(state);
  if (value.approved !== expected.approved || value.applied !== expected.applied) {
    throw new ProposalStorageIntegrityError(
      `${state} state must be approved = ${expected.approved} and applied = ${expected.applied}`,
    );
  }
  return {
    recordId: id.recordId,
    table,
    fromId,
    toId,
    source: author.source,
    agent: author.agent,
    confidence,
    evidence,
    approved: expected.approved,
    applied: expected.applied,
    createdAt: nativeProposalCreatedAt(value.created_at),
    ...(provenance === undefined ? {} : { provenance }),
  };
}

function assertProposalEdgeKeys(
  row: Record<string, unknown>,
  operation: "selected" | "mutation",
): void {
  if (operation === "selected" && hasExactKeys(row, PROPOSAL_EDGE_FIELDS)) return;
  if (operation === "mutation") {
    if (hasExactKeys(row, PROPOSAL_EDGE_FIELDS_WITHOUT_NONE_EVIDENCE)) return;
    if (hasExactKeys(row, PROPOSAL_EDGE_FIELDS) && row.evidence !== undefined) return;
  }
  throw new ProposalStorageIntegrityError(
    `${operation} proposal edge returned an invalid field projection`,
  );
}

function proposalState(state: StoredProposalState): { approved: boolean; applied: boolean } {
  if (state === "pending") return { approved: false, applied: true };
  if (state === "applying") return { approved: true, applied: false };
  return { approved: true, applied: true };
}

/**
 * Decode the complete persisted contract for an edge that is still awaiting
 * a human decision. The query may filter on these fields, but the storage
 * boundary verifies them independently so corrupt rows never reach a client.
 */
export function parseStoredPendingProposal(
  value: unknown,
  table: WritebackEdgeTable,
): StoredPendingProposal {
  if (!isRow(value) || value instanceof RecordId) {
    throw new ProposalStorageIntegrityError(`${table} proposal row must be an object`);
  }
  if (!hasExactKeys(value, HYDRATED_PROPOSAL_FIELDS)) {
    throw new ProposalStorageIntegrityError(`${table} proposal row has an invalid projection`);
  }
  const id = parseProposalEdgeRecordId(value.id, table);
  const { fromId, toId } = proposalEndpoints(value.fromId, value.toId);
  const fromPath = parseProposalNotePath(value.fromPath, "source endpoint");
  const toPath = parseProposalNotePath(value.toPath, "target endpoint");
  if (value.class !== "INFERRED") {
    throw new ProposalStorageIntegrityError("class must be INFERRED");
  }
  const confidence = proposalConfidence(value.confidence);
  const evidence = nativeProposalEvidence(value.evidence);
  const author = proposalAuthor(
    value.source,
    value.agent,
    table,
    confidence,
    evidence?.length ?? 0,
  );
  if (value.approved !== false || value.applied !== true) {
    throw new ProposalStorageIntegrityError(
      "pending state must be approved = false and applied = true",
    );
  }
  return {
    ...id,
    table,
    fromId,
    toId,
    fromPath,
    toPath,
    source: author.source,
    agent: author.agent,
    confidence,
    evidence: evidence ?? [],
    createdAt: proposalCreatedAt(value.created_at),
  };
}

function hasExactKeys(row: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Object.keys(row).length === expected.length &&
    expected.every((field) => Object.hasOwn(row, field))
  );
}

function proposalEndpoints(
  from: unknown,
  to: unknown,
): { fromId: RecordId<"note">; toId: RecordId<"note"> } {
  const fromId = parseNativeRecordId(from, "note", "source endpoint");
  const toId = parseNativeRecordId(to, "note", "target endpoint");
  if (fromId.toString() === toId.toString()) {
    throw new ProposalStorageIntegrityError("proposal endpoints must be different notes");
  }
  return { fromId, toId };
}

/** Decode a pending lookup: a valid empty result or one complete exact row. */
export function parsePendingProposalLookup(
  raw: unknown,
  table: WritebackEdgeTable,
  expectedId: string,
): StoredPendingProposal | null {
  const rows = proposalStatementRows(raw, `${table} pending lookup`);
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new ProposalStorageIntegrityError(`${table} pending lookup must return at most one row`);
  }
  const proposal = parseStoredPendingProposal(rows[0], table);
  if (proposal.id !== expectedId) {
    throw new ProposalStorageIntegrityError(`${table} pending lookup returned a different id`);
  }
  return proposal;
}

/** Decode the batched snippets for the exact chunk ids selected for display. */
export function parseProposalEvidenceTextRows(
  raw: unknown,
  expected: readonly RecordId<"chunk">[],
): Map<string, string> {
  const rows = proposalStatementRows(raw, "proposal evidence lookup");
  const expectedIds = new Set(expected.map((id) => id.toString()));
  if (expectedIds.size !== expected.length) {
    throw new ProposalStorageIntegrityError("evidence lookup received duplicate requested ids");
  }
  if (rows.length !== expected.length) {
    throw new ProposalStorageIntegrityError(
      "evidence lookup did not return exactly one row for every requested chunk",
    );
  }
  const texts = new Map<string, string>();
  for (const value of rows) {
    if (!isRow(value) || value instanceof RecordId || !hasExactKeys(value, ["id", "text"])) {
      throw new ProposalStorageIntegrityError("evidence lookup row has an invalid projection");
    }
    const id = parseNativeRecordId(value.id, "chunk", "evidence lookup id").toString();
    if (!expectedIds.has(id)) {
      throw new ProposalStorageIntegrityError("evidence lookup returned an unexpected chunk id");
    }
    if (texts.has(id)) {
      throw new ProposalStorageIntegrityError("evidence lookup returned a duplicate chunk row");
    }
    if (typeof value.text !== "string" || value.text.trim().length === 0) {
      throw new ProposalStorageIntegrityError("evidence lookup returned blank chunk text");
    }
    texts.set(id, value.text);
  }
  return texts;
}

export function assertProposalLimit(value: number, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`proposal limit must be an integer from 1 through ${maximum}`);
  }
  return value;
}
