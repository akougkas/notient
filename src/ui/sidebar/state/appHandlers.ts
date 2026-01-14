/**
 * App Handlers - Action and event handlers for the sidebar
 *
 * Extracted from App.tsx to reduce component complexity.
 * All handlers are pure functions that operate on signals and services.
 */

import type { Signal } from "@preact/signals";
import { Notice } from "obsidian";
import type { ObsidianFacade } from "../../../adapters/obsidianFacade";
import type { AgentTaskQueue } from "../../../core/agent";
import type { ActionApplier } from "../../../core/agentic";
import type { ProposedAction, RiskLevel } from "../../../core/agentic";
import type { AgentEvent } from "../../../core/agents/types";
import type { ChatService, ChatStatistics, DelegationDetection } from "../../../core/chat";
import { generateId } from "../../../core/ids";
import type { NoteVitals } from "../../../services/noteVitalsCalculator";
import { debugError, debugLog } from "../../../utils/debugLog";
import type { RichChatMessage } from "../components/chat";
import { createActivityItem } from "../components/chat";
import {
  activeView,
  chatActivities,
  chatContext,
  chatDelegation,
  chatMessages,
  chatSlashCommandTasks,
  chatStreamingContent,
  chatStreamingThinking,
  indexStatus,
  isChatStreaming,
  isChatThinking,
} from "../state";

/**
 * Agent types that can be triggered via Quick Actions.
 * Maps directly to ExpertAgentType (not UI agents like "chat").
 * "context-builder" is internal and not user-triggerable.
 */
export type AgenticTaskType = "note-editor" | "classifier" | "connection";

/**
 * Human-readable labels for all task types (new agent-based + legacy).
 * Covers both Quick Action agent types and legacy task types
 * for backwards compatibility in event handling.
 */
export const ACTION_LABELS: Record<string, string> = {
  // New agent-based types (Quick Actions use these)
  "note-editor": "Note Editor",
  classifier: "Classifier",
  connection: "Connection Agent",
  // Legacy task-based types (for backwards compat in events)
  enrich: "Note Editor",
  link: "Connection Agent",
  classify: "Classifier",
  analyze: "Context Builder",
  chat: "Chat",
  agent: "Agent",
};

interface TriggerAgenticActionDeps {
  taskQueue: AgentTaskQueue | null;
  noteVitals: Signal<NoteVitals | null>;
}

/**
 * Trigger an agent action for the current note.
 * Routes through ChiefOfStaff via taskQueue.
 *
 * @param agentType - Expert agent type to invoke (note-editor, classifier, connection)
 * @returns Task ID if successfully enqueued, undefined otherwise
 */
export function triggerAgenticAction(
  { taskQueue, noteVitals }: TriggerAgenticActionDeps,
  prompt: string,
  agentType: AgenticTaskType,
): string | undefined {
  debugLog("triggerAgenticAction", "called", {
    agentType,
    hasTaskQueue: !!taskQueue,
    hasNoteVitals: !!noteVitals.value,
    isIndexing: indexStatus.value.isIndexing,
  });

  // Guard: Don't allow agent actions while indexing to prevent GPU contention
  if (indexStatus.value.isIndexing) {
    new Notice("Please wait for indexing to complete before running agents");
    return undefined;
  }

  if (taskQueue && noteVitals.value) {
    try {
      const taskId = taskQueue.enqueue({
        agent: "chat",
        taskType: agentType, // taskQueue field name preserved for compatibility
        notePath: noteVitals.value.path,
        noteTitle: noteVitals.value.title,
        chatHistory: [{ role: "user", content: prompt }],
      });

      queueMicrotask(() => {
        activeView.value = "agents";
      });
      new Notice(`${ACTION_LABELS[agentType]} started`);
      return taskId;
    } catch (err) {
      debugError("triggerAgenticAction", "enqueue failed", err);
      new Notice(err instanceof Error ? err.message : "Failed to start agent");
      return undefined;
    }
  } else {
    debugError("triggerAgenticAction", "services unavailable", {
      hasTaskQueue: !!taskQueue,
      hasNoteVitals: !!noteVitals.value,
    });
    new Notice("Agent system not available");
    return undefined;
  }
}

