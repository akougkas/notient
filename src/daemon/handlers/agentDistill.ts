/**
 * `agent.distill` RPC handler.
 *
 * Ingests a transcript from one canonical public Markdown file in the vault,
 * runs the TranscriptDistiller against it, and lands candidate proposals as
 * markdown files under
 * `<vault>/Notient/proposals/distilled-*.md`.
 *
 * Why a new agent instead of reusing Synthesizer:
 *
 *   - Synthesizer.run reads `notes` / `embeddings` / `chunks` from the DB and
 *     clusters them via DBSCAN. It cannot ingest external transcript chunks
 *     and it returns `{ proposals: number }`, not a typed candidate list.
 *   - Synthesizer only emits `type = "synthesis"` rows, but the spec calls
 *     for four kinds (claim / decision / question / note).
 *   - Extractor (`core/indexer/extractor.ts`) covers two of the four kinds
 *     and is wired against the indexer pipeline.
 *
 * The TranscriptDistiller in `core/distill/transcriptDistiller.ts` runs a
 * single LLM call against a parsed transcript and returns the four-kind
 * candidate list directly. A live result is then treated as one write batch:
 * every exact path and body is prepared before one `agent.distill` approval,
 * and an approval creates the notes through VaultAdapter with one guarded
 * `notes.create` history row per file. Dry runs stop before the gate.
 *
 * Path authorization accepts one canonical vault-relative spelling and pins
 * the reachable set to ordinary Markdown and exact native conversation paths.
 * Absolute paths are not a second spelling for the same authority. JSON and
 * JSONL transcript bodies remain supported inside an ordinary
 * `.md` file; their old filename extensions are not a second file-read
 * authority. The per-vault state dir
 * (`~/.notient/<vaultId>/`) is deliberately not reachable: it holds
 * `admin.token`, `secret.key` and the SurrealDB data dir, and `agent.distill`
 * is a `write` method any agent principal may call, so a reachable state dir
 * would let an agent launder the admin token into a proposal note it can then
 * read. Chat transcripts live under `<vault>/Notient/conversations/`, so the
 * vault root is the only root the runtime needs. The actual read is one
 * descriptor-anchored vault operation: each ancestor refuses symlinks, the
 * final descriptor must be a regular file, and a max+1 sentinel enforces the
 * hard byte ceiling even if the file grows. Hidden paths, Notient-owned
 * artifacts other than exact conversations, special files, links, traversal,
 * and oversized inputs are rejected before the distiller.
 */

import { randomUUID } from "node:crypto";
import {
  type VaultAdapter,
  VaultPathError,
  VaultReadLimitError,
} from "../../adapters/vaultAdapter";
import type { ApprovalGate } from "../../core/chat/approvalGate";
import { parseConversation } from "../../core/chat/conversationParser";
import type { NotesHistoryRecord } from "../../core/chat/tools/notes";
import type { ApprovalMode } from "../../core/chat/types";
import type { Candidate, TranscriptDistiller } from "../../core/distill/transcriptDistiller";
import {
  type TranscriptFormat,
  type TranscriptMessage,
  buildTranscriptMessages,
  detectFormat,
  parseTranscript,
} from "../../core/distill/transcriptParser";
import type { DurableNoteWriteResult } from "../../core/history/durableNoteWriter";
import {
  isCanonicalConversationPath,
  isCanonicalOrdinaryNotePath,
} from "../../core/vault/publicPath";
import { type MethodHandler, type Principal, RpcError, encodeEvent } from "../rpc";
import {
  type NonBlockingApprovalTracker,
  invokeWithNonBlockingApproval,
} from "./nonBlockingApproval";

export interface AgentDistillHandlerDeps {
  distiller: TranscriptDistiller;
  vault: Pick<VaultAdapter, "exists" | "readBounded">;
  approvalGate: ApprovalGate;
  approvalTracker?: NonBlockingApprovalTracker;
  approvalMode: () => ApprovalMode;
  applyWrite: (record: NotesHistoryRecord) => Promise<DurableNoteWriteResult>;
  /** Content hash recorded in each successful proposal receipt. */
  hash: (content: string) => Promise<string>;
  now?: () => number;
  generateCallId?: () => string;
}

