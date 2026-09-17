import {
  type InferenceAttempt,
  InferenceBudget,
  type InferenceBudgetLimits,
} from "../llm/executionBudget";
/**
 * Chat orchestration facade for the awakened vault.
 *
 * The ChatService is the single entry point exposed to the UI layer. It:
 *
 *   1. Probes tool-mode once per chat model id and caches it in process-local
 *      learned state so subsequent turns skip the round-trip.
 *   2. Runs every turn under `scheduler.runPriority("chat", ...)` so chat preempts
 *      background reasoning work.
 *   3. Composes the sentient-notes context via {@link ContextManager}.
 *   4. Streams agent-loop events to the UI while also accumulating the
 *      assistant message and any tool exchanges into a working ChatMessage
 *      list.
 *   5. Persists the conversation via {@link ConversationStore} and refreshes
 *      the cross-session memory index via the SurrealDB conversation memory.
 *
 * Reasoning persistence is honoured at persist time: when
 * `chat.persistReasoning` is false the assistant's `reasoningContent` is
 * stripped before the conversation is written to disk.
 */

import type { ReasoningScheduler } from "../coordinator/reasoningScheduler";
import { type EventBus, assertEventBus } from "../events/eventBus";
import type { LLMProvider } from "../llm/provider";
import { type AgentLoopEvent, runAgentTurn } from "./agentLoop";
import type { ContextManager } from "./contextManager";
import type { ConversationMemory } from "./conversationIndex";
import type { ConversationStore } from "./conversationStore";
import { SUMMARY_JSON_SCHEMA, summarizePrompt } from "./prompts/summarize";
import { type ToolMode, type ToolModeCache, probeToolMode } from "./toolModeProbe";
import type { ToolRegistry } from "./tools/registry";
import type { ApprovalMode, ChatMessage, Conversation } from "./types";

export interface ChatServiceOptions {
  provider: LLMProvider;
  contextManager: ContextManager;
  conversationStore: ConversationStore;
  conversationIndex: ConversationMemory;
  toolRegistry: ToolRegistry;
  scheduler: ReasoningScheduler;
  toolModeCache: ToolModeCache;
  embed: (text: string, signal: AbortSignal) => Promise<Float32Array | null>;
  settings: () => ChatRuntimeSettings;
  generateId?: () => string;
  now?: () => number;
  bus: EventBus;
}

export interface ChatRuntimeSettings {
  model: string;
  maxRoundsPerTurn: number;
  approvalMode: ApprovalMode;
  persistReasoning: boolean;
  budget: InferenceBudgetLimits;
}

export type ChatStreamEvent =
  | AgentLoopEvent
  | { type: "turn:usage"; attempts: InferenceAttempt[]; durationMs: number }
  | { type: "turn:start"; conversationId: string; userMessage: ChatMessage }
  | { type: "turn:complete"; conversation: Conversation }
  | { type: "turn:aborted"; reason: string };

export interface SendMessageInput {
  conversation: Conversation;
  userMessage: string;
  /** RPC connection that owns this turn and may cancel it. */
  connectionId: string;
  /** Resolved attachment bodies visible to this turn only; never persisted as note paths. */
  ephemeralContext?: readonly string[];
}

export class ChatService {
  /** Prevent an older post-turn summary from overwriting a newer transcript. */
  private readonly summaryRefreshTails = new Map<string, Promise<void>>();
  /**
   * In-flight turns grouped by abort scope. The scheduler label stays `"chat"`
   * for every turn so scheduling and the priority preemption rule are
   * unchanged; only cancellation is scoped.
   */
  private readonly turnControllers = new Map<string, Set<AbortController>>();

  constructor(private readonly options: ChatServiceOptions) {
    assertEventBus(options.bus, "ChatService");
  }

