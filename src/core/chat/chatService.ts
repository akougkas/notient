/**
 * Chat orchestration facade for Phase 4.
 *
 * The ChatService is the single entry point exposed to the UI layer. It:
 *
 *   1. Probes tool-mode once per chat model id and caches via the settings
 *      writer so subsequent turns skip the round-trip.
 *   2. Runs every turn under `mutex.runPriority("chat", ...)` so chat preempts
 *      background agents (last-priority-wins with co-author).
 *   3. Composes the eight-layer system prompt via {@link ContextManager}.
 *   4. Streams agent-loop events to the UI while also accumulating the
 *      assistant message and any tool exchanges into a working ChatMessage
 *      list.
 *   5. Persists the conversation via {@link ConversationStore} and refreshes
 *      the cross-session memory index via {@link ConversationIndex}.
 *
 * Reasoning persistence is honoured at persist time: when
 * `chat.persistReasoning` is false the assistant's `reasoningContent` is
 * stripped before the conversation is written to disk.
 */

import type { ReasoningMutex } from "../coordinator/reasoningMutex";
import type { EventBus } from "../events/eventBus";
import type { LLMProvider } from "../llm/provider";
import { type AgentLoopEvent, runAgentTurn } from "./agentLoop";
import type { ApprovalGate } from "./approvalGate";
import type { ContextManager } from "./contextManager";
import type { ConversationIndex } from "./conversationIndex";
import { encodeBase64Float32 } from "./conversationIndex";
import type { ConversationStore } from "./conversationStore";
import { SUMMARY_JSON_SCHEMA, summarizePrompt } from "./prompts/summarize";
import { type ToolMode, type ToolModeCache, probeToolMode } from "./toolModeProbe";
import type { ToolRegistry } from "./tools/registry";
import type { ApprovalMode, ChatMessage, Conversation } from "./types";

export interface ChatServiceOptions {
  provider: LLMProvider;
  contextManager: ContextManager;
  conversationStore: ConversationStore;
  conversationIndex: ConversationIndex;
  toolRegistry: ToolRegistry;
  approvalGate: ApprovalGate;
  mutex: ReasoningMutex;
  toolModeCache: ToolModeCache;
  embed: (text: string, signal: AbortSignal) => Promise<Float32Array | null>;
  settings: () => ChatRuntimeSettings;
  generateId?: () => string;
  now?: () => number;
  bus?: EventBus;
}

export interface ChatRuntimeSettings {
  model: string;
  maxRoundsPerTurn: number;
  approvalMode: ApprovalMode;
  persistReasoning: boolean;
}

export type ChatStreamEvent =
  | AgentLoopEvent
  | { type: "turn:start"; conversationId: string; userMessage: ChatMessage }
  | { type: "turn:complete"; conversation: Conversation }
  | { type: "turn:aborted"; reason: string };

export interface SendMessageInput {
  conversation: Conversation;
  userMessage: string;
}

export class ChatService {
  private readonly probedModels = new Set<string>();

  constructor(private readonly options: ChatServiceOptions) {}

  async startConversation(input: {
    topic: string;
    pinnedContext?: string[];
    clientIdentity?: string;
  }): Promise<Conversation> {
    const settings = this.options.settings();
    const generateId = this.options.generateId ?? defaultGenerateId;
    return this.options.conversationStore.create({
      id: generateId(),
      model: settings.model,
      pinnedContext: input.pinnedContext ?? [],
      approvalMode: settings.approvalMode,
      topic: input.topic,
      clientIdentity: input.clientIdentity,
    });
  }

  async listConversations(): Promise<Conversation[]> {
    return this.options.conversationStore.list();
  }

  async loadConversation(notePath: string): Promise<Conversation> {
    return this.options.conversationStore.load(notePath);
  }

  abort(): void {
    this.options.mutex.abort("chat");
  }

