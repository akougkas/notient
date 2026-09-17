import type { InferenceAttempt } from "../../core/llm/executionBudget";
/**
 * chat.* RPC handlers.
 *
 * Six methods: chat.start, chat.send, chat.abort, chat.list, chat.load,
 * chat.approve. The heavy one is chat.send: it resolves @<path> mentions
 * through the agent's attachments resolver (vision via the optional
 * VisionRouter, or VISION_UNAVAILABLE), subscribes to the ApprovalGate for
 * the duration of the turn, then forwards each ChatService stream event
 * through the wire-name bridge from the substrate's kebab-case
 * AgentLoopEvent names to the spec section 4.3 wire names.
 *
 * The bridge is deliberately localized to this file: every other layer in
 * the codebase consumes spec wire names. agentLoop and ChatService stay
 * untouched.
 */

import type { VaultAdapter } from "../../adapters/vaultAdapter";
import { resolveAttachments } from "../../agent/attachments";
import type { VisionRouter } from "../../agent/visionProbe";
import { normalizeRejectionReason } from "../../core/approvals/rejectionReason";
import type { AgentLoopEvent } from "../../core/chat/agentLoop";
import type { ApprovalDecision, ApprovalGate } from "../../core/chat/approvalGate";
import type { ChatService } from "../../core/chat/chatService";
import type { Conversation } from "../../core/chat/types";
import type { EventBus } from "../../core/events/eventBus";
import {
  isCanonicalConversationPath,
  isCanonicalOrdinaryNotePath,
} from "../../core/vault/publicPath";
import { type MethodHandler, RpcError, encodeEvent } from "../rpc";

export interface ChatHandlerDeps {
  chatService: ChatService;
  approvalGate: ApprovalGate;
  vault: VaultAdapter;
  visionRouter: VisionRouter | null;
  pinnedNoteMaxTokens: number;
  bus: EventBus;
}

export type ChatHandler = MethodHandler;

export interface ChatHandlers {
  start: ChatHandler;
  send: ChatHandler;
  abort: ChatHandler;
  list: ChatHandler;
  load: ChatHandler;
  approve: ChatHandler;
}

