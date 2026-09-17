import { backgroundResultSchema } from "../../api/background";
import {
  type ChangePreview,
  type ChangeResult,
  changePreviewSchema,
  changeResultSchema,
} from "../../api/changes";
import { chatConfigureResultSchema, chatSettingsResultSchema } from "../../api/chat";
import {
  type GraphNeighbors,
  type GraphPath,
  graphNeighborsSchema,
  graphPathSchema,
} from "../../api/graph";
import { historyDetailSchema, historyListSchema, historyUndoResultSchema } from "../../api/history";
import { searchCoverageSchema } from "../../api/indexing";
import type { OperationInput } from "../../api/operations";
import { pipelineListSchema } from "../../api/pipelineCatalog";
import { jobListSchema, jobResultSchema } from "../../api/pipelines";
import { policyValidationSchema } from "../../api/policyValidation";
import { proposalListSchema, proposalResultSchema } from "../../api/proposals";
import { type OperationResult, noteListSchema } from "../../api/results";
import { daemonStatusSchema } from "../../daemon/wire";
/**
 * Typed RPC surface for the TUI.
 *
 * One function per method the human surface calls, each returning the type
 * `src/daemon/wire.ts` declares. Everything the views and the store touch
 * comes through here, so there is exactly one place where an untyped wire
 * frame becomes a typed value — and no `as unknown as {...}` at a call site.
 *
 * Failure model:
 *   - a handler-level `error` frame becomes `RpcCallError` with the daemon's
 *     code, so callers can branch on stable protocol failures.
 *   - a dead transport becomes `RpcCallError` with code `DAEMON_DISCONNECTED`,
 *     which the app turns into a visible disconnected state rather than a
 *     silent stall.
 */

import { z } from "zod";
import {
  type NoteSelector,
  apiErrorCodeSchema,
  noteReadResultSchema,
  selectorSchema,
} from "../../api/schema";
import { isProposalSource, proposalProvenanceIssue } from "../../core/approvals/proposalStorage";
import { validateAgentId } from "../../core/auth/agentIdentity";
import { NOTE_CONNECTION_TABLES, WRITEBACK_EDGE_TABLES } from "../../core/db/edgeTables";
import { parseSurrealRelationRecordId, parseUuidRecordId } from "../../core/db/recordId";
import { AGENT_EVENT_TYPES } from "../../core/services/agentEventStore";
import { notientConfigSchema } from "../../core/settings/configSchema";
import type {
  AgentEventsResult,
  ApprovalsPendingResult,
  AwakenControlResult,
  AwakenRunResult,
  ChatApproveRequest,
  ChatApproveResult,
  ChatListResult,
  ChatStartResult,
  DaemonConfigGetResult,
  DaemonModelCatalogResult,
  DaemonStatusResult,
  HealthProbeResult,
  NotesReadResult,
  ProposalsApproveResult,
  ProposalsListResult,
  ProposalsRejectResult,
  SearchRunResult,
  VaultActiveNoteResult,
  VaultExtractionResult,
  VaultResolveLinkResult,
  VaultStatsResult,
  VitalsGetResult,
} from "../../daemon/wire";
import { DISCONNECT_PREFIX } from "../client";
import type { ClientHandle, RpcResponseFrame } from "../client";

export const DISCONNECTED_CODE = "DAEMON_DISCONNECTED";

export class RpcCallError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RpcCallError";
  }
}

export function isDisconnect(error: unknown): boolean {
  if (error instanceof RpcCallError) return error.code === DISCONNECTED_CODE;
  return error instanceof Error && error.message.startsWith(DISCONNECT_PREFIX);
}

function errorFromFrame(method: string, frame: RpcResponseFrame): RpcCallError {
  const parsed = errorFrameSchema.safeParse(frame);
  if (!parsed.success) throw wireIntegrityError(method, parsed.error);
  return new RpcCallError(method, parsed.data.code, parsed.data.message);
}

function errorFromThrow(method: string, error: unknown): RpcCallError {
  if (error instanceof RpcCallError) return error;
  const message =
    error instanceof Error ? error.message : `transport threw a non-Error (${typeof error})`;
  const code = message.startsWith(DISCONNECT_PREFIX) ? DISCONNECTED_CODE : "INTERNAL";
  return new RpcCallError(method, code, message);
}

/** Drains a call to its terminal frame, mapping errors onto `RpcCallError`. */
async function callOnce<T>(
  client: ClientHandle,
  method: string,
  params: Record<string, unknown>,
  decode: ResultDecoder<T>,
): Promise<T> {
  try {
    for await (const frame of client.call(method, params)) {
      if (typeof frame.id !== "string" || frame.id.length === 0 || frame.id.trim() !== frame.id) {
        throw new RpcCallError(method, INTEGRITY_CODE, `${method} returned an invalid frame id`);
      }
      if (frame.type === "error") throw errorFromFrame(method, frame);
      if (frame.type === "result") return decode(method, frame);
      if (frame.type !== "ack" && frame.type !== "event") {
        throw new RpcCallError(method, INTEGRITY_CODE, `${method} returned an unknown frame type`);
      }
    }
  } catch (error) {
    throw errorFromThrow(method, error);
  }
  throw new RpcCallError(method, DISCONNECTED_CODE, `${method} closed without a result`);
}

