import type { RecordId, Surreal } from "surrealdb";
import type { ApprovalService } from "../../approvals/approvalService";
import {
  PENDING_PROPOSAL_PROJECTION,
  type ProposalSource,
  type StoredPendingProposal,
  assertProposalLimit,
  isProposalAgentFilter,
  parsePendingProposalLookup,
  parseStoredPendingProposal,
  proposalStatementRows,
} from "../../approvals/proposalStorage";
import { normalizeRejectionReason } from "../../approvals/rejectionReason";
import { WRITEBACK_EDGE_TABLES, type WritebackEdgeTable } from "../../db/edgeTables";
import { parseSurrealRelationRecordId } from "../../db/recordId";
import { isCanonicalOrdinaryNotePath } from "../../vault/publicPath";
import type { ApprovalGate } from "../approvalGate";
import type { ApprovalMode } from "../types";
import {
  type ToolDefinition,
  type ToolInvokeContext,
  type ToolJsonSchema,
  isObject,
  requireString,
} from "./registry";

export interface ProposalEdge {
  kind: "edge";
  id: string;
  type: WritebackEdgeTable;
  sourceId: string;
  targetId: string;
  sourceNotePath: string;
  targetNotePath: string;
  confidence: number;
  source: ProposalSource;
  agent: string;
  evidence: string[];
  rationale: string | null;
  createdAt: number;
}

export interface ProposalsListArgs {
  notePath?: string;
  agent?: string;
  limit?: number;
}

export interface ProposalsListResult {
  proposals: ProposalEdge[];
}

const MAX_LIST_LIMIT = 200;

function optionalNotePath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isCanonicalOrdinaryNotePath(value)) {
    throw new Error("notePath must be an exact ordinary public vault-relative Markdown note path");
  }
  return value;
}

function optionalAgent(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isProposalAgentFilter(value)) {
    throw new Error("agent must be a canonical proposal producer or client identity");
  }
  return value;
}

function optionalListLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`proposal limit must be an integer from 1 through ${MAX_LIST_LIMIT}`);
  }
  return assertProposalLimit(value, MAX_LIST_LIMIT);
}

/**
 * Read-only proposal listing. Proposals are rows in the six writeback-capable
 * edge tables with `approved = false`. Filters by the focal note (either side of
 * an edge's resolved `note.path`) and by its attributed proposal agent.
 *
 * Results are newest-first by the edge's canonical `created_at` timestamp.
 */
export function makeListProposalsTool(
  db: Surreal,
): ToolDefinition<ProposalsListArgs, ProposalsListResult> {
  return {
    name: "proposals.list_pending",
    description:
      "List pending note-graph proposals awaiting approval. Optionally filter by notePath or attributed agent.",
    schema: {
      type: "object",
      properties: {
        notePath: { type: "string", description: "Filter to proposals touching this note." },
        agent: { type: "string", description: "Filter to a single agent name." },
        limit: { type: "number", description: "Maximum proposals to return in total." },
      },
      required: [],
    },
    validate: (raw) => {
      if (raw === undefined) return {};
      if (!isObject(raw)) throw new Error("expected object");
      const notePath = optionalNotePath(raw.notePath);
      const agent = optionalAgent(raw.agent);
      const requestedLimit = optionalListLimit(raw.limit);
      const limit =
        requestedLimit === undefined
          ? undefined
          : assertProposalLimit(requestedLimit, MAX_LIST_LIMIT);
      return { notePath, agent, limit };
    },
    invoke: async (args) => {
      const edges = await collectEdges(db, args);
      edges.sort((a, b) => b.createdAt - a.createdAt);
      const limited = args.limit === undefined ? edges : edges.slice(0, args.limit);
      return { proposals: limited };
    },
    writeGated: false,
  };
}

export interface ProposalsGetArgs {
  id: string;
}

export interface ProposalsGetResult {
  proposal: ProposalEdge | null;
}

/**
 * Read-only single-proposal lookup. Returns null when the row is missing or
 * has already been approved. The id may be a SurrealDB record id string
 * (e.g. `supports:8z7li22oizca97c0mwo4`).
 */
export function makeGetProposalTool(
  db: Surreal,
): ToolDefinition<ProposalsGetArgs, ProposalsGetResult> {
  return {
    name: "proposals.get",
    description: "Fetch a single pending proposal (edge) by id.",
    schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "SurrealDB edge record id." },
      },
      required: ["id"],
    },
    validate: (raw) => {
      if (!isObject(raw)) throw new Error("expected object");
      const id = requireString(raw.id, "id");
      parseSurrealRelationRecordId(id, WRITEBACK_EDGE_TABLES, "id");
      return { id };
    },
    invoke: async (args) => {
      const parsed = parseSurrealRelationRecordId(args.id, WRITEBACK_EDGE_TABLES, "id");
      const row = await selectEdgeById(db, parsed.table, parsed.recordId);
      return { proposal: row === null ? null : toProposalEdge(row) };
    },
    writeGated: false,
  };
}

