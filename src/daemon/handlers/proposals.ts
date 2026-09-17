import { toolApproval } from "../../core/chat/toolAuthority";
/**
 * `links.proposals` / `proposals.propose_link` / decision handlers.
 *
 * Both the CLI and TUI call these handlers. The daemon owns the sole
 * `ApprovalService` and SurrealDB connection, so proposal decisions share
 * one live event bus, one attribution boundary, and one writeback queue.
 *
 * `list` adds what the CLI does not need and the human does: up to two
 * evidence snippets per proposal, fetched from the `chunk` rows the
 * linker recorded in the edge's `evidence` array.
 *
 * `propose_link` lets an authenticated agent stage one explicit typed edge
 * in the same pending queue. It cannot approve or reject that edge. A stable
 * relation id makes a lost response or concurrent replay by the same client
 * converge, while any edge with different provenance or state is refused.
 *
 * Idempotence matches the CLI: approving or rejecting an id that is no
 * longer pending returns `found: false` rather than throwing, so a stale
 * Inbox row does not turn into an error banner.
 */

import { RecordId, type Surreal } from "surrealdb";
import { type VaultAdapter, VaultPathError } from "../../adapters/vaultAdapter";
import type { ApprovalService } from "../../core/approvals/approvalService";
import { proposalRelationRecordId } from "../../core/approvals/proposalIdentity";
import {
  PENDING_PROPOSAL_PROJECTION,
  ProposalStorageIntegrityError,
  type StoredPendingProposal,
  assertProposalLimit,
  isProposalAgentFilter,
  parseNativeRecordId,
  parseProposalEvidenceTextRows,
  parseStoredPendingProposal,
  proposalStatementRows,
} from "../../core/approvals/proposalStorage";
import {
  type StagePendingProposalResult,
  stagePendingProposal,
} from "../../core/approvals/proposalWriter";
import { normalizeRejectionReason } from "../../core/approvals/rejectionReason";
import { isCanonicalAgentId } from "../../core/auth/agentIdentity";
import {
  WRITEBACK_EDGE_TABLES,
  type WritebackEdgeTable,
  isWritebackEdgeTable,
} from "../../core/db/edgeTables";
import { parseSurrealRelationRecordId } from "../../core/db/recordId";
import { isCanonicalOrdinaryNotePath } from "../../core/vault/publicPath";
import { RpcError, type RpcRequestContext } from "../rpc";
import type {
  ProposalEvidenceWire,
  ProposalWire,
  ProposalsApproveResult,
  ProposalsListResult,
  ProposalsProposeLinkResult,
  ProposalsRejectResult,
} from "../wire";