export type AgentDistillHandler = MethodHandler;

const PROPOSALS_FOLDER = "Notient/proposals";
const TITLE_MAX_CHARS = 80;
const PREVIEW_BODY_MAX_CHARS = 800;
const PREVIEW_BATCH_MAX_CHARS = 8_000;
/** Bound provider input and memory use even if the opened file grows during the read. */
export const AGENT_DISTILL_MAX_TRANSCRIPT_BYTES = 1_048_576;
const SUPPORTED_FORMATS: ReadonlySet<TranscriptFormat> = new Set([
  "auto",
  "markdown",
  "jsonl",
  "json",
]);

interface ParsedDistillParams {
  transcriptPath: string;
  format: TranscriptFormat;
  dryRun: boolean;
}

interface ProposalPlan {
  path: string;
  body: string;
}

interface ProposalWriteReceipt {
  path: string;
  sha: string;
  historyId: string;
}

type BatchApplyResult =
  | { applied: true; writes: ProposalWriteReceipt[] }
  | { applied: false; reason: string; writes: ProposalWriteReceipt[] };

export function makeAgentDistillHandler(deps: AgentDistillHandlerDeps): AgentDistillHandler {
  const now = deps.now ?? Date.now;
  const generateCallId = deps.generateCallId ?? (() => `agent-distill-${randomUUID()}`);

  return async ({ params, emit, requestId, principal }) => {
    const startedAt = now();
    const parsed = parseDistillParams(params);
    const messages = await readAuthorizedTranscript(parsed, deps.vault, principal);
    const candidates = await deps.distiller.distill(messages);
    const callId = generateCallId();
    const createdAt = now();
    const plans = planProposals({
      candidates,
      transcriptPath: parsed.transcriptPath,
      clientIdentity: principal.id,
      createdAt,
      batchToken: proposalBatchToken(callId),
    });
    const proposalPaths = plans.map((plan) => plan.path);
    const byKind = tallyByKind(candidates);
    const baseResult = (): Record<string, unknown> => ({
      ok: true,
      candidates,
      proposalPaths,
      byKind,
      durationMs: now() - startedAt,
    });

    if (parsed.dryRun) {
      return {
        ...baseResult(),
        dryRun: true,
        applied: false,
        pending: false,
        denied: false,
        proposalsCreated: 0,
        writes: [],
      };
    }

    if (plans.length === 0) {
      return {
        ...baseResult(),
        dryRun: false,
        applied: true,
        pending: false,
        denied: false,
        proposalsCreated: 0,
        writes: [],
      };
    }

    // Refuse a stale or colliding plan before asking a human to approve it.
    // The same check runs again after approval because a call may remain
    // parked while another process creates one of these paths.
    const existingPath = await findExistingPath(deps.vault, plans);
    if (existingPath !== null) {
      return deniedResult(baseResult(), `path already exists: ${existingPath}`, []);
    }

    const preview = renderBatchPreview(plans);
    const outcome = await invokeWithNonBlockingApproval({
      approvalGate: deps.approvalGate,
      tracker: deps.approvalTracker,
      callId,
      invoke: (signal) =>
        approveAndApplyBatch({
          deps,
          plans,
          callId,
          clientIdentity: principal.id,
          transcriptPath: parsed.transcriptPath,
          preview,
          signal,
        }),
    });

    if (outcome.kind === "pending") {
      return {
        ...baseResult(),
        dryRun: false,
        applied: false,
        pending: true,
        denied: false,
        proposalsCreated: 0,
        writes: [],
        callId,
        preview: outcome.preview,
      };
    }

    if (!outcome.value.applied) {
      return deniedResult(baseResult(), outcome.value.reason, outcome.value.writes);
    }

    return {
      ...baseResult(),
      dryRun: false,
      applied: true,
      pending: false,
      denied: false,
      proposalsCreated: outcome.value.writes.length,
      writes: outcome.value.writes,
    };
  };
}

