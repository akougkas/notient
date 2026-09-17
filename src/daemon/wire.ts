import { z } from "zod";
import { indexingReadinessSchema } from "../api/indexing";
/**
 * Wire contract shared by the daemon and human-facing CLI/TUI surfaces.
 *
 * Handlers keep their own internal types; this module is the shape both
 * sides agree on. Human clients import wire shapes from here, so a field the
 * daemon does not send cannot be invented independently at a call site.
 *
 * Every result carries `ok: true` because the dispatcher turns a thrown
 * handler error into a separate `error` frame rather than an `ok: false`
 * result. `chat.approve` reports a recoverable refusal in-band and is
 * typed accordingly.
 */

import type { ProposalSource } from "../core/approvals/proposalStorage";
import type { AwakenStatus } from "../core/awaken/awakenRun";
import type { Conversation } from "../core/chat/types";
import type { WritebackEdgeTable } from "../core/db/edgeTables";
import type { EndpointModel } from "../core/llm/modelSelection";
import type { SearchMode, SearchResult } from "../core/search/types";
import type { NotientSettings } from "../core/settings/types";
import type { VitalsSnapshot } from "../core/vitals/types";

/* ------------------------------------------------------------------ */
/* daemon.status                                                       */
/* ------------------------------------------------------------------ */

const trimmedString = z
  .string()
  .refine(
    (value) => value.length > 0 && value.trim() === value,
    "must be a canonical nonblank string",
  );
const positiveInteger = z
  .number()
  .refine((value) => Number.isSafeInteger(value) && value > 0, "must be a positive safe integer");