  async *sendMessage(input: SendMessageInput): AsyncGenerator<ChatStreamEvent> {
    const generateId = this.options.generateId ?? defaultGenerateId;
    const now = this.options.now ?? Date.now;
    const settings = this.options.settings();
    const userMessage: ChatMessage = {
      id: generateId(),
      role: "user",
      content: input.userMessage,
      createdAt: now(),
    };
    yield {
      type: "turn:start",
      conversationId: input.conversation.id,
      userMessage,
    };

    const queue = new EventQueue<ChatStreamEvent>();
    let finalAssistant: ChatMessage | null = null;
    let toolExchange: ChatMessage[] = [];
    let aborted = false;
    let abortReason = "aborted";

    const runPromise = this.options.mutex
      .runPriority("chat", async (mutexSignal) => {
        const toolMode = await this.ensureToolMode(settings.model, mutexSignal);
        const composed = await this.options.contextManager.compose(
          input.conversation,
          userMessage,
          mutexSignal,
        );
        const generator = runAgentTurn(
          {
            provider: this.options.provider,
            toolRegistry: this.options.toolRegistry,
            approvalGate: this.options.approvalGate,
            maxRoundsPerTurn: settings.maxRoundsPerTurn,
            toolMode: () => toolMode,
            generateId,
            now,
          },
          {
            conversation: input.conversation,
            systemAndHistory: composed.messages,
            model: settings.model,
            signal: mutexSignal,
          },
        );
        for await (const event of generator) {
          queue.push(event);
          if (event.type === "loop:done") {
            finalAssistant = event.finalMessage;
            toolExchange = event.toolMessages;
          }
          if (event.type === "loop:error") {
            aborted = true;
            abortReason = event.message;
          }
        }
      })
      .catch((error) => {
        aborted = true;
        abortReason = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        queue.close();
      });

    for await (const event of queue.drain()) {
      yield event;
    }
    await runPromise;

    if (aborted || finalAssistant === null) {
      yield { type: "turn:aborted", reason: abortReason };
      return;
    }

    const persistedAssistant = settings.persistReasoning
      ? finalAssistant
      : stripReasoning(finalAssistant);
    const updated: Conversation = {
      ...input.conversation,
      messages: [...input.conversation.messages, userMessage, ...toolExchange, persistedAssistant],
      updatedAt: now(),
    };

    // Persist the conversation immediately and yield turn:complete so the UI
    // releases its busy state. The cross-session summary refresh runs in the
    // background; failure is non-fatal and a stale summary just means the
    // next turn's cross-session memory lags by one round.
    const saved = await this.options.conversationStore.save(updated);
    yield { type: "turn:complete", conversation: saved };
    void this.refreshSummaryAndIndex(saved).then(
      async (refreshed) => {
        if (refreshed === saved) return;
        try {
          await this.options.conversationStore.save(refreshed);
        } catch {
          // Background save failures are non-fatal; the conversation still
          // exists with the pre-refresh summary on disk.
        }
      },
      () => {
        // Summary refresh failures are non-fatal; the prior summary stays.
      },
    );
  }

  private async ensureToolMode(model: string, signal: AbortSignal): Promise<ToolMode> {
    const cached = this.options.toolModeCache.read(model);
    if (cached) return cached;
    if (this.probedModels.has(model)) {
      return this.options.toolModeCache.read(model) ?? "disabled";
    }
    this.probedModels.add(model);
    const mode = await probeToolMode({
      provider: this.options.provider,
      model,
      signal,
      cache: this.options.toolModeCache,
      bus: this.options.bus,
    });
    return mode;
  }

  private async refreshSummaryAndIndex(conversation: Conversation): Promise<Conversation> {
    if (conversation.messages.length === 0) {
      await this.options.conversationIndex.record(conversation);
      return conversation;
    }
    const settings = this.options.settings();
    const controller = new AbortController();
    let summary = conversation.summary;
    try {
      const result = await this.options.provider.chatJson<{ summary: string }>(
        summarizePrompt(conversation.messages),
        { model: settings.model, signal: controller.signal },
        SUMMARY_JSON_SCHEMA,
      );
      if (typeof result.summary === "string" && result.summary.length > 0) {
        summary = result.summary;
      }
    } catch {
      // Summary refresh failure is non-fatal; keep the previous summary so
      // we still record the index entry with whatever embedding we have.
    }
    let summaryEmbeddingB64: string | null = conversation.summaryEmbeddingB64;
    if (summary.length > 0) {
      try {
        const embedding = await this.options.embed(summary, controller.signal);
        if (embedding) {
          summaryEmbeddingB64 = encodeBase64Float32(embedding);
        }
      } catch {
        // Keep previous embedding on failure.
      }
    }
    const next: Conversation = { ...conversation, summary, summaryEmbeddingB64 };
    await this.options.conversationIndex.record(next);
    return next;
  }
}

/**
 * Single-producer/single-consumer event queue used to bridge the agent loop
 * generator (which runs inside the mutex callback) to the public async
 * generator returned by sendMessage. The producer pushes events; the consumer
 * drains them via an async iterator that resolves immediately when items are
 * waiting and parks on a promise when the queue is empty.
 */
class EventQueue<T> {
  private readonly items: T[] = [];
  private resolveWaiter: (() => void) | null = null;
  private closed = false;

  push(item: T): void {
    this.items.push(item);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  async *drain(): AsyncGenerator<T> {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift() as T;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.resolveWaiter = resolve;
      });
    }
  }

  private wake(): void {
    if (!this.resolveWaiter) return;
    const resolver = this.resolveWaiter;
    this.resolveWaiter = null;
    resolver();
  }
}

function stripReasoning(message: ChatMessage): ChatMessage {
  if (!message.reasoningContent) return message;
  const { reasoningContent: _omitted, ...rest } = message;
  return rest;
}

function defaultGenerateId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