async function readAuthorizedTranscript(
  parsed: ParsedDistillParams,
  vault: Pick<VaultAdapter, "readBounded">,
  principal: Pick<Principal, "id" | "kind">,
): Promise<TranscriptMessage[]> {
  const authorizedPath = authorizeTranscriptPath(parsed.transcriptPath);
  const content = await readTranscriptFile(vault, parsed.transcriptPath);
  const conversation =
    authorizedPath.kind === "conversation"
      ? authorizeConversationTranscript({
          vaultPath: authorizedPath.vaultPath,
          content,
          principalKind: principal.kind,
          principalId: principal.id,
        })
      : null;
  // Every authorized filename ends in `.md`, so a filename hint would force
  // Markdown and defeat supported JSON/JSONL content sniffing.
  const format = parsed.format === "auto" ? detectFormat(content) : parsed.format;
  const messages =
    conversation === null
      ? parseTranscript(content, format)
      : buildTranscriptMessages(
          conversation.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        );
  if (messages.length > 0) return messages;
  throw new RpcError(
    "INVALID_PARAMS",
    `transcript contains no ${format} messages: ${parsed.transcriptPath}`,
  );
}

interface ConversationTranscriptAuthorization {
  vaultPath: string;
  content: string;
  principalKind: "human" | "agent";
  principalId: string;
}

function authorizeConversationTranscript(
  options: ConversationTranscriptAuthorization,
): ReturnType<typeof parseConversation> {
  let conversation: ReturnType<typeof parseConversation>;
  try {
    conversation = parseConversation(options.content, options.vaultPath);
  } catch {
    throw new RpcError("INVALID_PARAMS", "canonical conversation transcript is malformed");
  }
  if (options.principalKind === "human" || conversation.clientIdentity === options.principalId) {
    return conversation;
  }
  throw new RpcError(
    "FORBIDDEN",
    "agent may distill only its own canonical conversation transcripts",
  );
}

function parseDistillParams(params: Record<string, unknown>): ParsedDistillParams {
  const keys = Object.keys(params);
  if (keys.some((key) => key !== "transcriptPath" && key !== "format" && key !== "dryRun")) {
    throw new RpcError(
      "INVALID_PARAMS",
      "agent.distill accepts only transcriptPath, format, and dryRun",
    );
  }
  const rawPath = params.transcriptPath;
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.trim() !== rawPath) {
    throw new RpcError("INVALID_PARAMS", "transcriptPath must be one exact non-empty string");
  }
  if (containsParentTraversal(rawPath)) {
    throw new RpcError("INVALID_PARAMS", "transcriptPath must not contain '..' traversal segments");
  }
  const rawFormat = params.format ?? "auto";
  if (typeof rawFormat !== "string" || !SUPPORTED_FORMATS.has(rawFormat as TranscriptFormat)) {
    throw new RpcError("INVALID_PARAMS", "format must be one of auto | markdown | jsonl | json");
  }
  if (params.dryRun !== undefined && typeof params.dryRun !== "boolean") {
    throw new RpcError("INVALID_PARAMS", "dryRun must be a boolean when provided");
  }
  const dryRun = params.dryRun ?? false;
  return {
    transcriptPath: rawPath,
    format: rawFormat as TranscriptFormat,
    dryRun,
  };
}

function containsParentTraversal(path: string): boolean {
  const segments = path.split(/[\\/]/);
  return segments.some((segment) => segment === "..");
}

type AuthorizedTranscriptKind = "ordinary" | "conversation";

interface AuthorizedTranscriptPath {
  vaultPath: string;
  kind: AuthorizedTranscriptKind;
}

function authorizeTranscriptPath(transcriptPath: string): AuthorizedTranscriptPath {
  const vaultPath = transcriptPath;
  const kind: AuthorizedTranscriptKind | null = isCanonicalConversationPath(vaultPath)
    ? "conversation"
    : isCanonicalOrdinaryNotePath(vaultPath)
      ? "ordinary"
      : null;
  if (kind === null) {
    throw new RpcError(
      "INVALID_PARAMS",
      "transcriptPath must name canonical public Markdown or an exact conversation",
    );
  }

  return {
    vaultPath,
    kind,
  };
}

