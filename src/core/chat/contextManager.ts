/**
 * Eight-layer context manager for the chat agent loop.
 *
 * On every turn, {@link ContextManager.compose} walks the layers (identity,
 * user profile, vault snapshot, workspace state, pinned context, cross-session
 * memory, tool catalog, conversation history) and produces the message list
 * fed to the LLM. When the running token budget exceeds
 * `contextBudgetFraction * modelContextTokens`, the oldest 50% of the
 * conversation is replaced by a single summary message so the newest exchanges
 * stay verbatim.
 *
 * The manager is IO-injected: it never touches the vault adapter, embedder,
 * or workspace API directly. This keeps the unit tests fully deterministic
 * and lets the caller wire any backing store at construction time.
 */

import type { Database } from "../db/database";
import type { LLMProvider, ChatMessage as ProviderChatMessage } from "../llm/provider";
import type { ConversationIndex } from "./conversationIndex";
import { SUMMARY_JSON_SCHEMA, summarizePrompt } from "./prompts/summarize";
import { NOTIENT_IDENTITY, composeSystemPrompt } from "./prompts/system";
import type { ChatMessage, Conversation } from "./types";

export interface ContextSettingsView {
  includeUserProfile: boolean;
  includeVaultSnapshot: boolean;
  includeWorkspaceState: boolean;
  includeCrossSessionMemory: boolean;
  crossSessionTopK: number;
  crossSessionSimThreshold: number;
  pinnedNoteMaxTokens: number;
  contextBudgetFraction: number;
  modelContextTokens: number;
}

export interface WorkspaceStateView {
  getActiveNotePath(): string | null;
  getOpenNotePaths(): string[];
  getRecentNotePaths(): string[];
  getRecentSearchQueries(): string[];
}

export interface ContextNotesFacade {
  readNote(path: string): Promise<string>;
}

export interface ContextManagerOptions {
  database: Database;
  provider: LLMProvider;
  conversationIndex: ConversationIndex;
  embed: (text: string, signal: AbortSignal) => Promise<Float32Array | null>;
  contextSettings: () => ContextSettingsView;
  workspace: WorkspaceStateView;
  facade: ContextNotesFacade;
  voiceProfile: () => string;
  approvalMode: () => "safe" | "yolo";
  toolCatalog: () => { name: string; description: string }[];
  estimateTokens: (text: string) => number;
  summaryModel: string;
  identity?: string;
}

export interface ComposedContext {
  systemPrompt: string;
  messages: ProviderChatMessage[];
  summarized: boolean;
}

export class ContextManager {
  constructor(private readonly options: ContextManagerOptions) {}