export interface ProposalsHandlerDeps {
  db: Surreal;
  approvalService: Pick<ApprovalService, "approveEdge" | "rejectEdge">;
  vault: Pick<VaultAdapter, "exists">;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const EVIDENCE_PER_PROPOSAL = 2;

/**
 * Resolves every referenced chunk in one query.
 *
 * Fetching snippets one row at a time turned a page of 50 proposals into up
 * to 100 round trips to SurrealDB. The ids are collected across the whole
 * page first and looked up with a single `IN` filter.
 */
async function fetchEvidenceTexts(
  db: Surreal,
  ids: readonly RecordId<"chunk">[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const result: unknown = await db
    .query("SELECT id, text FROM chunk WHERE id IN $ids;", { ids })
    .collect();
  return parseProposalEvidenceTextRows(result, ids);
}

function projectProposal(
  proposal: StoredPendingProposal,
  texts: Map<string, string>,
): ProposalWire {
  const evidence = proposal.evidence.slice(0, EVIDENCE_PER_PROPOSAL).map((chunkId) => {
    const id = chunkId.toString();
    const text = texts.get(id);
    if (text === undefined) {
      throw new Error(`proposal storage integrity: resolved evidence ${id} is missing`);
    }
    return { chunkId: id, text } satisfies ProposalEvidenceWire;
  });
  return {
    id: proposal.id,
    table: proposal.table,
    fromNotePath: proposal.fromPath,
    toNotePath: proposal.toPath,
    confidence: proposal.confidence,
    source: proposal.source,
    agent: proposal.agent,
    createdAt: proposal.createdAt,
    evidence,
  };
}

/**
 * Round-robins the per-table pages into one list.
 *
 * Draining table by table let a single busy table consume the whole budget:
 * with more pending `supports` edges than `limit`, the Inbox never showed a
 * `related_to` or `contradicts` proposal at all. Taking one row from each
 * non-empty table per pass keeps every table represented while still
 * honouring each table's `created_at DESC` order.
 */
function interleave<T>(pages: T[][], limit: number): T[] {
  const merged: T[] = [];
  const deepest = pages.reduce((max, page) => Math.max(max, page.length), 0);
  for (let index = 0; index < deepest && merged.length < limit; index++) {
    for (const page of pages) {
      if (merged.length >= limit) break;
      if (index < page.length) merged.push(page[index]);
    }
  }
  return merged;
}

export async function listProposals(
  deps: Pick<ProposalsHandlerDeps, "db" | "approvalService">,
  filters: { notePath?: string; agent?: string; limit?: number },
): Promise<ProposalsListResult> {
  const requestedLimit = filters.limit === undefined ? DEFAULT_LIMIT : filters.limit;
  const limit = assertProposalLimit(requestedLimit, MAX_LIMIT);
  const pages: StoredPendingProposal[][] = [];
  for (const table of WRITEBACK_EDGE_TABLES) {
    const conditions = [
      "approved = false",
      "in.tombstoned_at IS NONE",
      "out.tombstoned_at IS NONE",
    ];
    const bindings: Record<string, unknown> = {};
    if (filters.notePath !== undefined) {
      conditions.push("(in.path = $path OR out.path = $path)");
      bindings.path = filters.notePath;
    }
    if (filters.agent !== undefined) {
      conditions.push("agent = $agent");
      bindings.agent = filters.agent;
    }
    // SurrealDB 3.x requires every ORDER BY field to appear in the projection.
    // `limit` has already passed the RPC boundary's exact integer validation.
    const sql = `SELECT ${PENDING_PROPOSAL_PROJECTION} FROM ${table} WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit};`;
    const result: unknown = await deps.db.query(sql, bindings).collect();
    const rows = proposalStatementRows(result, `${table} proposal list`);
    pages.push(rows.map((row) => parseStoredPendingProposal(row, table)));
  }

  const selected = interleave(pages, limit);
  const chunkIds = new Map<string, RecordId<"chunk">>();
  for (const proposal of selected) {
    for (const chunkId of proposal.evidence) {
      chunkIds.set(chunkId.toString(), chunkId);
    }
  }
  const texts = await fetchEvidenceTexts(deps.db, [...chunkIds.values()]);
  const proposals = selected.map((proposal) => projectProposal(proposal, texts));
  return { ok: true, proposals };
}

function parseId(params: Record<string, unknown>): {
  id: string;
  table: WritebackEdgeTable;
  recordId: RecordId<WritebackEdgeTable>;
} {
  try {
    return parseSurrealRelationRecordId(params.id, WRITEBACK_EDGE_TABLES, "id");
  } catch (error) {
    throw new RpcError("INVALID_PARAMS", error instanceof Error ? error.message : "id is invalid");
  }
}

function parseReason(params: Record<string, unknown>): string | undefined {
  if (params.reason === undefined) return undefined;
  if (typeof params.reason !== "string") {
    throw new RpcError("INVALID_PARAMS", "reason must be a string");
  }
  try {
    return normalizeRejectionReason(params.reason);
  } catch (error) {
    throw new RpcError(
      "INVALID_PARAMS",
      error instanceof Error ? error.message : "reason is invalid",
    );
  }
}

function parseOptionalNotePath(params: Record<string, unknown>): string | undefined {
  const value = params.notePath;
  if (value === undefined) return undefined;
  if (!isCanonicalOrdinaryNotePath(value)) {
    throw new RpcError(
      "INVALID_PARAMS",
      "notePath must be an exact ordinary public vault-relative Markdown note path",
    );
  }
  return value;
}

function parseOptionalAgent(params: Record<string, unknown>): string | undefined {
  const value = params.agent;
  if (value === undefined) return undefined;
  if (!isProposalAgentFilter(value)) {
    throw new RpcError(
      "INVALID_PARAMS",
      "agent must be a canonical proposal producer or client identity",
    );
  }
  return value;
}

function parseOptionalLimit(params: Record<string, unknown>): number | undefined {
  const value = params.limit;
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_LIMIT
  ) {
    throw new RpcError("INVALID_PARAMS", `limit must be an integer from 1 through ${MAX_LIMIT}`);
  }
  return value;
}

interface ParsedLinkProposal {
  sourcePath: string;
  targetPath: string;
  relation: WritebackEdgeTable;
}

interface ResolvedProposalEndpoints {
  from: RecordId<"note">;
  to: RecordId<"note">;
}

interface ResolvedProposalEndpoint {
  path: string;
  id: RecordId<"note">;
}

function parseLinkProposalParams(params: Record<string, unknown>): ParsedLinkProposal {
  if (!hasExactKeys(params, ["sourcePath", "targetPath", "relation"])) {
    throw new RpcError(
      "INVALID_PARAMS",
      "proposals.propose_link requires exactly sourcePath, targetPath, and relation",
    );
  }
  const sourcePath = parseRequestedNotePath(params.sourcePath, "sourcePath");
  const targetPath = parseRequestedNotePath(params.targetPath, "targetPath");
  if (sourcePath === targetPath) {
    throw new RpcError("INVALID_PARAMS", "sourcePath and targetPath must name different notes");
  }
  if (typeof params.relation !== "string" || !isWritebackEdgeTable(params.relation)) {
    throw new RpcError(
      "INVALID_PARAMS",
      `relation must be one of ${WRITEBACK_EDGE_TABLES.join(" | ")}`,
    );
  }
  return { sourcePath, targetPath, relation: params.relation };
}

function parseRequestedNotePath(value: unknown, label: string): string {
  if (!isCanonicalOrdinaryNotePath(value)) {
    throw new RpcError(
      "INVALID_PARAMS",
      `${label} must be an exact ordinary public vault-relative Markdown note path`,
    );
  }
  return value;
}

function parseProposalEndpointRow(
  value: unknown,
  input: ParsedLinkProposal,
): ResolvedProposalEndpoint {
  if (!isRecord(value) || value instanceof RecordId || !hasExactKeys(value, ["id", "path"])) {
    throw new ProposalStorageIntegrityError("endpoint lookup row has an invalid projection");
  }
  const path = value.path;
  if (typeof path !== "string" || (path !== input.sourcePath && path !== input.targetPath)) {
    throw new ProposalStorageIntegrityError("endpoint lookup returned an unexpected path");
  }
  return { path, id: parseNativeRecordId(value.id, "note", "proposal endpoint id") };
}

async function resolveProposalEndpoints(
  db: Surreal,
  input: ParsedLinkProposal,
): Promise<ResolvedProposalEndpoints> {
  const raw: unknown = await db
    .query("SELECT id, path FROM note WHERE path INSIDE $paths AND tombstoned_at = NONE;", {
      paths: [input.sourcePath, input.targetPath],
    })
    .collect();
  const rows = proposalStatementRows(raw, "link proposal endpoint lookup");
  if (rows.length > 2) {
    throw new ProposalStorageIntegrityError("endpoint lookup returned more than two rows");
  }
  const byPath = new Map<string, RecordId<"note">>();
  for (const value of rows) {
    const endpoint = parseProposalEndpointRow(value, input);
    if (byPath.has(endpoint.path)) {
      throw new ProposalStorageIntegrityError("endpoint lookup returned a duplicate note path");
    }
    byPath.set(endpoint.path, endpoint.id);
  }
  const from = byPath.get(input.sourcePath);
  const to = byPath.get(input.targetPath);
  if (from === undefined || to === undefined) {
    const missing = [
      ...(from === undefined ? [input.sourcePath] : []),
      ...(to === undefined ? [input.targetPath] : []),
    ];
    throw new RpcError("INVALID_PARAMS", `proposal note not indexed: ${missing.join(", ")}`);
  }
  if (from.toString() === to.toString()) {
    throw new ProposalStorageIntegrityError("distinct endpoint paths resolved to the same note id");
  }
  return { from, to };
}

async function assertProposalFilesAccessible(
  vault: Pick<VaultAdapter, "exists">,
  input: ParsedLinkProposal,
): Promise<void> {
  for (const path of [input.sourcePath, input.targetPath]) {
    let exists: boolean;
    try {
      exists = await vault.exists(path);
    } catch (error) {
      if (error instanceof VaultPathError) throw new RpcError("INVALID_PARAMS", error.message);
      throw error;
    }
    if (!exists) throw new RpcError("INVALID_PARAMS", `proposal note is unavailable: ${path}`);
  }
}

function assertLinkProposalResult(
  result: Extract<StagePendingProposalResult, { kind: "created" | "existing" }>,
  input: ParsedLinkProposal,
  endpoints: ResolvedProposalEndpoints,
  agent: string,
): void {
  const edge = result.edge;
  if (
    edge.table !== input.relation ||
    edge.fromId.toString() !== endpoints.from.toString() ||
    edge.toId.toString() !== endpoints.to.toString()
  ) {
    throw new ProposalStorageIntegrityError(
      "link proposal transaction returned different relation endpoints",
    );
  }
  const exactOperatorProposal =
    edge.recordId.toString() === result.edgeId.toString() &&
    edge.source === "user" &&
    edge.agent === agent &&
    result.state === "pending";
  if (result.kind === "created" && !exactOperatorProposal) {
    throw new ProposalStorageIntegrityError(
      "created link proposal does not match the authenticated request",
    );
  }
  if (result.kind === "existing" && !exactOperatorProposal) {
    throw new RpcError(
      "INVALID_PARAMS",
      `${input.relation} already exists for ${input.sourcePath} -> ${input.targetPath}`,
    );
  }
}

async function proposeLink(
  deps: ProposalsHandlerDeps,
  input: ParsedLinkProposal,
  agent: string,
): Promise<ProposalsProposeLinkResult> {
  if (!isCanonicalAgentId(agent)) {
    throw new ProposalStorageIntegrityError(
      "authenticated principal has a noncanonical client identity",
    );
  }
  await assertProposalFilesAccessible(deps.vault, input);
  const endpoints = await resolveProposalEndpoints(deps.db, input);
  const result = await stagePendingProposal(deps.db, {
    relation: input.relation,
    from: endpoints.from,
    to: endpoints.to,
    source: "user",
    agent,
    confidence: 1,
  });
  if (result.kind === "rejected") {
    throw new RpcError(
      "INVALID_PARAMS",
      `${input.relation} was already rejected for these relation endpoints`,
    );
  }
  if (result.kind === "unavailable") {
    throw new RpcError(
      "INVALID_PARAMS",
      "proposal endpoint disappeared or was deleted before staging",
    );
  }
  assertLinkProposalResult(result, input, endpoints, agent);
  return {
    ok: true,
    proposalId: result.edgeId.toString(),
    sourcePath: input.sourcePath,
    targetPath: input.targetPath,
    relation: input.relation,
    pending: true,
  };
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((field) => Object.hasOwn(value, field))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function makeProposalsHandlers(deps: ProposalsHandlerDeps) {
  return {
    list: async ({ params }: RpcRequestContext) => {
      const notePath = parseOptionalNotePath(params);
      const agent = parseOptionalAgent(params);
      const limit = parseOptionalLimit(params);
      const filters: { notePath?: string; agent?: string; limit?: number } = {};
      if (notePath !== undefined) filters.notePath = notePath;
      if (agent !== undefined) filters.agent = agent;
      if (limit !== undefined) filters.limit = limit;
      return (await listProposals(deps, filters)) as unknown as Record<string, unknown>;
    },
    proposeLink: async ({ params, principal }: RpcRequestContext) => {
      const input = parseLinkProposalParams(params);
      return (await proposeLink(deps, input, principal.id)) as unknown as Record<string, unknown>;
    },
    approve: async ({ params, principal }: RpcRequestContext) => {
      const { id, table, recordId } = parseId(params);
      if (principal.kind !== "human" || !principal.scopes.includes("admin"))
        throw new RpcError("FORBIDDEN", "relationship approval requires a human administrator");
      const approval = await deps.approvalService.approveEdge({
        id: recordId,
        table,
        approvedBy: principal.id,
        toolApproval: toolApproval({ id, name: "proposals.approve", args: { id } }, principal.id, {
          kind: "human",
          operator: { ...principal, kind: "human" },
        }),
      });
      if (approval === null) {
        return {
          ok: true,
          edgeId: id,
          table,
          found: false,
          historyId: null,
          approvedBy: null,
        } satisfies ProposalsApproveResult as unknown as Record<string, unknown>;
      }
      return {
        ok: true,
        edgeId: id,
        table,
        found: true,
        historyId: approval.historyId,
        approvedBy: approval.approvedBy,
      } satisfies ProposalsApproveResult as unknown as Record<string, unknown>;
    },
    reject: async ({ params, principal }: RpcRequestContext) => {
      const { id, table, recordId } = parseId(params);
      if (principal.kind !== "human" || !principal.scopes.includes("admin"))
        throw new RpcError("FORBIDDEN", "relationship decisions require a human administrator");
      const reason = parseReason(params);
      const rejection = await deps.approvalService.rejectEdge({
        id: recordId,
        table,
        ...(reason !== undefined ? { reason } : {}),
        rejectedBy: principal.id,
      });
      if (rejection === null) {
        return {
          ok: true,
          edgeId: id,
          table,
          found: false,
          historyId: null,
          reason: null,
        } satisfies ProposalsRejectResult as unknown as Record<string, unknown>;
      }
      return {
        ok: true,
        edgeId: id,
        table,
        found: true,
        historyId: rejection.historyId,
        reason: rejection.reason,
      } satisfies ProposalsRejectResult as unknown as Record<string, unknown>;
    },
  };
}