export function makeChatHandlers(deps: ChatHandlerDeps): ChatHandlers {
  /**
   * Turns in flight, keyed by the connection that started them. A connection
   * may cancel only its own turns; a human may explicitly request the
   * process-wide scope with `allConnections: true`.
   */
  const turnsByConnection = new Map<string, number>();
  /**
   * Owner principal id for each pending approval call id, so `chat.approve`
   * can refuse a call id belonging to somebody else's turn.
   */

  const beginTurn = (connectionId: string): void => {
    turnsByConnection.set(connectionId, (turnsByConnection.get(connectionId) ?? 0) + 1);
  };
  const endTurn = (connectionId: string): void => {
    const next = (turnsByConnection.get(connectionId) ?? 1) - 1;
    if (next <= 0) turnsByConnection.delete(connectionId);
    else turnsByConnection.set(connectionId, next);
  };

  const findConversationById = async (id: string): Promise<Conversation> => {
    const all = await deps.chatService.listConversations();
    const matches = all.filter((conversation) => conversation.id === id);
    if (matches.length > 1) {
      throw new Error(`conversation storage integrity: duplicate conversation id '${id}'`);
    }
    const conversation = matches[0];
    if (conversation === undefined) {
      throw new RpcError("INVALID_PARAMS", `conversation ${id} not found`);
    }
    return conversation;
  };

  return {
    start: async ({ params, principal }) => {
      const { topic, pinnedContext } = parseStartParams(params);
      const conversation = await deps.chatService.startConversation({
        topic,
        pinnedContext,
        clientIdentity: principal.id,
      });
      return { ok: true, conversation };
    },
    send: async ({ params, emit, requestId, principal, connectionId }) => {
      const { conversationId, userMessage } = parseSendParams(params);
      const conversation = await findConversationById(conversationId);
      assertConversationOwner(conversation, principal.id);

      // Resolve user-supplied attachments only after the transcript owner is
      // authorized. A refused cross-principal send must not touch the vault,
      // invoke vision, mutate shared context, or reach the provider.
      const attachments = await resolveAttachments({
        vault: deps.vault,
        message: userMessage,
        maxTokens: deps.pinnedNoteMaxTokens,
        resolveImage: makeImageResolver(deps.visionRouter),
      });

      const conversationIdAtTurnStart = conversation.id;
      const unsubscribeApprovals = subscribeApprovalEvents(
        deps.approvalGate,
        emit,
        requestId,
        principal.id,
        principal.kind === "human",
      );
      const unsubscribeSummary = deps.bus.on("loop:context_summarized", (event) => {
        if (event.conversationId !== conversationIdAtTurnStart) return;
        emit(
          encodeEvent(requestId, "loop:context_summarized", {
            conversationId: event.conversationId,
            model: event.model,
            originalTokens: event.originalTokens,
            summarizedTokens: event.summarizedTokens,
          }),
        );
      });
      const unsubscribeOverflow = deps.bus.on("loop:context_overflow_warning", (event) => {
        if (event.conversationId !== conversationIdAtTurnStart) return;
        emit(
          encodeEvent(requestId, "loop:context_overflow_warning", {
            conversationId: event.conversationId,
            model: event.model,
            configuredTokens: event.configuredTokens,
            estimatedTokens: event.estimatedTokens,
          }),
        );
      });
      const unsubscribeProbed = deps.bus.on("loop:tool_mode_probed", (event) => {
        emit(
          encodeEvent(requestId, "loop:tool_mode_probed", {
            model: event.model,
            mode: event.mode,
            attempts: event.attempts,
          }),
        );
      });
      beginTurn(connectionId);
      try {
        return await runSendStream(
          deps.chatService,
          conversation,
          userMessage,
          attachments.pinnedContext,
          emit,
          requestId,
          connectionId,
        );
      } finally {
        endTurn(connectionId);
        unsubscribeProbed();
        unsubscribeOverflow();
        unsubscribeSummary();
        unsubscribeApprovals();
      }
    },
    abort: async ({ params, principal, connectionId }) => {
      const isHuman = principal.kind === "human";
      // Process-wide cancellation is a separate explicit capability and is
      // reachable only when a human asks for it by name.
      if (params.allConnections === true) {
        if (!isHuman) {
          throw new RpcError("FORBIDDEN", "a process-wide abort requires a human principal");
        }
        deps.chatService.abortAllConnections();
        return { ok: true, aborted: true, scope: "all" };
      }
      // Default scope is the calling connection. Without a turn of its own
      // there is nothing to cancel, whoever is asking.
      if (!turnsByConnection.has(connectionId)) {
        return { ok: true, aborted: false };
      }
      deps.chatService.abortConnection(connectionId);
      return { ok: true, aborted: true };
    },
    list: async ({ principal }) => {
      const conversations = await deps.chatService.listConversations();
      return {
        ok: true,
        conversations:
          principal.kind === "human"
            ? conversations
            : conversations.filter((conversation) => conversation.clientIdentity === principal.id),
      };
    },
    load: async ({ params, principal }) => {
      const notePath = typeof params.notePath === "string" ? params.notePath : "";
      if (!isCanonicalConversationPath(notePath)) {
        throw new RpcError(
          "INVALID_PARAMS",
          "notePath must be one exact Notient conversation path",
        );
      }
      const conversation = await deps.chatService.loadConversation(notePath);
      if (principal.kind !== "human") assertConversationOwner(conversation, principal.id);
      return { ok: true, conversation };
    },
    approve: async ({ params, principal }) => {
      const callId = typeof params.callId === "string" ? params.callId.trim() : "";
      if (callId.length === 0) {
        throw new RpcError("INVALID_PARAMS", "callId is required");
      }
      const decision = parseApprovalDecision(params);
      if (principal.kind !== "human" || !principal.scopes.includes("admin"))
        throw new RpcError(
          "FORBIDDEN",
          "tool decisions require an authenticated human administrator",
        );
      const resolved = deps.approvalGate.resolve(callId, decision, { ...principal, kind: "human" });
      if (!resolved) {
        throw new RpcError("INVALID_PARAMS", `unknown call id: ${callId}`);
      }
      return decision.approved
        ? { ok: true, callId, approved: true }
        : { ok: true, callId, approved: false, reason: decision.reason };
    },
  };
}