const INTEGRITY_CODE = "WIRE_INTEGRITY";

type ResultDecoder<T> = (method: string, frame: RpcResponseFrame) => T;

const trimmedString = z
  .string()
  .refine(
    (value) => value.length > 0 && value.trim() === value,
    "must be a canonical nonblank string",
  );
const finiteNumber = z.number().refine(Number.isFinite, "must be finite");
const nonnegativeInteger = z
  .number()
  .refine(
    (value) => Number.isSafeInteger(value) && value >= 0,
    "must be a nonnegative safe integer",
  );
const positiveInteger = z
  .number()
  .refine((value) => Number.isSafeInteger(value) && value > 0, "must be a positive safe integer");
const epochMillis = nonnegativeInteger.refine(
  (value) => value <= 8_640_000_000_000_000,
  "must be a representable epoch millisecond timestamp",
);
const score = finiteNumber.min(0).max(1);
const canonicalPath = z
  .string()
  .refine(isCanonicalVaultPath, "must be a canonical vault-relative path");
const clientIdentity = trimmedString.refine((value) => {
  const validated = validateAgentId(value);
  return validated.valid && validated.id === value;
}, "must be a canonical client identity");

const uuidRecordId = (table: string) =>
  z.string().refine((value) => {
    try {
      parseUuidRecordId(value, table);
      return true;
    } catch {
      return false;
    }
  }, `must be a canonical ${table} UUID record id`);

/** SurrealDB's canonical text form for an implicit CREATE/RELATE record key. */
const implicitRecordId = (table: string) =>
  z.string().refine((value) => {
    try {
      parseSurrealRelationRecordId(value, [table]);
      return true;
    } catch {
      return false;
    }
  }, `must be a canonical ${table} implicit record id`);

const edgeTable = z.enum(WRITEBACK_EDGE_TABLES);
const edgeRecordId = z.string().refine((value) => {
  try {
    parseSurrealRelationRecordId(value, WRITEBACK_EDGE_TABLES);
    return true;
  } catch {
    return false;
  }
}, "must be a canonical proposal relation record id");

const RPC_ERROR_CODES = [
  ...apiErrorCodeSchema.options,
  "DAEMON_SHUTTING_DOWN",
  "FORBIDDEN",
  "HISTORY_CONFLICT",
  "HISTORY_EMPTY",
  "HISTORY_INVALID_PAYLOAD",
  "HISTORY_NOT_FOUND",
  "HISTORY_NOT_REVERSIBLE",
  "INTERNAL",
  "INVALID_LLM_OUTPUT",
  "INVALID_PARAMS",
  "METHOD_NOT_FOUND",
  "SESSION_NOT_FOUND",
  "UNAUTHENTICATED",
  "VISION_UNAVAILABLE",
] as const;

const errorFrameSchema = z.strictObject({
  id: trimmedString,
  type: z.literal("error"),
  code: z.enum(RPC_ERROR_CODES),
  message: trimmedString,
  detail: z.record(z.string(), z.unknown()),
});

function resultDecoder<T>(schema: z.ZodType): ResultDecoder<T> {
  return (method, frame) => {
    if (typeof frame.id !== "string" || frame.id.length === 0 || frame.type !== "result") {
      throw new RpcCallError(
        method,
        INTEGRITY_CODE,
        `${method} returned an invalid result envelope`,
      );
    }
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(frame)) {
      if (key !== "id" && key !== "type") payload[key] = value;
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw wireIntegrityError(method, parsed.error);
    return parsed.data as T;
  };
}

function wireIntegrityError(method: string, error: z.ZodError): RpcCallError {
  const issue = error.issues[0];
  const location = issue === undefined || issue.path.length === 0 ? "result" : issue.path.join(".");
  const detail = issue?.message ?? "malformed result";
  return new RpcCallError(
    method,
    INTEGRITY_CODE,
    `${method} wire integrity error at ${location}: ${detail}`,
  );
}

function isCanonicalVaultPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.trim() !== value ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    containsControlCharacter(value)
  ) {
    return false;
  }
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && (point < 32 || point === 127)) return true;
  }
  return false;
}

const resolvedChatSchema = notientConfigSchema.shape.chat.extend({
  modelContextTokens: positiveInteger,
  reasoningSlots: positiveInteger.max(128),
});
const settingsSchema = notientConfigSchema.extend({
  primary: z.strictObject({ baseUrl: z.string(), reasoningModel: z.string() }),
  deep: z.strictObject({
    baseUrl: z.string(),
    reasoningModel: z.string(),
    rerankerModel: z.string(),
  }),
  embedding: z.strictObject({ baseUrl: z.string(), model: z.string() }),
  chat: resolvedChatSchema,
});
const daemonConfigSchema = z.strictObject({ ok: z.literal(true), config: settingsSchema });
const endpointModelSchema = z.strictObject({
  id: trimmedString,
  type: z.enum(["chat", "embedding", "unknown"]),
  state: z.enum(["loaded", "not-loaded", "unknown"]),
  loadedContextLength: positiveInteger.nullable(),
  maxContextLength: positiveInteger.optional(),
  capabilities: z.array(trimmedString).optional(),
});
const daemonModelCatalogSchema = z
  .strictObject({
    ok: z.literal(true),
    source: z.enum(["lmstudio-native", "openai-compatible"]),
    models: z.array(endpointModelSchema),
  })
  .superRefine((catalog, context) => {
    if (new Set(catalog.models.map((model) => model.id)).size !== catalog.models.length) {
      context.addIssue({
        code: "custom",
        path: ["models"],
        message: "contains duplicate model ids",
      });
    }
  });