async function collectEdges(db: Surreal, args: ProposalsListArgs): Promise<ProposalEdge[]> {
  const proposals: ProposalEdge[] = [];
  for (const table of WRITEBACK_EDGE_TABLES) {
    const conditions: string[] = [
      "approved = false",
      "in.tombstoned_at IS NONE",
      "out.tombstoned_at IS NONE",
    ];
    const bindings: Record<string, unknown> = {};
    if (args.agent !== undefined) {
      conditions.push("agent = $agent");
      bindings.agent = args.agent;
    }
    if (args.notePath !== undefined) {
      conditions.push("(in.path = $path OR out.path = $path)");
      bindings.path = args.notePath;
    }
    // SurrealDB 3.x requires every ORDER BY field to appear in the projection.
    const sql = `SELECT ${PENDING_PROPOSAL_PROJECTION} FROM ${table} WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC;`;
    const result: unknown = await db.query(sql, bindings).collect();
    const rows = proposalStatementRows(result, `${table} proposal list`);
    for (const row of rows) {
      proposals.push(toProposalEdge(parseStoredPendingProposal(row, table)));
    }
  }
  return proposals;
}

async function selectEdgeById(
  db: Surreal,
  table: WritebackEdgeTable,
  recordId: RecordId<WritebackEdgeTable>,
): Promise<StoredPendingProposal | null> {
  const sql = `SELECT ${PENDING_PROPOSAL_PROJECTION} FROM ${table} WHERE id = $id AND approved = false AND in.tombstoned_at IS NONE AND out.tombstoned_at IS NONE LIMIT 1;`;
  const result: unknown = await db.query(sql, { id: recordId }).collect();
  return parsePendingProposalLookup(result, table, recordId.toString());
}

function toProposalEdge(proposal: StoredPendingProposal): ProposalEdge {
  return {
    kind: "edge",
    id: proposal.id,
    type: proposal.table,
    sourceId: proposal.fromId.toString(),
    targetId: proposal.toId.toString(),
    sourceNotePath: proposal.fromPath,
    targetNotePath: proposal.toPath,
    confidence: proposal.confidence,
    source: proposal.source,
    agent: proposal.agent,
    evidence: proposal.evidence.map((chunkId) => chunkId.toString()),
    rationale: null,
    createdAt: proposal.createdAt,
  };
}

export interface ProposalsApproveArgs {
  id: string;
}

export type ProposalsApproveResult =
  | {
      applied: true;
      id: string;
      table: WritebackEdgeTable;
      historyId: string;
      approvedBy: string;
    }
  | { applied: false; reason: string };

export interface ProposalsApproveContext {
  approvalService: ApprovalService;
  approvalGate: ApprovalGate;
  approvalMode: () => ApprovalMode;
  generateCallId: () => string;
}

const APPROVE_SCHEMA: ToolJsonSchema = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description:
        "Canonical SurrealDB 3.0.5 relation id (e.g. `supports:8z7li22oizca97c0mwo4`). Must address one of the six writeback-capable edge tables.",
    },
  },
  required: ["id"],
};

/**
 * Write-gated chat tool that promotes one pending proposal through the
 * three-state contract by delegating to `ApprovalService.approveEdge`. The
 * tool routes through `ApprovalGate.request` first so safe-mode operators
 * get prompted before the writeback runs. A retry of a completed approval
 * returns its deterministic durable receipt. An unknown or still-unavailable
 * id returns `applied: false` rather than throwing.
 */