  async compose(
    conversation: Conversation,
    latestUserMessage: ChatMessage,
    signal: AbortSignal,
  ): Promise<ComposedContext> {
    const settings = this.options.contextSettings();
    const userProfile = settings.includeUserProfile ? this.options.voiceProfile() : "";
    const vaultSnapshot = settings.includeVaultSnapshot ? this.buildVaultSnapshot() : "";
    const workspaceState = settings.includeWorkspaceState ? this.buildWorkspaceState() : "";
    const pinnedContext = await this.buildPinnedContext(conversation, settings.pinnedNoteMaxTokens);
    const crossSessionMemory = settings.includeCrossSessionMemory
      ? await this.buildCrossSessionMemory(
          latestUserMessage.content,
          conversation.id,
          settings.crossSessionTopK,
          settings.crossSessionSimThreshold,
          signal,
        )
      : "";
    const systemPrompt = composeSystemPrompt({
      identity: this.options.identity ?? NOTIENT_IDENTITY,
      userProfile,
      vaultSnapshot,
      workspaceState,
      pinnedContext,
      crossSessionMemory,
      approvalMode: this.options.approvalMode(),
      tools: this.options.toolCatalog(),
    });
    const fullHistory = [...conversation.messages, latestUserMessage];
    const budgeted = await this.budgetedHistory(systemPrompt, fullHistory, signal);
    const messages: ProviderChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...budgeted.history.map((message) => toProviderMessage(message)),
    ];
    return { systemPrompt, messages, summarized: budgeted.summarized };
  }

  private buildVaultSnapshot(): string {
    const noteCount = readCountSafe(this.options.database, "SELECT COUNT(*) AS count FROM notes;");
    const approvedEdges = readCountSafe(
      this.options.database,
      "SELECT COUNT(*) AS count FROM graph_edges WHERE approved = 1;",
    );
    const pendingEdges = readCountSafe(
      this.options.database,
      "SELECT COUNT(*) AS count FROM staging_edges WHERE decision IS NULL;",
    );
    const pendingNodes = readCountSafe(
      this.options.database,
      "SELECT COUNT(*) AS count FROM staging_nodes WHERE decision IS NULL;",
    );
    const pending = pendingEdges + pendingNodes;
    return `${noteCount} notes. ${approvedEdges} approved edges. ${pending} pending proposals.`;
  }

  private buildWorkspaceState(): string {
    const lines: string[] = [];
    const active = this.options.workspace.getActiveNotePath();
    if (active) lines.push(`Active note: [[${active}]]`);
    const open = this.options.workspace.getOpenNotePaths().filter((path) => path !== active);
    if (open.length > 0) {
      lines.push(`Open notes: ${open.map((path) => `[[${path}]]`).join(", ")}`);
    }
    const recent = this.options.workspace.getRecentNotePaths().slice(0, 5);
    if (recent.length > 0) {
      lines.push(`Recently viewed: ${recent.map((path) => `[[${path}]]`).join(", ")}`);
    }
    const queries = this.options.workspace.getRecentSearchQueries().slice(0, 5);
    if (queries.length > 0) {
      lines.push(`Recent searches: ${queries.map((query) => `"${query}"`).join(", ")}`);
    }
    return lines.join("\n");
  }

  private async buildPinnedContext(conversation: Conversation, maxTokens: number): Promise<string> {
    if (conversation.pinnedContext.length === 0) return "";
    const blocks: string[] = [];
    for (const path of conversation.pinnedContext) {
      try {
        const body = await this.options.facade.readNote(path);
        blocks.push(`## [[${path}]]\n${this.elide(body, maxTokens)}`);
      } catch {
        // Pinned note moved or deleted; skip rather than blowing up the turn.
      }
    }
    return blocks.join("\n\n");
  }

  private elide(text: string, maxTokens: number): string {
    const estimated = this.options.estimateTokens(text);
    if (estimated <= maxTokens) return text;
    const ratio = maxTokens / Math.max(estimated, 1);
    const characters = Math.max(400, Math.floor(text.length * ratio));
    const headLength = Math.floor(characters * 0.7);
    const tailLength = Math.floor(characters * 0.3);
    const head = text.slice(0, headLength);
    const tail = text.slice(text.length - tailLength);
    const elidedTokens = Math.max(0, estimated - maxTokens);
    return `${head}\n[...${elidedTokens} tokens elided...]\n${tail}`;
  }

  private async buildCrossSessionMemory(
    query: string,
    currentConversationId: string,
    topK: number,
    threshold: number,
    signal: AbortSignal,
  ): Promise<string> {
    if (query.trim().length === 0) return "";
    let embedding: Float32Array | null;
    try {
      embedding = await this.options.embed(query, signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      return "";
    }
    if (!embedding) return "";
    const matches = this.options.conversationIndex
      .search(embedding, { k: topK + 1, threshold })
      .filter((scored) => scored.entry.id !== currentConversationId)
      .slice(0, topK);
    if (matches.length === 0) return "";
    return matches
      .map(
        (scored) =>
          `- "${scored.entry.topic}" (similarity ${scored.similarity.toFixed(2)}) — see [[${scored.entry.path}]]`,
      )
      .join("\n");
  }

  private async budgetedHistory(
    systemPrompt: string,
    history: ChatMessage[],
    signal: AbortSignal,
  ): Promise<{ history: ChatMessage[]; summarized: boolean }> {
    const settings = this.options.contextSettings();
    const budget = Math.floor(settings.modelContextTokens * settings.contextBudgetFraction);
    let used = this.options.estimateTokens(systemPrompt);
    for (const message of history) {
      used += this.options.estimateTokens(message.content);
    }
    if (used <= budget || history.length <= 4) {
      return { history, summarized: false };
    }
    const cutoff = Math.max(1, Math.floor(history.length / 2));
    const oldest = history.slice(0, cutoff);
    const newest = history.slice(cutoff);
    let summary = "(summary unavailable)";
    try {
      const result = await this.options.provider.chatJson<{ summary: string }>(
        summarizePrompt(oldest),
        { model: this.options.summaryModel, signal },
        SUMMARY_JSON_SCHEMA,
      );
      if (typeof result.summary === "string" && result.summary.length > 0) {
        summary = result.summary;
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      // Network or parse failure during summarization is non-fatal: fall back
      // to the placeholder so the turn still proceeds with a smaller history.
    }
    const summaryMessage: ChatMessage = {
      id: "summary",
      role: "system",
      content: `Earlier in this conversation: ${summary}`,
      createdAt: Date.now(),
    };
    return { history: [summaryMessage, ...newest], summarized: true };
  }
}

function toProviderMessage(message: ChatMessage): ProviderChatMessage {
  if (message.role === "tool") {
    return { role: "user", content: `Tool result: ${message.content}` };
  }
  return { role: message.role, content: message.content };
}

function readCountSafe(database: Database, sql: string): number {
  try {
    const rows = database.query<{ count: number }>(sql);
    const first = rows[0];
    if (!first) return 0;
    const value = first.count;
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  if (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  ) {
    return true;
  }
  return false;
}