interface HandleRichChatDeps {
  chatService: ChatService | null;
  noteVitals: Signal<NoteVitals | null>;
  obsidian: ObsidianFacade;
}

interface ChatStreamState {
  fullContent: string;
  fullThinking: string;
  statistics: ChatStatistics | null;
  /** Delegation mode: accumulates agent output as content */
  isDelegating: boolean;
  delegatedAgentContent: string;
}

type ActivityPhase = "context" | "thinking" | "generating" | "delegation" | "complete";

type ChatStreamEvent =
  | { type: "started" }
  | { type: "activity"; message: string; phase: ActivityPhase }
  | { type: "thinking"; content: string }
  | { type: "thinking-complete"; content: string }
  | { type: "chunk"; content: string }
  | { type: "complete"; content: string; thinking?: string; statistics: ChatStatistics }
  | { type: "error"; error: Error }
  // Phase 5: Orchestrator delegation events
  | { type: "delegation:start"; delegation: DelegationDetection }
  | { type: "delegation:event"; event: AgentEvent }
  | { type: "delegation:complete" };

/**
 * Process agent events into chat-friendly content.
 * Extracts meaningful output from different AgentEvent types.
 */
function processAgentEvent(event: AgentEvent, state: ChatStreamState): ChatStreamState {
  switch (event.type) {
    case "started":
      chatActivities.value = [
        ...chatActivities.value,
        createActivityItem(`${event.agentType} started`, "delegation"),
      ];
      return state;

    case "progress":
      chatDelegation.value = chatDelegation.value
        ? { ...chatDelegation.value, progress: Math.round(event.progress * 100) }
        : null;
      chatActivities.value = [
        ...chatActivities.value,
        createActivityItem(
          `${event.agentType}: ${Math.round(event.progress * 100)}%`,
          "delegation",
        ),
      ];
      return state;

    case "chunk":
      // Stream agent chunks to content
      state.delegatedAgentContent += event.content;
      chatStreamingContent.value = state.delegatedAgentContent;
      return state;

    case "complete":
      // Extract content from agent output
      if (event.output.kind === "conversational") {
        state.delegatedAgentContent = event.output.content;
      } else if (event.output.kind === "structured") {
        // Format structured output as readable text
        const data = event.output.data as Record<string, unknown>;
        state.delegatedAgentContent = formatStructuredOutput(event.agentType, data);
      }
      chatStreamingContent.value = state.delegatedAgentContent;
      return state;

    case "error":
      state.delegatedAgentContent = `Error from ${event.agentType}: ${event.error.message}`;
      chatStreamingContent.value = state.delegatedAgentContent;
      return state;

    case "citations":
      // Append citations as context
      if (event.paths.length > 0) {
        const citationText = `\n\n**Related notes:** ${event.paths.map((p) => `[[${p.split("/").pop()?.replace(".md", "")}]]`).join(", ")}`;
        state.delegatedAgentContent += citationText;
        chatStreamingContent.value = state.delegatedAgentContent;
      }
      return state;

    default:
      return state;
  }
}

/**
 * Format structured agent output as readable text for chat.
 */