const endpointHealthSchema = z.strictObject({ label: trimmedString, ok: z.boolean() });
const healthSchema = z
  .strictObject({ ok: z.literal(true), endpoints: z.array(endpointHealthSchema) })
  .superRefine((value, context) => {
    if (
      new Set(value.endpoints.map((endpoint) => endpoint.label)).size !== value.endpoints.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["endpoints"],
        message: "contains duplicate endpoint labels",
      });
    }
  });

const typedEdgeCountSchema = z.strictObject({
  table: edgeTable,
  approved: nonnegativeInteger,
  pending: nonnegativeInteger,
});
const awakenSummarySchema = z
  .strictObject({
    runId: uuidRecordId("awaken_run"),
    status: z.enum(["running", "paused", "cancelled", "completed", "failed"]),
    processed: nonnegativeInteger,
    total: nonnegativeInteger,
    failed: nonnegativeInteger,
    startedAt: epochMillis.nullable(),
    finishedAt: epochMillis.nullable(),
    error: z.string().nullable(),
  })
  .superRefine((run, context) => {
    if (run.processed + run.failed > run.total) {
      context.addIssue({
        code: "custom",
        path: ["processed"],
        message: "processed + failed exceeds total",
      });
    }
    const active = run.status === "running" || run.status === "paused";
    if ((active && run.finishedAt !== null) || (!active && run.finishedAt === null)) {
      context.addIssue({
        code: "custom",
        path: ["finishedAt"],
        message: "does not agree with run status",
      });
    }
  });
const vaultStatsSchema = z
  .strictObject({
    ok: z.literal(true),
    notes: nonnegativeInteger,
    blocks: nonnegativeInteger,
    chunks: nonnegativeInteger,
    concepts: nonnegativeInteger,
    claims: nonnegativeInteger,
    questions: nonnegativeInteger,
    wikilinks: nonnegativeInteger,
    typedEdges: z.array(typedEdgeCountSchema).length(WRITEBACK_EDGE_TABLES.length),
    typedEdgesApproved: nonnegativeInteger,
    typedEdgesPending: nonnegativeInteger,
    pendingApprovals: nonnegativeInteger,
    awaken: awakenSummarySchema.nullable(),
  })
  .superRefine((stats, context) => {
    for (let index = 0; index < WRITEBACK_EDGE_TABLES.length; index += 1) {
      if (stats.typedEdges[index]?.table !== WRITEBACK_EDGE_TABLES[index]) {
        context.addIssue({
          code: "custom",
          path: ["typedEdges", index, "table"],
          message: `must be ${WRITEBACK_EDGE_TABLES[index]}`,
        });
      }
    }
    if (
      stats.typedEdges.reduce((sum, entry) => sum + entry.approved, 0) !== stats.typedEdgesApproved
    ) {
      context.addIssue({
        code: "custom",
        path: ["typedEdgesApproved"],
        message: "does not equal the approved edge sum",
      });
    }
    if (
      stats.typedEdges.reduce((sum, entry) => sum + entry.pending, 0) !== stats.typedEdgesPending
    ) {
      context.addIssue({
        code: "custom",
        path: ["typedEdgesPending"],
        message: "does not equal the pending edge sum",
      });
    }
  });

const pendingApprovalSchema = z.strictObject({
  callId: trimmedString,
  tool: trimmedString,
  preview: z.string(),
  path: canonicalPath.nullable(),
  requestedBy: clientIdentity,
  requestedAt: epochMillis,
});
const approvalsPendingSchema = z
  .strictObject({
    ok: z.literal(true),
    approvals: z.array(pendingApprovalSchema),
  })
  .superRefine((result, context) => {
    if (
      new Set(result.approvals.map((approval) => approval.callId)).size !== result.approvals.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["approvals"],
        message: "contains duplicate call ids",
      });
    }
  });

const proposalEvidenceSchema = z.strictObject({
  chunkId: implicitRecordId("chunk"),
  text: trimmedString,
});
const proposalSource = z.custom<"linker" | "synthesizer" | "contradictionHunter" | "user">(
  isProposalSource,
  "must name a canonical proposal source",
);
const proposalSchema = z
  .strictObject({
    id: edgeRecordId,
    table: edgeTable,
    fromNotePath: canonicalPath,
    toNotePath: canonicalPath,
    confidence: score,
    source: proposalSource,
    agent: trimmedString,
    createdAt: epochMillis,
    evidence: z.array(proposalEvidenceSchema).max(2),
  })
  .superRefine((proposal, context) => {
    try {
      const parsed = parseSurrealRelationRecordId(proposal.id, WRITEBACK_EDGE_TABLES);
      if (parsed.table !== proposal.table) {
        context.addIssue({
          code: "custom",
          path: ["table"],
          message: "does not match the proposal id",
        });
      }
    } catch {
      // The id schema reports the canonical-id failure.
    }
    if (proposal.fromNotePath === proposal.toNotePath) {
      context.addIssue({ code: "custom", path: ["toNotePath"], message: "must name another note" });
    }
    const provenanceIssue = proposalProvenanceIssue({
      source: proposal.source,
      agent: proposal.agent,
      table: proposal.table,
      confidence: proposal.confidence,
      evidenceCount: proposal.evidence.length,
    });
    if (provenanceIssue !== null) {
      context.addIssue({
        code: "custom",
        path: ["source"],
        message: provenanceIssue,
      });
    }
    if (new Set(proposal.evidence.map((item) => item.chunkId)).size !== proposal.evidence.length) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "contains duplicate chunk ids",
      });
    }
  });