const epochMillis = z
  .number()
  .refine(
    (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000,
    "must be a representable epoch millisecond timestamp",
  );

const modelProbeSchema = z
  .strictObject({
    endpoint: z.string(),
    configuredModel: z.string(),
    loadedModel: trimmedString.nullable(),
    configuredContextTokens: positiveInteger,
    parallelSlots: positiveInteger,
    requestedTotalContextTokens: positiveInteger,
    loadedContextLength: positiveInteger.nullable(),
    status: z.enum(["ok", "available", "not-loaded", "unconfigured", "unavailable", "mismatch"]),
    message: z.string(),
  })
  .superRefine((probe, context) => {
    const requested = probe.configuredContextTokens * probe.parallelSlots;
    if (!Number.isSafeInteger(requested) || requested !== probe.requestedTotalContextTokens) {
      context.addIssue({
        code: "custom",
        path: ["requestedTotalContextTokens"],
        message: "does not equal configuredContextTokens × parallelSlots",
      });
    }
  });

export const daemonStatusSchema = z.strictObject({
  indexing: indexingReadinessSchema,
  ok: z.literal(true),
  httpEndpoint: z.url().nullable(),
  vaultId: z.string().regex(/^[a-f0-9]{16}$/),
  vault: trimmedString,
  pid: positiveInteger,
  socketPath: trimmedString,
  startedAt: epochMillis,
  version: trimmedString,
  sealed: z.boolean(),
  visionReady: z.boolean(),
  probe: modelProbeSchema,
});

export type DaemonModelProbeWire = z.infer<typeof modelProbeSchema>;
export type DaemonStatusResult = z.infer<typeof daemonStatusSchema>;

export interface DaemonConfigGetResult {
  ok: true;
  config: NotientSettings;
}

export interface DaemonModelCatalogResult {
  ok: true;
  source: "lmstudio-native" | "openai-compatible";
  models: EndpointModel[];
}

/* ------------------------------------------------------------------ */
/* awaken.status                                                      */
/* ------------------------------------------------------------------ */

export interface AwakenStatusRequest {
  /** Lock a follow-up poll to the run selected by the first request. */
  runId?: string;
}

export interface AwakenStatusWire {
  runId: string;
  status: AwakenStatus;
  processed: number;
  failed: number;
  total: number;
  startedAt: number;
}

export interface AwakenStatusResult {
  ok: true;
  run: AwakenStatusWire | null;
}

/* ------------------------------------------------------------------ */
/* vault.stats                                                         */
/* ------------------------------------------------------------------ */

/** Approved/pending split for one typed semantic edge table. */
export interface TypedEdgeCount {
  table: WritebackEdgeTable;
  approved: number;
  pending: number;
}

export interface AwakenRunSummary {
  runId: string;
  status: "running" | "paused" | "cancelled" | "completed" | "failed";
  processed: number;
  total: number;
  failed: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}

export interface VaultStatsResult {
  ok: true;
  /** Non-tombstoned note rows. */
  notes: number;
  blocks: number;
  chunks: number;
  concepts: number;
  claims: number;
  questions: number;
  /** Deterministic `wikilink` edges. */
  wikilinks: number;
  /** Per-table typed edge counts, always all six tables in a fixed order. */
  typedEdges: TypedEdgeCount[];
  /** Sum over `typedEdges[].approved`. */
  typedEdgesApproved: number;
  /** Sum over `typedEdges[].pending`; the Inbox badge count for proposals. */
  typedEdgesPending: number;
  /** Tool calls parked at the approval gate right now. */
  pendingApprovals: number;
  /** The active or most recent awaken run; null on a never-awakened vault. */
  awaken: AwakenRunSummary | null;
}

/* ------------------------------------------------------------------ */
/* approvals.pending                                                   */
/* ------------------------------------------------------------------ */

export interface PendingApprovalWire {
  callId: string;
  tool: string;
  preview: string;
  /** Vault-relative target path when the tool call names one. */
  path: string | null;
  /** Principal id that requested the call. */
  requestedBy: string;
  requestedAt: number;
}

export interface ApprovalsPendingResult {
  ok: true;
  approvals: PendingApprovalWire[];
}

export type ChatApproveRequest =
  | { callId: string; approved: true }
  | { callId: string; approved: false; reason?: string };

export type ChatApproveResult =
  | { ok: true; callId: string; approved: true }
  | { ok: true; callId: string; approved: false; reason: string };

/* ------------------------------------------------------------------ */
/* proposals.*                                                         */
/* ------------------------------------------------------------------ */

export interface ProposalEvidenceWire {
  chunkId: string;
  text: string;
}

export interface ProposalWire {
  id: string;
  table: WritebackEdgeTable;
  fromNotePath: string;
  toNotePath: string;
  confidence: number;
  source: ProposalSource;
  agent: string;
  createdAt: number;
  /** Capped at two snippets per proposal by the handler. */
  evidence: ProposalEvidenceWire[];
}

export interface ProposalsListRequest {
  notePath?: string;
  agent?: string;
  limit?: number;
}

export interface ProposalsListResult {
  ok: true;
  proposals: ProposalWire[];
}

export interface ProposalsProposeLinkRequest {
  sourcePath: string;
  targetPath: string;
  relation: WritebackEdgeTable;
}

export interface ProposalsProposeLinkResult {
  ok: true;
  proposalId: string;
  sourcePath: string;
  targetPath: string;
  relation: WritebackEdgeTable;
  pending: true;
}

export interface ProposalsProposeNoteRequest {
  title: string;
  body: string;
  kind?: string;
}

/**
 * A proposal note has its own authenticated, server-authored route. It uses
 * the same non-blocking approval semantics as an ordinary note mutation, but
 * callers never supply its path, provenance frontmatter, or timestamp.
 */
export type ProposalsProposeNoteResult =
  | {
      ok: true;
      applied: true;
      path: string;
      sha: string;
      historyId: string;
    }
  | {
      ok: true;
      applied: false;
      pending: true;
      callId: string;
      preview: string;
      path: string;
    }
  | {
      ok: true;
      applied: false;
      pending: false;
      reason: string;
      path: string;
    };

export interface ProposalsApproveRequest {
  id: string;
}

export interface ProposalsRejectRequest {
  id: string;
  reason?: string;
}

export type ProposalsApproveResult =
  | {
      ok: true;
      /** Named `edgeId` because `id` belongs to the RPC envelope. */
      edgeId: string;
      table: WritebackEdgeTable;
      found: false;
      historyId: null;
      approvedBy: null;
    }
  | {
      ok: true;
      edgeId: string;
      table: WritebackEdgeTable;
      found: true;
      /** Deterministic receipt accepted by `notient undo <historyId>`. */
      historyId: string;
      /** Authenticated principal that authorized the durable write. */
      approvedBy: string;
    };

export type ProposalsRejectResult =
  | {
      ok: true;
      edgeId: string;
      table: WritebackEdgeTable;
      found: false;
      historyId: null;
      reason: null;
    }
  | {
      ok: true;
      edgeId: string;
      table: WritebackEdgeTable;
      found: true;
      /** Durable `proposal.reject` audit row. */
      historyId: string;
      /** Canonical persisted reason; null only when the caller omitted it. */
      reason: string | null;
    };

/* ------------------------------------------------------------------ */
/* links.sync                                                         */
/* ------------------------------------------------------------------ */

export interface LinksSyncResult {
  ok: true;
  replayed: number;
  abandoned: number;
  failed: number;
}

/* ------------------------------------------------------------------ */
/* chat.*                                                              */
/* ------------------------------------------------------------------ */

export interface ChatStartRequest {
  topic?: string;
  pinnedContext?: string[];
}

export interface ChatStartResult {
  ok: true;
  conversation: Conversation;
}

export interface ChatSendRequest {
  conversationId: string;
  userMessage: string;
}

export interface ChatSendResult {
  ok: true;
  message?: unknown;
}

export interface ChatListResult {
  ok: true;
  conversations: Conversation[];
}

/**
 * Streamed frames of `chat.send`, in the spec's wire names. The TUI switches
 * on `event`; anything not listed here is ignored rather than rendered.
 */
export type ChatStreamEvent =
  | { event: "loop:assistant_delta"; contentDelta: string }
  | { event: "loop:tool_call_started"; callId: string; tool: string }
  | { event: "loop:tool_call_result"; callId: string; tool?: string }
  | { event: "loop:tool_call_error"; callId: string; error: string }
  | { event: "loop:approval_pending"; callId: string; tool: string; preview?: string }
  | { event: "loop:approval_resolved"; callId: string; approved: true }
  | { event: "loop:approval_resolved"; callId: string; approved: false; reason: string }
  | {
      event: "loop:context_summarized";
      originalTokens: number;
      summarizedTokens: number;
      model?: string;
    }
  | {
      event: "loop:context_overflow_warning";
      configuredTokens: number;
      estimatedTokens: number;
      model?: string;
    }
  | { event: "loop:tool_mode_probed"; model: string; mode: string; attempts: number };

/* ------------------------------------------------------------------ */
/* search.run                                                          */
/* ------------------------------------------------------------------ */

export interface SearchRunRequest {
  query: string;
  mode?: SearchMode;
  limit?: number;
}

export interface SearchRunResult {
  ok: true;
  result: SearchResult;
}

/* ------------------------------------------------------------------ */
/* vault.* / graph.*                                                   */
/* ------------------------------------------------------------------ */

export interface VaultResolveLinkRequest {
  /** A complete `[[wikilink]]` citation or a bare Markdown note path. */
  target: string;
}

/** Explicitly discriminated so an unresolved citation is not a transport error. */
export type VaultResolveLinkResult =
  | {
      ok: true;
      resolved: true;
      path: string;
      selector: import("../api/schema").NoteSelector | null;
    }
  | { ok: true; resolved: false; path: null };

export interface NeighborWire {
  notePath: string;
  /** Authored link/embed/property relation or one of the reviewed semantic tables. */
  table: string;
  direction: "outgoing" | "incoming";
  agent: string;
  confidence: number;
  /** True for a pending proposal, false for a live edge. */
  proposed: boolean;
}

export interface VaultNeighborsRequest {
  notePath: string;
  /** Include `approved = false` linker rows alongside the applied edges. */
  includePending?: boolean;
}

export interface VaultNeighborsResult {
  ok: true;
  notePath: string;
  neighbors: NeighborWire[];
}

export interface SwarmAgentWire {
  agent: string;
  state: "running" | "ok" | "error" | "idle";
  proposals: number;
  finishedAt: number | null;
}

export interface VaultActiveNoteResult {
  ok: true;
  notePath: string | null;
  neighbors: NeighborWire[];
  swarm: SwarmAgentWire[];
}

export interface ExtractionItemWire {
  id: string;
  /** Concept label, or claim/question text. */
  text: string;
  kind: string | null;
  confidence: number;
  evidence: ProposalEvidenceWire[];
}

export interface VaultExtractionRequest {
  notePath: string;
}

export interface VaultExtractionResult {
  ok: true;
  notePath: string;
  concepts: ExtractionItemWire[];
  claims: ExtractionItemWire[];
  questions: ExtractionItemWire[];
}

export interface GraphFindPathRequest {
  fromNotePath: string;
  toNotePath: string;
}

export interface GraphFindPathResult {
  ok: true;
  path: string[];
  hops: number;
}

/* ------------------------------------------------------------------ */
/* notes.*                                                             */
/* ------------------------------------------------------------------ */

export type {
  NoteReadRequest as NotesReadRequest,
  NoteReadResult as NotesReadResult,
} from "../api/schema";

export interface VaultListRequest {
  folder?: string;
  filter?: string;
  limit?: number;
}

export interface VaultListResult {
  ok: true;
  paths: string[];
}

/* ------------------------------------------------------------------ */
/* agent.events                                                        */
/* ------------------------------------------------------------------ */

export interface AgentEventWire {
  id: string;
  ts: number;
  type: string;
  payload: unknown;
}

export type AgentEventsRequestWire =
  | {
      since: string | null;
      limit?: number;
      longPollMs?: number;
    }
  | {
      snapshotSinceMs: number;
      types: string[];
      limit?: number;
    };

export interface AgentEventsResult {
  ok: true;
  events: AgentEventWire[];
  cursor: string | null;
  longPollExpired: boolean;
}

/* ------------------------------------------------------------------ */
/* awaken.*                                                            */
/* ------------------------------------------------------------------ */

export interface AwakenRunRequest {
  /** Millisecond Unix timestamp. Omission scans the complete vault. */
  since?: number;
  /** Canonical sorted, unique subset of 1, 2, and 3. */
  tier?: number[];
  /** Presence selects asynchronous execution; false is not a wire alias. */
  background?: true;
}

interface AwakenRunResultBase extends Record<string, unknown> {
  ok: true;
  runId: string;
  queued: number;
  tier: number[];
}

export interface AwakenBackgroundRunResult extends AwakenRunResultBase {
  status: "running";
  background: true;
}

export interface AwakenForegroundRunResult extends AwakenRunResultBase {
  status: "paused" | "cancelled" | "completed";
  processed: number;
  failed: number;
}

export type AwakenRunResult = AwakenBackgroundRunResult | AwakenForegroundRunResult;

interface AwakenControlCounters extends Record<string, unknown> {
  ok: true;
  runId: string;
  processed: number;
  failed: number;
  total: number;
}

export interface AwakenPauseResult extends AwakenControlCounters {
  status: "paused";
  draining: boolean;
}

export interface AwakenCancelResult extends AwakenControlCounters {
  status: "cancelled";
  draining: boolean;
}

export interface AwakenResumeResult extends AwakenControlCounters {
  status: "running";
}

export type AwakenControlResult = AwakenPauseResult | AwakenCancelResult | AwakenResumeResult;

/* ------------------------------------------------------------------ */
/* health.probe / vitals.get                                           */
/* ------------------------------------------------------------------ */

export interface EndpointHealthWire {
  label: string;
  ok: boolean;
}

export interface HealthProbeResult {
  ok: true;
  endpoints: EndpointHealthWire[];
}

export interface VitalsGetRequest {
  path: string;
}

export interface VitalsGetResult {
  ok: true;
  snapshot: VitalsSnapshot;
}
