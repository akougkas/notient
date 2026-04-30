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
import type { AgentLoopEvent } from "../../core/chat/agentLoop";
import type { ApprovalGate } from "../../core/chat/approvalGate";
import type { ChatService } from "../../core/chat/chatService";
import type { Conversation } from "../../core/chat/types";
import type { EventBus } from "../../core/events/eventBus";
import { encodeEvent } from "../rpc";

export interface ChatHandlerDeps {
  chatService: ChatService;
  approvalGate: ApprovalGate;
  vault: VaultAdapter;
  visionRouter: VisionRouter | null;
  pinnedNoteMaxTokens: number;
  bus: EventBus;
}

export type ChatHandler = (
  params: Record<string, unknown>,
  emit: (line: string) => void,
  envelopeId: string,
  clientIdentity: string,
) => Promise<Record<string, unknown>>;

export interface ChatHandlers {
  start: ChatHandler;
  send: ChatHandler;
  abort: ChatHandler;
  list: ChatHandler;
  load: ChatHandler;
  approve: ChatHandler;
}

export function makeChatHandlers(deps: ChatHandlerDeps): ChatHandlers {
  const conversationsById = new Map<string, Conversation>();

  const cacheConversation = (conversation: Conversation): void => {
    conversationsById.set(conversation.id, conversation);
  };

  const findConversationById = async (id: string): Promise<Conversation> => {
    const cached = conversationsById.get(id);
    if (cached) return cached;
    const all = await deps.chatService.listConversations();
    for (const conversation of all) cacheConversation(conversation);
    const fresh = conversationsById.get(id);
    if (!fresh) throw new Error(`INVALID_PARAMS: conversation ${id} not found`);
    return fresh;
  };

  return {
    start: async (params, _emit, _envelopeId, clientIdentity) => {
      const topic = typeof params.topic === "string" ? params.topic : "Untitled";
      const pinnedContext = Array.isArray(params.pinnedContext)
        ? (params.pinnedContext as string[])
        : undefined;
      const conversation = await deps.chatService.startConversation({
        topic,
        pinnedContext,
        clientIdentity,
      });
      cacheConversation(conversation);
      return { ok: true, conversation };
    },
    send: async (params, emit, envelopeId) => {
      const { conversationId, userMessage } = parseSendParams(params);
      const attachments = await resolveAttachments({
        vault: deps.vault,
        message: userMessage,
        maxTokens: deps.pinnedNoteMaxTokens,
        resolveImage: makeImageResolver(deps.visionRouter),
      });

      const conversation = await findConversationById(conversationId);
      if (attachments.pinnedContext.length > 0) {
        conversation.pinnedContext = [...conversation.pinnedContext, ...attachments.pinnedContext];
      }

      const conversationIdAtTurnStart = conversation.id;
      const unsubscribeApprovals = subscribeApprovalEvents(deps.approvalGate, emit, envelopeId);
      const unsubscribeSummary = deps.bus.on("loop:context_summarized", (event) => {
        if (event.conversationId !== conversationIdAtTurnStart) return;
        emit(
          encodeEvent(envelopeId, "loop:context_summarized", {
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
          encodeEvent(envelopeId, "loop:context_overflow_warning", {
            conversationId: event.conversationId,
            model: event.model,
            configuredTokens: event.configuredTokens,
            estimatedTokens: event.estimatedTokens,
          }),
        );
      });
      const unsubscribeProbed = deps.bus.on("loop:tool_mode_probed", (event) => {
        emit(
          encodeEvent(envelopeId, "loop:tool_mode_probed", {
            model: event.model,
            mode: event.mode,
            attempts: event.attempts,
          }),
        );
      });
      try {
        return await runSendStream(
          deps.chatService,
          conversation,
          userMessage,
          emit,
          envelopeId,
          cacheConversation,
        );
      } finally {
        unsubscribeProbed();
        unsubscribeOverflow();
        unsubscribeSummary();
        unsubscribeApprovals();
      }
    },
    abort: async () => {
      deps.chatService.abort();
      return { ok: true };
    },
    list: async () => {
      const conversations = await deps.chatService.listConversations();
      for (const conversation of conversations) cacheConversation(conversation);
      return { ok: true, conversations };
    },
    load: async (params) => {
      const notePath = typeof params.notePath === "string" ? params.notePath : "";
      if (notePath.length === 0) {
        throw new Error("INVALID_PARAMS: notePath is required");
      }
      const conversation = await deps.chatService.loadConversation(notePath);
      cacheConversation(conversation);
      return { ok: true, conversation };
    },
    approve: async (params) => {
      const callId = typeof params.callId === "string" ? params.callId : "";
      const approved = params.approved === true;
      const reason = typeof params.reason === "string" ? params.reason : undefined;
      if (callId.length === 0) {
        throw new Error("INVALID_PARAMS: callId is required");
      }
      const resolved = deps.approvalGate.resolve(callId, { approved, reason });
      if (!resolved) {
        throw new Error(`INVALID_PARAMS: unknown call id: ${callId}`);
      }
      return { ok: true };
    },
  };
}

type ChatStreamEvent =
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
    throw new Error("INVALID_PARAMS: conversationId is required");
  }
  if (userMessage.length === 0) {
    throw new Error("INVALID_PARAMS: userMessage is required");
  }
  return { conversationId, userMessage };
}

function makeImageResolver(
  visionRouter: VisionRouter | null,
): (path: string, bytes: ArrayBuffer, mediaType: string) => Promise<string> {
  return async (path, bytes, mediaType) => {
    if (visionRouter === null) {
      throw new Error(
        "VISION_UNAVAILABLE: vision is not supported in this session. Either load a multi-modal model in LMStudio at the primary baseUrl, or configure chat.vision.",
      );
    }
    return visionRouter.describe({ path, bytes, mediaType });
  };
}

function subscribeApprovalEvents(
  gate: ApprovalGate,
  emit: (line: string) => void,
  envelopeId: string,
): () => void {
  const trackedCallIds = new Set<string>();
  return gate.subscribe({
    onPending: (pending) => {
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
        encodeEvent(envelopeId, "loop:approval_resolved", {
          callId,
          approved: decision.approved,
          reason: decision.reason,
        }),
      );
    },
  });
}

async function runSendStream(
  chatService: ChatService,
  conversation: Conversation,
  userMessage: string,
  emit: (line: string) => void,
  envelopeId: string,
  cache: (conversation: Conversation) => void,
): Promise<Record<string, unknown>> {
  let finalConversation: Conversation = conversation;
  for await (const event of chatService.sendMessage({ conversation, userMessage })) {
    forwardChatEvent(emit, envelopeId, event);
    if (event.type === "turn:complete") {
      finalConversation = event.conversation;
      cache(event.conversation);
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