const proposalsListSchema = z
  .strictObject({
    ok: z.literal(true),
    proposals: z.array(proposalSchema),
  })
  .superRefine((result, context) => {
    if (new Set(result.proposals.map((proposal) => proposal.id)).size !== result.proposals.length) {
      context.addIssue({ code: "custom", path: ["proposals"], message: "contains duplicate ids" });
    }
  });
const proposalsApproveSchema = z
  .strictObject({
    ok: z.literal(true),
    edgeId: edgeRecordId,
    table: edgeTable,
    found: z.boolean(),
    historyId: uuidRecordId("history").nullable(),
    approvedBy: clientIdentity.nullable(),
  })
  .superRefine((result, context) => {
    try {
      if (
        parseSurrealRelationRecordId(result.edgeId, WRITEBACK_EDGE_TABLES).table !== result.table
      ) {
        context.addIssue({ code: "custom", path: ["table"], message: "does not match edgeId" });
      }
    } catch {
      // edgeId reports its own failure.
    }
    if (
      result.found
        ? result.historyId === null || result.approvedBy === null
        : result.historyId !== null || result.approvedBy !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["historyId"],
        message: "must contain a receipt and approver exactly when found is true",
      });
    }
  });
const proposalsRejectSchema = z
  .strictObject({
    ok: z.literal(true),
    edgeId: edgeRecordId,
    table: edgeTable,
    found: z.boolean(),
    historyId: uuidRecordId("history").nullable(),
    reason: trimmedString.max(1_000).nullable(),
  })
  .superRefine((result, context) => {
    if (
      result.found ? result.historyId === null : result.historyId !== null || result.reason !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["historyId"],
        message: "does not agree with found",
      });
    }
    try {
      if (
        parseSurrealRelationRecordId(result.edgeId, WRITEBACK_EDGE_TABLES).table !== result.table
      ) {
        context.addIssue({ code: "custom", path: ["table"], message: "does not match edgeId" });
      }
    } catch {
      // edgeId reports its own failure.
    }
  });

const toolCallSchema = z.strictObject({
  id: trimmedString,
  name: trimmedString,
  args: z.record(z.string(), z.unknown()),
});
const toolResultSchema = z.strictObject({
  callId: trimmedString,
  status: z.enum(["ok", "error"]),
  data: z.unknown().optional(),
  error: z.string().optional(),
  durationMs: nonnegativeInteger,
});
const approvalRecordSchema = z.strictObject({
  callId: trimmedString,
  approved: z.boolean(),
  decidedAt: epochMillis,
  reason: trimmedString.optional(),
});
export const conversationMessageSchema = z.union([
  z.strictObject({
    id: trimmedString,
    role: z.enum(["user", "assistant", "system"]),
    content: z.string(),
    toolCalls: z.array(toolCallSchema).optional(),
    toolResults: z.array(toolResultSchema).optional(),
    approvals: z.array(approvalRecordSchema).optional(),
    reasoningContent: z.string().optional(),
    createdAt: epochMillis,
  }),
  z.strictObject({
    id: trimmedString,
    role: z.literal("tool"),
    content: z.string(),
    toolCallId: trimmedString,
    createdAt: epochMillis,
  }),
]);
export const conversationSchema = z
  .strictObject({
    id: trimmedString,
    notePath: canonicalPath,
    model: trimmedString,
    pinnedContext: z.array(z.string()),
    approvalMode: z.enum(["safe", "yolo"]),
    topic: z.string(),
    summary: z.string(),
    clientIdentity,
    messageCount: nonnegativeInteger,
    createdAt: epochMillis,
    updatedAt: epochMillis,
    messages: z.array(conversationMessageSchema),
  })
  .superRefine((conversation, context) => {
    if (conversation.messageCount !== conversation.messages.length) {
      context.addIssue({
        code: "custom",
        path: ["messageCount"],
        message: "does not equal messages.length",
      });
    }
    if (conversation.updatedAt < conversation.createdAt) {
      context.addIssue({ code: "custom", path: ["updatedAt"], message: "precedes createdAt" });
    }
  });
const chatStartSchema = z.strictObject({ ok: z.literal(true), conversation: conversationSchema });
const chatListSchema = z.strictObject({
  ok: z.literal(true),
  conversations: z.array(conversationSchema),
});
const chatApproveSchema = z.discriminatedUnion("approved", [
  z.strictObject({ ok: z.literal(true), callId: trimmedString, approved: z.literal(true) }),
  z.strictObject({
    ok: z.literal(true),
    callId: trimmedString,
    approved: z.literal(false),
    reason: trimmedString.max(1_000),
  }),
]);