function parseStartParams(params: Record<string, unknown>): {
  topic: string;
  pinnedContext?: string[];
} {
  const rawTopic = params.topic;
  const topic = rawTopic === undefined ? "Untitled" : rawTopic;
  if (
    typeof topic !== "string" ||
    topic.length === 0 ||
    topic.trim() !== topic ||
    topic.length > 200
  ) {
    throw new RpcError("INVALID_PARAMS", "topic must be an exact non-empty string up to 200 chars");
  }
  const rawPinned = params.pinnedContext;
  if (rawPinned === undefined) return { topic };
  if (
    !Array.isArray(rawPinned) ||
    rawPinned.length > 64 ||
    rawPinned.some((entry) => !isCanonicalOrdinaryNotePath(entry))
  ) {
    throw new RpcError(
      "INVALID_PARAMS",
      "pinnedContext must contain at most 64 exact ordinary Markdown note paths",
    );
  }
  const pinnedContext = rawPinned as string[];
  const totalChars = pinnedContext.reduce((total, entry) => total + entry.length, 0);
  if (totalChars > 262_144) {
    throw new RpcError("INVALID_PARAMS", "pinnedContext must not exceed 262144 characters");
  }
  return { topic, pinnedContext: [...pinnedContext] };
}

function assertConversationOwner(conversation: Conversation, principalId: string): void {
  if (conversation.clientIdentity !== principalId) {
    throw new RpcError("FORBIDDEN", "conversation belongs to another principal");
  }
}

function parseApprovalDecision(params: Record<string, unknown>): ApprovalDecision {
  if (typeof params.approved !== "boolean") {
    throw new RpcError("INVALID_PARAMS", "approved must be a boolean");
  }
  if (params.approved) {
    if (params.reason !== undefined) {
      throw new RpcError("INVALID_PARAMS", "reason is valid only when denying a pending tool call");
    }
    return { approved: true };
  }
  if (params.reason !== undefined && typeof params.reason !== "string") {
    throw new RpcError("INVALID_PARAMS", "reason must be a string");
  }
  try {
    return {
      approved: false,
      reason: normalizeRejectionReason(params.reason as string | undefined) ?? "rejected by user",
    };
  } catch (error) {
    throw new RpcError("INVALID_PARAMS", error instanceof Error ? error.message : String(error));
  }
}

type ChatStreamEvent =
  | { type: "turn:usage"; attempts: InferenceAttempt[]; durationMs: number }
  | AgentLoopEvent
  | { type: "turn:start"; conversationId: string; userMessage: unknown }
  | { type: "turn:complete"; conversation: Conversation }
  | { type: "turn:aborted"; reason: string };

function parseSendParams(params: Record<string, unknown>): {
  conversationId: string;
  userMessage: string;
} {
  const conversationId = typeof params.conversationId === "string" ? params.conversationId : "";
  const userMessage = typeof params.userMessage === "string" ? params.userMessage : "";
  if (conversationId.length === 0) {
    throw new RpcError("INVALID_PARAMS", "conversationId is required");
  }
  if (userMessage.length === 0) {
    throw new RpcError("INVALID_PARAMS", "userMessage is required");
  }
  return { conversationId, userMessage };
}

function makeImageResolver(
  visionRouter: VisionRouter | null,
): (path: string, bytes: ArrayBuffer, mediaType: string) => Promise<string> {
  return async (path, bytes, mediaType) => {
    if (visionRouter === null) {
      throw new RpcError(
        "VISION_UNAVAILABLE",
        "vision is not supported in this session. Load a multimodal primary model and restart Notient.",
      );
    }
    return visionRouter.describe({ path, bytes, mediaType });
  };
}

/**
 * Bridge the process-wide ApprovalGate onto one turn's NDJSON stream.
 *
 * The gate has a single listener list, so every subscriber hears every
 * pending call in the process. An agent's stream must not: a pending frame
 * carries the tool `args` and the rendered `preview`, which would hand one
 * agent the body of the human's (or another agent's) `notes.write`.
 *
 * A non-human subscriber therefore sees only the entries the gate attributes
 * to its own principal via `requestedBy`. A human owns the daemon and keeps
 * seeing everything, which is what drives the approval prompt.
 */