function formatStructuredOutput(agentType: string, data: Record<string, unknown>): string {
  // Classification output
  if (data.paraCategory) {
    const conf = data.confidence as number;
    const tags = (data.suggestedTags as string[]) || [];
    return `**Classification Result**\n\n- **Category:** ${data.paraCategory}\n- **Confidence:** ${Math.round(conf * 100)}%\n- **Suggested tags:** ${tags.join(", ") || "none"}\n${data.suggestedFolder ? `- **Suggested folder:** ${data.suggestedFolder}\n` : ""}\n**Reasoning:** ${data.reasoning}`;
  }

  // Link suggestions output
  if (data.links && Array.isArray(data.links)) {
    const links = data.links as Array<{
      targetTitle: string;
      reason: string;
      relevanceScore: number;
    }>;
    if (links.length === 0) return "No related notes found.";
    return `**Related Notes Found**\n\n${links
      .map(
        (l, i) =>
          `${i + 1}. **[[${l.targetTitle}]]** (${Math.round(l.relevanceScore * 100)}%)\n   ${l.reason}`,
      )
      .join("\n\n")}`;
  }

  // Note edit actions
  if (data.actions && Array.isArray(data.actions)) {
    const actions = data.actions as Array<{ title: string; reason: string }>;
    if (actions.length === 0) return "No changes suggested.";
    return `**Suggested Changes**\n\n${actions.map((a, i) => `${i + 1}. **${a.title}**\n   ${a.reason}`).join("\n\n")}`;
  }

  // Fallback: JSON
  return `**${agentType} Result**\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
}

function processChatEvent(event: ChatStreamEvent, state: ChatStreamState): ChatStreamState {
  switch (event.type) {
    case "started":
      chatActivities.value = [createActivityItem("Starting...", "context")];
      return state;

    case "activity":
      chatActivities.value = [
        ...chatActivities.value,
        createActivityItem(event.message, event.phase),
      ];
      return state;

    case "thinking":
      if (!isChatThinking.value) isChatThinking.value = true;
      state.fullThinking += event.content;
      chatStreamingThinking.value = state.fullThinking;
      return state;

    case "thinking-complete":
      isChatThinking.value = false;
      state.fullThinking = event.content;
      chatStreamingThinking.value = state.fullThinking;
      return state;

    case "chunk":
      state.fullContent += event.content;
      chatStreamingContent.value = state.fullContent;
      return state;

    case "complete":
      state.fullContent = event.content;
      state.fullThinking = event.thinking || "";
      state.statistics = event.statistics;
      return state;

    case "error":
      throw event.error;

    // Phase 5: Delegation events
    case "delegation:start":
      state.isDelegating = true;
      state.delegatedAgentContent = "";
      chatDelegation.value = {
        active: true,
        agent: event.delegation.targetAgent,
        workflow: event.delegation.workflow,
        progress: undefined,
      };
      chatActivities.value = [
        ...chatActivities.value,
        createActivityItem(
          `Delegating to ${event.delegation.targetAgent || "agent"}...`,
          "delegation",
        ),
      ];
      return state;

    case "delegation:event":
      return processAgentEvent(event.event, state);

    case "delegation:complete":
      state.isDelegating = false;
      chatDelegation.value = null;
      // Copy delegated content to fullContent for final message
      if (state.delegatedAgentContent) {
        state.fullContent = state.delegatedAgentContent;
      }
      return state;
  }
}

function resetChatStreamState(): void {
  isChatStreaming.value = false;
  chatStreamingContent.value = "";
  chatStreamingThinking.value = "";
  isChatThinking.value = false;
  chatDelegation.value = null;
  chatActivities.value = [...chatActivities.value, createActivityItem("Complete", "complete")];
}

/**
 * Handle sending a chat message with streaming support.
 */
export async function handleRichChatSend(
  { chatService, noteVitals, obsidian }: HandleRichChatDeps,
  message: string,
): Promise<void> {
  if (!chatService || !chatContext.value.notePath) {
    chatMessages.value = [
      ...chatMessages.value,
      {
        id: generateId("msg"),
        role: "assistant",
        content: "Chat service is not available. Please wait for initialization.",
        timestamp: new Date(),
      },
    ];
    return;
  }

  // Add user message immediately
  chatMessages.value = [
    ...chatMessages.value,
    {
      id: generateId("msg"),
      role: "user",
      content: message,
      timestamp: new Date(),
    },
  ];

  // Initialize streaming state
  isChatStreaming.value = true;
  chatStreamingContent.value = "";
  chatStreamingThinking.value = "";
  isChatThinking.value = false;
  chatActivities.value = [];

  // Build note context
  const noteContext = noteVitals.value
    ? {
        title: noteVitals.value.title,
        path: noteVitals.value.path,
        content: (await obsidian.readFileByPath(noteVitals.value.path)) || "",
        wordCount: 0,
      }
    : null;
  if (noteContext) noteContext.wordCount = noteContext.content.split(/\s+/).filter(Boolean).length;

  // Build chat history
  const history = chatMessages.value
    .filter((m) => m.role !== "assistant" || !m.id.startsWith("error-"))
    .slice(-10)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  const state: ChatStreamState = {
    fullContent: "",
    fullThinking: "",
    statistics: null,
    isDelegating: false,
    delegatedAgentContent: "",
  };

  try {
    for await (const event of chatService.chat(message, noteContext, history)) {
      processChatEvent(event as ChatStreamEvent, state);
    }
    chatMessages.value = [
      ...chatMessages.value,
      {
        id: generateId("msg"),
        role: "assistant",
        content: state.fullContent,
        timestamp: new Date(),
        thinking: state.fullThinking || null,
        thinkingDurationMs: state.statistics?.thinkingTimeMs,
        statistics: state.statistics || undefined,
      },
    ];
  } catch (error) {
    chatMessages.value = [
      ...chatMessages.value,
      {
        id: generateId("msg"),
        role: "assistant",
        content: `Sorry, something went wrong: ${error instanceof Error ? error.message : "Unknown error"}`,
        timestamp: new Date(),
      },
    ];
  } finally {
    resetChatStreamState();
  }
}

interface HandleChatActionDeps {
  actionApplier: ActionApplier | null;
  obsidian: ObsidianFacade;
}

export type ChatActionType = "open-note" | "apply-links" | "apply-tags" | "create-note";

export interface ChatAction {
  type: ChatActionType;
  payload?: Record<string, unknown>;
}

interface ApplyActionOptions {
  actionApplier: ActionApplier;
  action: ProposedAction;
  successMessage: string;
  onSuccess?: () => void;
}

/**
 * Helper to apply an action and show appropriate notices.
 */
async function applyActionWithNotice({
  actionApplier,
  action,
  successMessage,
  onSuccess,
}: ApplyActionOptions): Promise<void> {
  const result = await actionApplier.applyConfirmed(action);
  if (result.success) {
    new Notice(successMessage);
    onSuccess?.();
  } else {
    new Notice(`Failed: ${result.error}`);
  }
}

function buildAction(
  type: ProposedAction["type"],
  target: string,
  title: string,
  reason: string,
  payload: Record<string, unknown>,
  risk: RiskLevel = "low",
): ProposedAction {
  const action = {
    id: generateId("act"),
    type,
    target,
    title,
    risk,
    reason,
    requiresWriteLock: true,
    payload,
  } as ProposedAction;
  return action;
}

/**
 * Handle "open-note" action - opens a note in the editor.
 */
function handleOpenNote(obsidian: ObsidianFacade, payload?: Record<string, unknown>): void {
  const path = (payload as { path?: string })?.path;
  if (path) {
    obsidian.openFile(path);
  } else {
  }
}

/**
 * Handle "apply-links" action - adds related links to current note.
 */
async function handleApplyLinks(
  actionApplier: ActionApplier,
  currentPath: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  const links = (payload as { links?: string[] })?.links || [];
  if (links.length === 0) {
    new Notice("No links to apply");
    return;
  }
  await applyActionWithNotice({
    actionApplier,
    action: buildAction(
      "append_related_links",
      currentPath,
      `Add ${links.length} related links`,
      "User applied links from chat",
      { links },
    ),
    successMessage: `Added ${links.length} links`,
  });
}

/**
 * Handle "apply-tags" action - adds tags to current note frontmatter.
 */
async function handleApplyTags(
  actionApplier: ActionApplier,
  currentPath: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  const tags = (payload as { tags?: string[] })?.tags || [];
  if (tags.length === 0) {
    new Notice("No tags to apply");
    return;
  }
  await applyActionWithNotice({
    actionApplier,
    action: buildAction(
      "frontmatter_add_tags",
      currentPath,
      `Add ${tags.length} tags`,
      "User applied tags from chat",
      { tags },
    ),
    successMessage: `Added ${tags.length} tags`,
  });
}

/**
 * Handle "create-note" action - creates a new note with content.
 */
async function handleCreateNote(
  actionApplier: ActionApplier,
  obsidian: ObsidianFacade,
  payload?: Record<string, unknown>,
): Promise<void> {
  const typedPayload = payload as { path?: string; content?: string } | undefined;
  const notePath = typedPayload?.path;
  const noteContent = typedPayload?.content;
  if (!notePath || !noteContent) {
    new Notice("Missing path or content");
    return;
  }
  await applyActionWithNotice({
    actionApplier,
    action: buildAction(
      "create_note",
      notePath,
      `Create ${notePath.split("/").pop()}`,
      "User created note from chat",
      { path: notePath, content: noteContent },
    ),
    successMessage: `Created ${notePath}`,
    onSuccess: () => {
      obsidian.openFile(notePath);
    },
  });
}

/**
 * Handle inline actions from chat messages.
 */
export async function handleChatAction(
  { actionApplier, obsidian }: HandleChatActionDeps,
  action: ChatAction,
): Promise<void> {
  if (action.type === "open-note") {
    handleOpenNote(obsidian, action.payload);
    return;
  }

  if (action.type === "create-note") {
    if (!actionApplier) {
      new Notice("Action system not available");
      return;
    }
    await handleCreateNote(actionApplier, obsidian, action.payload);
    return;
  }

  const currentPath = chatContext.value.notePath;
  if (!currentPath) {
    new Notice("No note context for this action");
    return;
  }

  if (!actionApplier) {
    new Notice("Action system not available");
    return;
  }

  if (action.type === "apply-links") {
    await handleApplyLinks(actionApplier, currentPath, action.payload);
  } else if (action.type === "apply-tags") {
    await handleApplyTags(actionApplier, currentPath, action.payload);
  }
}

// ============================================================================
// Chat Slash Commands
// ============================================================================

/**
 * Chat slash command definitions.
 * Maps slash commands to agent types.
 */
const CHAT_SLASH_COMMANDS: Record<
  string,
  { agentType: AgenticTaskType; label: string; prompt: string }
> = {
  "/enrich": {
    agentType: "note-editor",
    label: "Note Editor",
    prompt: "Analyze and enrich this note with improvements, structure, and depth.",
  },
  "/classify": {
    agentType: "classifier",
    label: "Classifier",
    prompt: "Classify this note and suggest appropriate tags and categories.",
  },
  "/link": {
    agentType: "connection",
    label: "Connection Agent",
    prompt: "Find related notes and suggest connections for this note.",
  },
  "/connect": {
    agentType: "connection",
    label: "Connection Agent",
    prompt: "Find related notes and suggest connections for this note.",
  },
};

/**
 * Result of parsing a chat slash command.
 */
export interface ChatSlashCommandResult {
  isSlashCommand: boolean;
  agentType?: AgenticTaskType;
  label?: string;
  prompt?: string;
  command?: string;
}

/**
 * Parse a message to check if it's a chat slash command.
 * Returns the agent type and prompt if it's a valid command.
 */
export function parseChatSlashCommand(message: string): ChatSlashCommandResult {
  const trimmed = message.trim().toLowerCase();

  for (const [command, config] of Object.entries(CHAT_SLASH_COMMANDS)) {
    if (trimmed === command || trimmed.startsWith(`${command} `)) {
      return {
        isSlashCommand: true,
        agentType: config.agentType,
        label: config.label,
        prompt: config.prompt,
        command: command.slice(1), // Remove leading /
      };
    }
  }

  return { isSlashCommand: false };
}

/**
 * Handle a chat slash command by triggering the appropriate agent.
 * Adds a user message to chat and triggers the agent.
 * Returns true if the command was handled, false otherwise.
 *
 * Results are mirrored to both InsightStream and Chat UI via chatSlashCommandTasks tracking.
 */
export function handleChatSlashCommand(deps: TriggerAgenticActionDeps, message: string): boolean {
  const parsed = parseChatSlashCommand(message);

  if (!parsed.isSlashCommand || !parsed.agentType || !parsed.prompt) {
    return false;
  }

  // Add user message showing the command
  chatMessages.value = [
    ...chatMessages.value,
    {
      id: generateId("msg"),
      role: "user",
      content: message,
      timestamp: new Date(),
    },
  ];

  // Add placeholder assistant message (will be updated with results)
  const assistantMsgId = generateId("msg");
  chatMessages.value = [
    ...chatMessages.value,
    {
      id: assistantMsgId,
      role: "assistant",
      content: `Running ${parsed.label}...`,
      timestamp: new Date(),
    },
  ];

  // Trigger the agent and track for result mirroring
  const taskId = triggerAgenticAction(deps, parsed.prompt, parsed.agentType);

  if (taskId) {
    // Track mapping so we can update the placeholder when task completes
    chatSlashCommandTasks.value = new Map([
      ...chatSlashCommandTasks.value,
      [taskId, assistantMsgId],
    ]);
  }

  return true;
}