const maturity = z.enum(["raw", "adolescent", "mature", "synthesis-ready"]);
const connectivityTier = z.enum(["isolated", "sparse", "connected", "hub"]);
const searchHitSchema = z.strictObject({
  notePath: canonicalPath,
  chunkId: implicitRecordId("chunk").nullable(),
  snippet: z.string(),
  score: finiteNumber.min(0),
  matchedText: z.string(),
  vitalsTier: connectivityTier.optional(),
  maturity: maturity.optional(),
  agentTags: z.array(trimmedString).optional(),
});
const synthesisCardSchema = z.strictObject({
  bullets: z.array(z.strictObject({ text: trimmedString, citations: z.array(trimmedString) })),
  rawText: z.string(),
  error: trimmedString.optional(),
});
const searchResultSchema = z
  .strictObject({
    coverage: searchCoverageSchema,
    query: trimmedString,
    mode: z.enum(["quick", "balanced", "deep"]),
    hits: z.array(searchHitSchema),
    durationMs: nonnegativeInteger,
    synthesis: synthesisCardSchema.nullable().optional(),
  })
  .superRefine((result, context) => {
    if (new Set(result.hits.map((hit) => hit.notePath)).size !== result.hits.length) {
      context.addIssue({
        code: "custom",
        path: ["hits"],
        message: "contains duplicate note paths",
      });
    }
  });

const neighborSchema = z.strictObject({
  notePath: canonicalPath,
  table: z.enum(NOTE_CONNECTION_TABLES),
  direction: z.enum(["outgoing", "incoming"]),
  agent: trimmedString,
  confidence: score,
  proposed: z.boolean(),
});
const swarmAgentSchema = z.strictObject({
  agent: z.enum(["linker", "synthesizer", "contradictionHunter", "maturityAdvancer"]),
  state: z.enum(["running", "ok", "error", "idle"]),
  proposals: nonnegativeInteger,
  finishedAt: epochMillis.nullable(),
});
const swarmSchema = z
  .array(swarmAgentSchema)
  .length(4)
  .superRefine((swarm, context) => {
    const expected = ["linker", "synthesizer", "contradictionHunter", "maturityAdvancer"];
    for (let index = 0; index < expected.length; index += 1) {
      if (swarm[index]?.agent !== expected[index]) {
        context.addIssue({
          code: "custom",
          path: [index, "agent"],
          message: `must be ${expected[index]}`,
        });
      }
      const agent = swarm[index];
      if (agent !== undefined) {
        const running = agent.state === "running";
        const idle = agent.state === "idle";
        if ((running || idle) !== (agent.finishedAt === null)) {
          context.addIssue({
            code: "custom",
            path: [index, "finishedAt"],
            message: "does not agree with agent state",
          });
        }
      }
    }
  });
const activeNoteSchema = z
  .strictObject({
    ok: z.literal(true),
    notePath: canonicalPath.nullable(),
    neighbors: z.array(neighborSchema),
    swarm: swarmSchema,
  })
  .superRefine((result, context) => {
    if (result.notePath === null && result.neighbors.length !== 0) {
      context.addIssue({
        code: "custom",
        path: ["neighbors"],
        message: "must be empty without an active note",
      });
    }
    if (
      result.neighbors.some(
        (neighbor) => neighbor.proposed || neighbor.notePath === result.notePath,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["neighbors"],
        message: "contains a pending or self edge",
      });
    }
  });
const resolveLinkSchema = z.discriminatedUnion("resolved", [
  z.strictObject({
    ok: z.literal(true),
    resolved: z.literal(true),
    path: canonicalPath,
    selector: selectorSchema.nullable(),
  }),
  z.strictObject({ ok: z.literal(true), resolved: z.literal(false), path: z.null() }),
]);

const extractionEvidenceSchema = z.strictObject({
  chunkId: implicitRecordId("chunk"),
  text: trimmedString,
});
function extractionItemSchema(table: "concept" | "claim" | "question") {
  return z.strictObject({
    id: implicitRecordId(table),
    text: trimmedString,
    kind: trimmedString.nullable(),
    confidence: score,
    evidence: z.array(extractionEvidenceSchema),
  });
}

const notesReadSchema = noteReadResultSchema;
const agentEventSchema = z.strictObject({
  id: uuidRecordId("agent_event"),
  ts: epochMillis,
  type: z.enum(AGENT_EVENT_TYPES),
  payload: z.unknown().refine((value) => value !== undefined, "must be present"),
});
const agentEventsSchema = z
  .strictObject({
    ok: z.literal(true),
    events: z.array(agentEventSchema),
    cursor: uuidRecordId("agent_event").nullable(),
    longPollExpired: z.boolean(),
  })
  .superRefine((result, context) => {
    const ids = result.events.map((event) => event.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["events"],
        message: "contains duplicate event ids",
      });
    }
    const last = result.events.at(-1)?.id;
    if (last !== undefined && result.cursor !== last) {
      context.addIssue({
        code: "custom",
        path: ["cursor"],
        message: "does not equal the last event id",
      });
    }
  });

const tierFilterSchema = z
  .array(z.union([z.literal(1), z.literal(2), z.literal(3)]))
  .min(1)
  .max(3)
  .refine(
    (tiers) => tiers.every((tier, index) => index === 0 || tiers[index - 1] < tier),
    "must be a unique ascending tier filter",
  );
const awakenRunSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    queued: nonnegativeInteger,
    tier: tierFilterSchema,
    runId: uuidRecordId("awaken_run"),
    status: z.literal("running"),
    background: z.literal(true),
  }),
  z.strictObject({
    ok: z.literal(true),
    queued: nonnegativeInteger,
    tier: tierFilterSchema,
    runId: uuidRecordId("awaken_run"),
    status: z.enum(["paused", "cancelled", "completed"]),
    processed: nonnegativeInteger,
    failed: nonnegativeInteger,
  }),
]);
const awakenControlBase = {
  ok: z.literal(true),
  runId: uuidRecordId("awaken_run"),
  processed: nonnegativeInteger,
  failed: nonnegativeInteger,
  total: nonnegativeInteger,
};
const vitalsSnapshotSchema = z.strictObject({
  notePath: canonicalPath,
  freshness: score,
  health: score,
  connectivityCount: nonnegativeInteger,
  connectivityTier,
  maturity,
  wordCount: nonnegativeInteger,
  computedAt: epochMillis,
});

const decodeDaemonStatus = resultDecoder<DaemonStatusResult>(daemonStatusSchema);
const decodeDaemonConfig = resultDecoder<DaemonConfigGetResult>(daemonConfigSchema);
const decodeDaemonModelCatalog = resultDecoder<DaemonModelCatalogResult>(daemonModelCatalogSchema);
const decodeHealth = resultDecoder<HealthProbeResult>(healthSchema);
const decodeVaultStats = resultDecoder<VaultStatsResult>(vaultStatsSchema);
const decodeApprovalsPending = resultDecoder<ApprovalsPendingResult>(approvalsPendingSchema);
const decodeProposalsList = resultDecoder<ProposalsListResult>(proposalsListSchema);
const decodeProposalsApprove = resultDecoder<ProposalsApproveResult>(proposalsApproveSchema);
const decodeProposalsReject = resultDecoder<ProposalsRejectResult>(proposalsRejectSchema);
const decodeChatStart = resultDecoder<ChatStartResult>(chatStartSchema);
const decodeChatApprove = resultDecoder<ChatApproveResult>(chatApproveSchema);
const decodeResolveLink = resultDecoder<VaultResolveLinkResult>(resolveLinkSchema);
const decodeNotesRead = resultDecoder<NotesReadResult>(notesReadSchema);

const decodeNoteList = resultDecoder<OperationResult<"notes.list">>(noteListSchema);
const decodeAgentEvents = resultDecoder<AgentEventsResult>(agentEventsSchema);
const decodeAwakenRun = resultDecoder<AwakenRunResult>(awakenRunSchema);

const decodeAwakenControl = (
  verb: "pause" | "resume" | "cancel",
): ResultDecoder<AwakenControlResult> => {
  const schema =
    verb === "resume"
      ? z.strictObject({ ...awakenControlBase, status: z.literal("running") })
      : z.strictObject({
          ...awakenControlBase,
          status: z.literal(verb === "pause" ? "paused" : "cancelled"),
          draining: z.boolean(),
        });
  return resultDecoder<AwakenControlResult>(
    schema.superRefine((result, context) => {
      if (result.processed + result.failed > result.total) {
        context.addIssue({
          code: "custom",
          path: ["processed"],
          message: "processed + failed exceeds total",
        });
      }
    }),
  );
};

const decodeSearchRun = (query: string, mode: "balanced"): ResultDecoder<SearchRunResult> =>
  resultDecoder<SearchRunResult>(
    z
      .strictObject({ ok: z.literal(true), result: searchResultSchema })
      .superRefine((result, context) => {
        if (result.result.query !== query || result.result.mode !== mode) {
          context.addIssue({
            code: "custom",
            path: ["result"],
            message: "does not answer the requested query and mode",
          });
        }
      }),
  );

const decodeExtraction = (notePath: string): ResultDecoder<VaultExtractionResult> =>
  resultDecoder<VaultExtractionResult>(
    z
      .strictObject({
        ok: z.literal(true),
        notePath: canonicalPath,
        concepts: z.array(extractionItemSchema("concept")),
        claims: z.array(extractionItemSchema("claim")),
        questions: z.array(extractionItemSchema("question")),
      })
      .superRefine((result, context) => {
        if (result.notePath !== notePath) {
          context.addIssue({
            code: "custom",
            path: ["notePath"],
            message: "does not match the requested note",
          });
        }
      }),
  );

const decodeVitals = (path: string): ResultDecoder<VitalsGetResult> =>
  resultDecoder<VitalsGetResult>(
    z
      .strictObject({ ok: z.literal(true), snapshot: vitalsSnapshotSchema })
      .superRefine((result, context) => {
        if (result.snapshot.notePath !== path) {
          context.addIssue({
            code: "custom",
            path: ["snapshot", "notePath"],
            message: "does not match the requested note",
          });
        }
      }),
  );

const decodeActiveNote = resultDecoder<VaultActiveNoteResult>(activeNoteSchema);

export interface StreamedTurn {
  /** Every event frame of the turn, in order. */
  events: AsyncIterable<RpcResponseFrame>;
}