function subscribeApprovalEvents(
  gate: ApprovalGate,
  emit: (line: string) => void,
  envelopeId: string,
  ownerId: string,
  isHuman: boolean,
): () => void {
  const trackedCallIds = new Set<string>();
  return gate.subscribe({
    onPending: (pending) => {
      if (!isHuman && pending.requestedBy !== ownerId) return;
      trackedCallIds.add(pending.callId);
      emit(
        encodeEvent(envelopeId, "loop:approval_pending", {
          callId: pending.callId,
          tool: pending.toolName,
          args: pending.args,
          preview: pending.preview,
        }),
      );
    },
    onResolved: (callId, decision) => {
      if (!trackedCallIds.has(callId)) return;
      trackedCallIds.delete(callId);
      emit(
        encodeEvent(
          envelopeId,
          "loop:approval_resolved",
          decision.approved
            ? { callId, approved: true }
            : { callId, approved: false, reason: decision.reason },
        ),
      );
    },
  });
}

async function runSendStream(
  chatService: ChatService,
  conversation: Conversation,
  userMessage: string,
  ephemeralContext: readonly string[],
  emit: (line: string) => void,
  envelopeId: string,
  /** Connection owner, so `chat.abort` stops only this turn. */
  connectionId: string,
): Promise<Record<string, unknown>> {
  let finalConversation: Conversation = conversation;
  for await (const event of chatService.sendMessage({
    conversation,
    userMessage,
    connectionId,
    ephemeralContext,
  })) {
    forwardChatEvent(emit, envelopeId, event);
    if (event.type === "turn:complete") {
      finalConversation = event.conversation;
    }
    if (event.type === "turn:aborted") {
      throw new Error(`turn aborted: ${event.reason}`);
    }
  }
  return { ok: true, conversation: finalConversation };
}

function forwardChatEvent(
  emit: (line: string) => void,
  envelopeId: string,
  event: ChatStreamEvent,
): void {
  switch (event.type) {
    case "turn:start":
      emit(
        encodeEvent(envelopeId, "turn:start", {
          conversationId: event.conversationId,
          userMessage: event.userMessage,
        }),
      );
      return;
    case "turn:usage":
      emit(
        encodeEvent(envelopeId, "turn:usage", {
          attempts: event.attempts,
          durationMs: event.durationMs,
        }),
      );
      return;
    case "turn:complete":
      emit(
        encodeEvent(envelopeId, "turn:complete", {
          conversation: event.conversation,
        }),
      );
      return;
    case "turn:aborted":
      emit(encodeEvent(envelopeId, "turn:aborted", { reason: event.reason }));
      return;
    case "loop:assistant-token":
      emit(
        encodeEvent(envelopeId, "loop:assistant_delta", {
          contentDelta: event.delta,
        }),
      );
      return;
    case "loop:reasoning-token":
      emit(
        encodeEvent(envelopeId, "loop:reasoning_delta", {
          reasoningDelta: event.delta,
        }),
      );
      return;
    case "loop:tool-call":
      emit(
        encodeEvent(envelopeId, "loop:tool_call_started", {
          callId: event.call.id,
          tool: event.call.name,
          args: event.call.args,
        }),
      );
      return;
    case "loop:tool-result":
      if (event.result.status === "ok") {
        emit(
          encodeEvent(envelopeId, "loop:tool_call_result", {
            callId: event.result.callId,
            result: event.result.data,
            durationMs: event.result.durationMs,
          }),
        );
      } else {
        emit(
          encodeEvent(envelopeId, "loop:tool_call_error", {
            callId: event.result.callId,
            error: event.result.error,
            durationMs: event.result.durationMs,
          }),
        );
      }
      return;
    case "loop:approval-pending":
      // The gate's subscribe() hook already emitted loop:approval_pending
      // with the preview. Skip the agentLoop's own emit to avoid duplicates.
      return;
    case "loop:done":
      emit(
        encodeEvent(envelopeId, "loop:done", {
          finalMessage: event.finalMessage,
          truncated: event.truncated ?? false,
        }),
      );
      return;
    case "loop:error":
      emit(encodeEvent(envelopeId, "loop:error", { message: event.message }));
      return;
  }
}