async function readTranscriptFile(
  vault: Pick<VaultAdapter, "readBounded">,
  displayPath: string,
): Promise<string> {
  try {
    return await vault.readBounded(displayPath, AGENT_DISTILL_MAX_TRANSCRIPT_BYTES);
  } catch (error) {
    return throwTranscriptOpenError(error, displayPath);
  }
}

function throwTranscriptOpenError(error: unknown, displayPath: string): never {
  if (error instanceof VaultReadLimitError) {
    throw new RpcError("INVALID_PARAMS", `transcript exceeds ${error.maxBytes} byte limit`);
  }
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") {
    throw new RpcError("INVALID_PARAMS", `transcript file not found: ${displayPath}`);
  }
  if (error instanceof VaultPathError) {
    throw new RpcError(
      "INVALID_PARAMS",
      "transcriptPath must name a readable regular file without symbolic links",
    );
  }
  throw new RpcError("INVALID_PARAMS", `transcript is not a readable regular file: ${displayPath}`);
}

interface PlanProposalsOptions {
  candidates: Candidate[];
  transcriptPath: string;
  clientIdentity: string;
  createdAt: number;
  batchToken: string;
}

function planProposals(options: PlanProposalsOptions): ProposalPlan[] {
  return options.candidates.map((candidate, index) => {
    const sequence = index + 1;
    const filename = `distilled-${options.createdAt}-${candidate.kind}-${sequence}-${options.batchToken}.md`;
    return {
      path: `${PROPOSALS_FOLDER}/${filename}`,
      body: renderProposalBody({
        candidate,
        transcriptPath: options.transcriptPath,
        clientIdentity: options.clientIdentity,
        createdAt: options.createdAt,
      }),
    };
  });
}

/** Keep filenames collision-resistant without exposing arbitrary call-id bytes. */
function proposalBatchToken(callId: string): string {
  const token = callId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(-16);
  return token.length > 0 ? token : randomUUID().replaceAll("-", "").slice(0, 16);
}

interface ApplyBatchOptions {
  deps: AgentDistillHandlerDeps;
  plans: ProposalPlan[];
  callId: string;
  clientIdentity: string;
  transcriptPath: string;
  preview: string;
  signal: AbortSignal;
}

async function approveAndApplyBatch(options: ApplyBatchOptions): Promise<BatchApplyResult> {
  const proposalPaths = options.plans.map((plan) => plan.path);
  const decision = await options.deps.approvalGate.request(
    {
      id: options.callId,
      name: "agent.distill",
      // ApprovalGate derives the grant folder from `path`. Keeping the first
      // exact proposal path here scopes the whole batch to
      // `Notient/proposals/`; `proposalPaths` is retained for the audit row.
      args: {
        path: proposalPaths[0],
        proposalPaths,
        transcriptPath: options.transcriptPath,
        proposals: proposalPaths.length,
      },
    },
    options.deps.approvalMode(),
    options.preview,
    options.signal,
    { clientIdentity: options.clientIdentity },
  );
  if (!decision.approved) {
    return { applied: false, reason: decision.reason, writes: [] };
  }

  const existingPath = await findExistingPath(options.deps.vault, options.plans);
  if (existingPath !== null) {
    return { applied: false, reason: `path already exists: ${existingPath}`, writes: [] };
  }

  // Finish all pure preparation before the first mutation. Each proposal then
  // crosses the durable intent -> exclusive create -> history close boundary.
  // A later collision cannot roll back an earlier committed history receipt;
  // the caller receives that exact committed prefix instead of a false
  // all-or-nothing result.
  const shas = await Promise.all(options.plans.map((plan) => options.deps.hash(plan.body)));
  const writes: ProposalWriteReceipt[] = [];
  for (let index = 0; index < options.plans.length; index++) {
    const plan = options.plans[index];
    const sha = shas[index];
    if (plan === undefined || sha === undefined) {
      throw new Error("agent.distill: proposal plan and hash count diverged");
    }
    const receipt = await options.deps.applyWrite({
      ...options.deps.approvalGate.writeGuard(decision, options.signal),
      kind: "notes.create",
      target: plan.path,
      before: null,
      after: plan.body,
      clientIdentity: options.clientIdentity,
    });
    if (!receipt.applied) {
      return { applied: false, reason: `path already exists: ${plan.path}`, writes };
    }
    writes.push({ path: plan.path, sha, historyId: receipt.historyId });
  }
  return { applied: true, writes };
}