export interface NotientRpc {
  readonly client: ClientHandle;
  previewChanges(input: OperationInput<"changes.preview">): Promise<ChangePreview>;
  applyChanges(input: OperationInput<"changes.apply">): Promise<ChangeResult>;
  changePreview(id: string): Promise<ChangePreview>;
  reviews(input?: OperationInput<"proposals.list">): Promise<z.infer<typeof proposalListSchema>>;
  review(id: string): Promise<z.infer<typeof proposalResultSchema>>;
  approveReview(input: OperationInput<"proposals.approve">): Promise<ChangeResult>;
  rejectReview(
    input: OperationInput<"proposals.reject">,
  ): Promise<z.infer<typeof proposalResultSchema>>;
  jobs(cursor?: string): Promise<z.infer<typeof jobListSchema>>;
  job(id: string): Promise<z.infer<typeof jobResultSchema>>;
  pipelines(): Promise<z.infer<typeof pipelineListSchema>>;
  validatePipeline(
    input: OperationInput<"pipelines.validate">,
  ): Promise<z.infer<typeof policyValidationSchema>>;
  configurePipeline(
    input: OperationInput<"pipelines.configure">,
  ): Promise<z.infer<typeof backgroundResultSchema>>;
  pauseBackground(
    input: OperationInput<"background.pause">,
  ): Promise<z.infer<typeof backgroundResultSchema>>;
  chatSettings(): Promise<z.infer<typeof chatSettingsResultSchema>>;
  configureChat(
    input: OperationInput<"chat.configure">,
  ): Promise<z.infer<typeof chatConfigureResultSchema>>;
  runPipeline(input: OperationInput<"pipelines.run">): Promise<z.infer<typeof jobResultSchema>>;
  controlJob(input: OperationInput<"jobs.control">): Promise<z.infer<typeof jobResultSchema>>;
  status(): Promise<DaemonStatusResult>;
  config(): Promise<DaemonConfigGetResult>;
  modelCatalog(): Promise<DaemonModelCatalogResult>;
  health(): Promise<HealthProbeResult>;
  vaultStats(): Promise<VaultStatsResult>;
  approvalsPending(): Promise<ApprovalsPendingResult>;
  proposalsList(params?: {
    notePath?: string;
    agent?: string;
    limit?: number;
  }): Promise<ProposalsListResult>;
  proposalsApprove(id: string): Promise<ProposalsApproveResult>;
  proposalsReject(id: string, reason?: string): Promise<ProposalsRejectResult>;
  chatStart(topic: string): Promise<ChatStartResult>;
  chatList(): Promise<ChatListResult>;
  chatAbort(): Promise<{ ok: true; aborted: boolean }>;
  chatLoad(notePath: string): Promise<ChatStartResult>;
  chatSend(conversationId: string, userMessage: string): AsyncIterable<RpcResponseFrame>;
  chatApprove(request: ChatApproveRequest): Promise<ChatApproveResult>;
  search(query: string, limit?: number): Promise<SearchRunResult>;
  activeNote(): Promise<VaultActiveNoteResult>;
  neighbors(notePath: string, includePending?: boolean): Promise<GraphNeighbors>;
  findPath(fromNotePath: string, toNotePath: string): Promise<GraphPath>;
  extraction(notePath: string): Promise<VaultExtractionResult>;
  resolveLink(target: string): Promise<VaultResolveLinkResult>;
  noteBody(path: string, selector?: NoteSelector, revision?: string): Promise<NotesReadResult>;
  historyList(limit?: number, cursor?: string): Promise<OperationResult<"history.list">>;
  historyEntry(id: string): Promise<OperationResult<"history.get">>;
  undoHistory(input: OperationInput<"history.undo">): Promise<OperationResult<"history.undo">>;
  listNotes(query: string, limit?: number): Promise<OperationResult<"notes.list">>;
  vitals(path: string): Promise<VitalsGetResult>;
  agentEvents(since: string | null, limit?: number): Promise<AgentEventsResult>;
  recentLinkProposals(sinceMs: number, limit?: number): Promise<AgentEventsResult>;
  awaken(params?: { background?: true }): Promise<AwakenRunResult>;
  awakenControl(verb: "pause" | "resume" | "cancel"): Promise<AwakenControlResult>;
}