export function makeApproveProposalTool(
  context: ProposalsApproveContext,
): ToolDefinition<ProposalsApproveArgs, ProposalsApproveResult> {
  return {
    name: "proposals.approve",
    description:
      "Approve a pending note-graph proposal by edge id. Writes the corresponding wikilink or frontmatter relation to the source note.",
    schema: APPROVE_SCHEMA,
    writeGated: true,
    validate: (raw) => {
      if (!isObject(raw)) throw new Error("expected object");
      const id = requireString(raw.id, "id");
      parseSurrealRelationRecordId(id, WRITEBACK_EDGE_TABLES, "id");
      return { id };
    },
    invoke: async (args, signal, invokeContext) => {
      const parsed = parseSurrealRelationRecordId(args.id, WRITEBACK_EDGE_TABLES, "id");
      const decision = await context.approvalGate.request(
        { id: context.generateCallId(), name: "proposals.approve", args: { ...args } },
        context.approvalMode(),
        `Approve proposal ${args.id}`,
        signal,
        invokeContext,
      );
      if (!decision.approved) {
        return { applied: false, reason: decision.reason };
      }
      const guard = context.approvalGate.writeGuard(decision, signal);
      const approval = await context.approvalService.approveEdge(
        {
          id: parsed.recordId,
          table: parsed.table,
          approvedBy: invokeContext.clientIdentity,
          toolApproval: guard.toolApproval,
        },
        { authorize: guard.authorize },
      );
      if (approval === null) {
        return { applied: false, reason: "proposal not found or already applied" };
      }
      return {
        applied: true,
        id: args.id,
        table: parsed.table,
        historyId: approval.historyId,
        approvedBy: approval.approvedBy,
      };
    },
  };
}

export interface ProposalsRejectArgs {
  id: string;
  reason?: string;
}

export type ProposalsRejectResult =
  | {
      applied: true;
      id: string;
      table: WritebackEdgeTable;
      reason: string | null;
      historyId: string;
    }
  | { applied: false; reason: string };

export interface ProposalsRejectContext {
  approvalService: ApprovalService;
  approvalGate: ApprovalGate;
  approvalMode: () => ApprovalMode;
  generateCallId: () => string;
}

const REJECT_SCHEMA: ToolJsonSchema = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description:
        "Canonical SurrealDB 3.0.5 relation id (e.g. `supports:8z7li22oizca97c0mwo4`). Must address one of the six writeback-capable edge tables.",
    },
    reason: {
      type: "string",
      description:
        "Optional human-readable reason for the rejection. Persisted in the proposal.reject audit record.",
    },
  },
  required: ["id"],
};

/**
 * Write-gated chat tool that deletes one pending proposal by delegating to
 * `ApprovalService.rejectEdge`. Routes through `ApprovalGate.request` so
 * safe-mode operators get prompted before the row disappears. The optional
 * `reason` is committed atomically with the deletion in a non-reversible
 * `proposal.reject` history row and returned with that row's id.
 */
export function makeRejectProposalTool(
  context: ProposalsRejectContext,
): ToolDefinition<ProposalsRejectArgs, ProposalsRejectResult> {
  return {
    name: "proposals.reject",
    description:
      "Reject a pending note-graph proposal by edge id. Records a terminal audit decision for that exact proposal identity.",
    schema: REJECT_SCHEMA,
    writeGated: true,
    validate: (raw) => {
      if (!isObject(raw)) throw new Error("expected object");
      const id = requireString(raw.id, "id");
      parseSurrealRelationRecordId(id, WRITEBACK_EDGE_TABLES, "id");
      const reasonInput = raw.reason;
      if (reasonInput !== undefined && typeof reasonInput !== "string") {
        throw new Error("reason must be a string");
      }
      const reason = normalizeRejectionReason(reasonInput);
      return reason === undefined ? { id } : { id, reason };
    },
    invoke: (args, signal, invokeContext) =>
      invokeRejectProposal(context, args, signal, invokeContext),
  };
}

async function invokeRejectProposal(
  context: ProposalsRejectContext,
  args: ProposalsRejectArgs,
  signal: AbortSignal,
  invokeContext: ToolInvokeContext,
): Promise<ProposalsRejectResult> {
  const parsed = parseSurrealRelationRecordId(args.id, WRITEBACK_EDGE_TABLES, "id");
  const decision = await context.approvalGate.request(
    { id: context.generateCallId(), name: "proposals.reject", args: { ...args } },
    context.approvalMode(),
    rejectionPreview(args),
    signal,
    invokeContext,
  );
  if (!decision.approved) return { applied: false, reason: decision.reason };
  await context.approvalGate.writeGuard(decision, signal).authorize();
  const rejection = await context.approvalService.rejectEdge({
    id: parsed.recordId,
    table: parsed.table,
    ...(args.reason !== undefined ? { reason: args.reason } : {}),
    rejectedBy: invokeContext.clientIdentity,
  });
  if (rejection === null) {
    return { applied: false, reason: "proposal not found or already applied" };
  }
  return {
    applied: true,
    id: args.id,
    table: parsed.table,
    reason: rejection.reason,
    historyId: rejection.historyId,
  };
}

function rejectionPreview(args: ProposalsRejectArgs): string {
  return args.reason === undefined
    ? `Reject proposal ${args.id}`
    : `Reject proposal ${args.id} (${args.reason})`;
}