  async startConversation(input: {
    topic: string;
    pinnedContext?: string[];
    clientIdentity: string;
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

  /** Wait for every accepted post-turn summary/index refresh to settle. */
  async drain(): Promise<void> {
    while (this.summaryRefreshTails.size > 0) {
      await Promise.all(this.summaryRefreshTails.values());
    }
  }

  /** Cancel only turns owned by one RPC connection. */
  abortConnection(connectionId: string): void {
    const controllers = this.turnControllers.get(connectionId);
    if (controllers === undefined) return;
    for (const controller of controllers) controller.abort();
  }

  /** Cancel every chat turn, reached only through the human-only RPC branch. */
  abortAllConnections(): void {
    for (const controllers of this.turnControllers.values()) {
      for (const controller of controllers) controller.abort();
    }
  }

  private registerTurn(connectionId: string, controller: AbortController): void {
    const existing = this.turnControllers.get(connectionId);
    if (existing === undefined) this.turnControllers.set(connectionId, new Set([controller]));
    else existing.add(controller);
  }

  private releaseTurn(connectionId: string, controller: AbortController): void {
    const existing = this.turnControllers.get(connectionId);
    if (existing === undefined) return;
    existing.delete(controller);
    if (existing.size === 0) this.turnControllers.delete(connectionId);
  }

  async *sendMessage(input: SendMessageInput): AsyncGenerator<ChatStreamEvent> {
    const generateId = this.options.generateId ?? defaultGenerateId;
    const now = this.options.now ?? Date.now;
    const settings = this.options.settings();
    const conversation = input.conversation;
    const userMessage: ChatMessage = {
      id: generateId(),
      role: "user",
      content: input.userMessage,
      createdAt: now(),
    };

    // Register before exposing turn:start so an abort cannot land in a gap
    // where the handler sees an owned turn but ChatService cannot cancel it.
    const turnController = new AbortController();
    this.registerTurn(input.connectionId, turnController);
    try {
      yield {
        type: "turn:start",
        conversationId: conversation.id,
        userMessage,
      };

      const queue = new EventQueue<ChatStreamEvent>();
      let finalAssistant: ChatMessage | null = null;
      let toolExchange: ChatMessage[] = [];
      let aborted = false;
      let abortReason = "aborted";

      const budget = new InferenceBudget(settings.budget);
      const started = performance.now();
      const runPromise = this.options.scheduler
        .runPriority(
          "chat",
          (scheduledSignal) =>
            budget.run(async () => {
              const signal = AbortSignal.any([scheduledSignal, budget.signal]);
              if (signal.aborted) throw abortError();
              const toolMode = await this.ensureToolMode(settings.model, signal);
              const composed = await this.options.contextManager.compose(
                conversation,
                userMessage,
                signal,
                input.ephemeralContext,
              );
              const generator = runAgentTurn(
                {
                  provider: this.options.provider,
                  toolRegistry: this.options.toolRegistry,
                  maxRoundsPerTurn: settings.maxRoundsPerTurn,
                  generationTokens: settings.budget.generationTokens,
                  toolMode: () => toolMode,
                  contextBudgetTokens: this.options.contextManager.contextBudgetTokens(),
                  generateId,
                  now,
                },
                {
                  conversation,
                  systemAndHistory: composed.messages,
                  model: settings.model,
                  signal,
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
              await budget.flush();
              budget.assertAvailable();
            }),
          { signal: AbortSignal.any([budget.signal, turnController.signal]) },
        )
        .catch((error) => {
          aborted = true;
          abortReason = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          this.releaseTurn(input.connectionId, turnController);
          queue.close();
        });

      for await (const event of queue.drain()) {
        yield event;
      }
      await runPromise;
      await budget.flush();
      const usage = {
        attempts: structuredClone(budget.attempts),
        durationMs: Math.round(performance.now() - started),
      };
      yield { type: "turn:usage", ...usage };
      this.options.bus.emit({
        type: "chat:usage",
        runId: userMessage.id,
        phase: "answer",
        state: aborted || finalAssistant === null ? "incomplete" : "complete",
        ...usage,
      });

      if (aborted || finalAssistant === null) {
        yield { type: "turn:aborted", reason: abortReason };
        return;
      }

      const persistedAssistant = settings.persistReasoning
        ? finalAssistant
        : stripReasoning(finalAssistant);
      const updated: Conversation = {
        ...conversation,
        messages: [...conversation.messages, userMessage, ...toolExchange, persistedAssistant],
      };

      // Persist the conversation immediately and yield turn:complete so the UI
      // releases its busy state. The cross-session summary refresh runs in the
      // background; failure is non-fatal and a stale summary just means the
      // next turn's cross-session memory lags by one round.
      const saved = await this.options.conversationStore.save(input.conversation, updated);
      yield { type: "turn:complete", conversation: saved };
      this.queueSummaryRefresh(saved, budget, userMessage.id, started);
    } finally {
      // Async-generator consumers may leave immediately after any yielded
      // event. Cancel and release in that path as well as the run promise's
      // normal completion path.
      turnController.abort();
      this.releaseTurn(input.connectionId, turnController);
    }
  }

  private async ensureToolMode(model: string, signal: AbortSignal): Promise<ToolMode> {
    const cached = this.options.toolModeCache.read(model);
    if (cached) return cached;
    const mode = await probeToolMode({
      provider: this.options.provider,
      model,
      signal,
      cache: this.options.toolModeCache,
      bus: this.options.bus,
    });
    return mode;
  }

  private queueSummaryRefresh(
    conversation: Conversation,
    budget: InferenceBudget,
    runId: string,
    started: number,
  ): void {
    const prior = this.summaryRefreshTails.get(conversation.id) ?? Promise.resolve();
    let complete = false;
    const refresh = prior
      .then(() =>
        budget.run(async () => {
          budget.assertAvailable();
          complete = await this.refreshSummaryAndIndex(conversation, budget);
          await budget.flush();
          budget.assertAvailable();
        }),
      )
      .catch(() => {
        // The completed turn is already durable. Summary memory is derived,
        // so an isolated refresh failure must not fail the user's turn.
      });
    this.summaryRefreshTails.set(conversation.id, refresh);
    void refresh.finally(() => {
      this.options.bus.emit({
        type: "chat:usage",
        runId,
        phase: "memory",
        state: complete ? "complete" : "incomplete",
        attempts: structuredClone(budget.attempts),
        durationMs: Math.round(performance.now() - started),
      });
      if (this.summaryRefreshTails.get(conversation.id) === refresh) {
        this.summaryRefreshTails.delete(conversation.id);
      }
    });
  }

  private async refreshSummaryAndIndex(
    conversation: Conversation,
    budget: InferenceBudget,
  ): Promise<boolean> {
    if (conversation.messages.length === 0) {
      await this.options.conversationIndex.record(conversation, null);
      return false;
    }
    const settings = this.options.settings();
    let summary = conversation.summary;
    let summarized = false;
    try {
      const result = await this.options.scheduler.run(
        "chat:summary",
        (signal) =>
          this.options.provider.chatJson<{ summary: string }>(
            summarizePrompt(conversation.messages),
            { model: settings.model, signal, maxTokens: settings.budget.generationTokens },
            SUMMARY_JSON_SCHEMA,
          ),
        { signal: budget.signal },
      );
      if (typeof result.summary === "string" && result.summary.length > 0) {
        summary = result.summary;
        summarized = true;
      }
    } catch {
      // Summary refresh failure keeps the canonical summary unchanged.
    }
    let embedding: Float32Array | null = null;
    if (summary.length > 0) {
      try {
        embedding = await this.options.embed(summary, budget.signal);
      } catch {
        // Null means the index may retain a row only when its exact model,
        // width, and summary hash still match.
      }
    }

    await budget.flush();
    budget.assertAvailable();
    // Invalidate a changed summary first. If embedding or persistence fails,
    // a semantic row for the old summary can never masquerade as memory for
    // the new Markdown.
    if (summary !== conversation.summary) {
      await this.options.conversationIndex.remove(conversation.id);
    }
    const persisted = await this.options.conversationStore.updateSummary(
      conversation.notePath,
      conversation.id,
      summary,
    );
    await this.options.conversationIndex.record(persisted, embedding);
    return summarized && embedding !== null;
  }
}

/**
 * Single-producer/single-consumer event queue used to bridge the agent loop
 * generator (which runs inside the scheduler callback) to the public async
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

function abortError(): Error {
  if (typeof DOMException !== "undefined") return new DOMException("aborted", "AbortError");
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
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