export function createRpc(client: ClientHandle): NotientRpc {
  const call = <T>(
    method: string,
    decode: ResultDecoder<T>,
    params: Record<string, unknown> = {},
  ): Promise<T> => callOnce<T>(client, method, params, decode);

  return {
    client,
    previewChanges: (input) =>
      call("changes.preview", resultDecoder<ChangePreview>(changePreviewSchema), input),
    applyChanges: (input) =>
      call("changes.apply", resultDecoder<ChangeResult>(changeResultSchema), input),
    changePreview: (previewId) =>
      call("changes.get", resultDecoder<ChangePreview>(changePreviewSchema), { previewId }),
    reviews: (input = {}) =>
      call(
        "proposals.list",
        resultDecoder<z.infer<typeof proposalListSchema>>(proposalListSchema),
        input,
      ),
    review: (id) =>
      call(
        "proposals.get",
        resultDecoder<z.infer<typeof proposalResultSchema>>(proposalResultSchema),
        { id },
      ),
    approveReview: (input) =>
      call("proposals.approve", resultDecoder<ChangeResult>(changeResultSchema), input),
    rejectReview: (input) =>
      call(
        "proposals.reject",
        resultDecoder<z.infer<typeof proposalResultSchema>>(proposalResultSchema),
        input,
      ),
    pipelines: () =>
      call("pipelines.list", resultDecoder<z.infer<typeof pipelineListSchema>>(pipelineListSchema)),
    validatePipeline: (input) =>
      call("pipelines.validate", resultDecoder(policyValidationSchema), input),
    configurePipeline: (input) =>
      call("pipelines.configure", resultDecoder(backgroundResultSchema), input),
    pauseBackground: (input) =>
      call("background.pause", resultDecoder(backgroundResultSchema), input),
    chatSettings: () => call("chat.settings", resultDecoder(chatSettingsResultSchema)),
    configureChat: (input) =>
      call("chat.configure", resultDecoder(chatConfigureResultSchema), input),
    runPipeline: (input) =>
      call("pipelines.run", resultDecoder<z.infer<typeof jobResultSchema>>(jobResultSchema), input),
    jobs: (cursor) =>
      call(
        "jobs.list",
        resultDecoder<z.infer<typeof jobListSchema>>(jobListSchema),
        cursor ? { cursor, limit: 20 } : { limit: 20 },
      ),
    job: (id) =>
      call("jobs.get", resultDecoder<z.infer<typeof jobResultSchema>>(jobResultSchema), { id }),
    controlJob: (input) =>
      call("jobs.control", resultDecoder<z.infer<typeof jobResultSchema>>(jobResultSchema), input),
    status: () => call("daemon.status", decodeDaemonStatus),
    config: () => call("daemon.config_get", decodeDaemonConfig),
    modelCatalog: () => call("daemon.model_catalog", decodeDaemonModelCatalog),
    health: () => call("health.probe", decodeHealth),
    vaultStats: () => call("vault.stats", decodeVaultStats),
    approvalsPending: () => call("approvals.pending", decodeApprovalsPending),
    proposalsList: (params = {}) => {
      const wire: Record<string, unknown> = {};
      if (params.notePath !== undefined) wire.notePath = params.notePath;
      if (params.agent !== undefined) wire.agent = params.agent;
      if (params.limit !== undefined) wire.limit = params.limit;
      return call("links.proposals", decodeProposalsList, wire);
    },
    proposalsApprove: (id) => call("links.approve", decodeProposalsApprove, { id }),
    proposalsReject: (id, reason) =>
      call("links.reject", decodeProposalsReject, reason === undefined ? { id } : { id, reason }),
    chatStart: (topic) => call("chat.start", decodeChatStart, { topic }),
    chatList: () => call("chat.list", resultDecoder<ChatListResult>(chatListSchema)),
    chatAbort: () =>
      call(
        "chat.abort",
        resultDecoder(z.strictObject({ ok: z.literal(true), aborted: z.boolean() })),
        {},
      ),
    chatLoad: (notePath) => call("chat.load", decodeChatStart, { notePath }),
    chatSend: (conversationId, userMessage) =>
      client.call("chat.send", { conversationId, userMessage }),
    chatApprove: (request) => call("chat.approve", decodeChatApprove, { ...request }),
    search: (query, limit = 8) =>
      call("search.run", decodeSearchRun(query, "balanced"), {
        query,
        mode: "balanced",
        limit,
      }),
    activeNote: () => call("vault.active_note", decodeActiveNote),
    neighbors: (notePath, includePending = false) =>
      call(
        "graph.neighbors",
        resultDecoder(
          graphNeighborsSchema.refine(
            (result) =>
              result.note.path === notePath &&
              (includePending || result.connections.every((edge) => edge.state !== "proposed")),
            "connection source or proposal scope mismatch",
          ),
        ),
        { path: notePath, includeProposed: includePending },
      ),
    findPath: (fromNotePath, toNotePath) =>
      call(
        "graph.path",
        resultDecoder(
          graphPathSchema.refine(
            (result) => result.from === fromNotePath && result.to === toNotePath,
            "path endpoints mismatch",
          ),
        ),
        { from: fromNotePath, to: toNotePath },
      ),
    extraction: (notePath) => call("vault.extraction", decodeExtraction(notePath), { notePath }),
    resolveLink: (target) => call("vault.resolve_link", decodeResolveLink, { target }),
    noteBody: (path, selector, revision) =>
      call("notes.read", decodeNotesRead, {
        path,
        ...(selector ? { selector } : {}),
        ...(revision ? { revision } : {}),
      }),
    historyList: (limit = 10, cursor?: string) =>
      call("history.list", resultDecoder(historyListSchema), {
        limit,
        ...(cursor ? { cursor } : {}),
      }),
    historyEntry: (id) => call("history.get", resultDecoder(historyDetailSchema), { id }),
    undoHistory: (input) => call("history.undo", resultDecoder(historyUndoResultSchema), input),
    listNotes: (query, limit = 30) => call("notes.list", decodeNoteList, { query, limit }),
    vitals: (path) => call("vitals.get", decodeVitals(path), { path }),
    agentEvents: (since, limit = 100) =>
      call("agent.events", decodeAgentEvents, { since, limit, longPollMs: 0 }),
    recentLinkProposals: (sinceMs, limit = 100) =>
      call("agent.events", decodeAgentEvents, {
        snapshotSinceMs: sinceMs,
        types: ["swarm:link_proposed"],
        limit,
      }),
    awaken: (params = {}) => call("awaken.run", decodeAwakenRun, { ...params }),
    awakenControl: (verb) => call(`awaken.${verb}`, decodeAwakenControl(verb), {}),
  };
}