async function findExistingPath(
  vault: Pick<VaultAdapter, "exists">,
  plans: readonly ProposalPlan[],
): Promise<string | null> {
  for (const plan of plans) {
    if (await vault.exists(plan.path)) return plan.path;
  }
  return null;
}

function deniedResult(
  base: Record<string, unknown>,
  reason: string,
  writes: readonly ProposalWriteReceipt[],
): Record<string, unknown> {
  return {
    ...base,
    dryRun: false,
    applied: false,
    pending: false,
    denied: true,
    proposalsCreated: writes.length,
    writes,
    partial: writes.length > 0,
    reason,
  };
}

function renderBatchPreview(plans: readonly ProposalPlan[]): string {
  const manifest = plans.map((plan) => `- ${plan.path}`).join("\n");
  const sections = plans.map((plan) => {
    const body =
      plan.body.length <= PREVIEW_BODY_MAX_CHARS
        ? plan.body
        : `${plan.body.slice(0, PREVIEW_BODY_MAX_CHARS)}\n... (${plan.body.length - PREVIEW_BODY_MAX_CHARS} more chars)`;
    return `Create ${plan.path}\n---\n${body}`;
  });
  const preview = `Create ${plans.length} distilled proposal note${plans.length === 1 ? "" : "s"}\n\nPaths:\n${manifest}\n\nContents:\n${sections.join("\n\n")}`;
  if (preview.length <= PREVIEW_BATCH_MAX_CHARS) return preview;
  return `${preview.slice(0, PREVIEW_BATCH_MAX_CHARS)}\n... (batch preview truncated)`;
}

interface RenderProposalOptions {
  candidate: Candidate;
  transcriptPath: string;
  clientIdentity: string;
  createdAt: number;
}

function renderProposalBody(options: RenderProposalOptions): string {
  const title = buildTitle(options.candidate.text);
  const frontmatterLines: string[] = [
    "---",
    `kind: ${options.candidate.kind}`,
    `sourceTranscript: ${escapeYamlScalar(options.transcriptPath)}`,
    `clientIdentity: ${escapeYamlScalar(options.clientIdentity)}`,
    "sourceMessageIds:",
  ];
  if (options.candidate.sourceMessageIds.length === 0) {
    frontmatterLines.push("  []");
  } else {
    for (const id of options.candidate.sourceMessageIds) {
      frontmatterLines.push(`  - ${escapeYamlScalar(id)}`);
    }
  }
  frontmatterLines.push(`createdAt: ${options.createdAt}`);
  frontmatterLines.push("---");
  frontmatterLines.push("");
  frontmatterLines.push(`# ${title}`);
  frontmatterLines.push("");
  frontmatterLines.push(options.candidate.text);
  frontmatterLines.push("");
  return frontmatterLines.join("\n");
}

function buildTitle(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const sliced =
    collapsed.length > TITLE_MAX_CHARS ? collapsed.slice(0, TITLE_MAX_CHARS) : collapsed;
  return sliced.replace(/[.,;:!?]+$/u, "").trim();
}

function escapeYamlScalar(input: string): string {
  if (/^[\w./@-][\w./@ -]*$/.test(input)) return input;
  const escaped = input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function tallyByKind(candidates: Candidate[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const candidate of candidates) {
    tally[candidate.kind] = (tally[candidate.kind] ?? 0) + 1;
  }
  return tally;
}

export type { TranscriptMessage };
