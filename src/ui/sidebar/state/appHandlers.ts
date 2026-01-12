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
import type { ChatService, ChatStatistics } from "../../../core/chat";
import type { NoteVitals } from "../../../services/noteVitalsCalculator";
import { debugError, debugLog } from "../../../utils/debugLog";
import type { RichChatMessage } from "../components/chat";
import { createActivityItem } from "../components/chat";
import {
  activeView,
  chatActivities,
  chatContext,
  chatMessages,
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
 */
export function triggerAgenticAction(
  { taskQueue, noteVitals }: TriggerAgenticActionDeps,
  prompt: string,
  agentType: AgenticTaskType,
): void {
  // Always log to console for debugging - helps identify first-click issues
  console.log("[triggerAgenticAction]", {
    agentType,
    hasTaskQueue: !!taskQueue,
    hasNoteVitals: !!noteVitals.value,
    notePath: noteVitals.value?.path,
    isIndexing: indexStatus.value.isIndexing,
  });

  debugLog("triggerAgenticAction", "called", {
    agentType,
    hasTaskQueue: !!taskQueue,
    hasNoteVitals: !!noteVitals.value,
    isIndexing: indexStatus.value.isIndexing,
  });

  // Guard: Don't allow agent actions while indexing to prevent GPU contention
  if (indexStatus.value.isIndexing) {
    console.warn("[triggerAgenticAction] Blocked: indexing in progress");
    new Notice("Please wait for indexing to complete before running agents");
    return;
  }

  if (taskQueue && noteVitals.value) {
    try {
      console.log("[triggerAgenticAction] Enqueueing task for", noteVitals.value.path);
      taskQueue.enqueue({
        agent: "chat",
        taskType: agentType, // taskQueue field name preserved for compatibility
        notePath: noteVitals.value.path,
        noteTitle: noteVitals.value.title,
        chatHistory: [{ role: "user", content: prompt }],
      });

      activeView.value = "agents";
      new Notice(`${ACTION_LABELS[agentType]} started`);
    } catch (err) {
      console.error("[triggerAgenticAction] Enqueue failed:", err);
      new Notice(err instanceof Error ? err.message : "Failed to start agent");
    }
  } else {
    console.warn("[triggerAgenticAction] Services unavailable", {
      hasTaskQueue: !!taskQueue,
      hasNoteVitals: !!noteVitals.value,
    });
    debugError("triggerAgenticAction", "services unavailable", {
      hasTaskQueue: !!taskQueue,
      hasNoteVitals: !!noteVitals.value,
    });
    new Notice("Agent system not available");
  }
}

interface HandleRichChatDeps {
  chatService: ChatService | null;
  noteVitals: Signal<NoteVitals | null>;
  obsidian: ObsidianFacade;
}

/**
 * Handle sending a chat message with streaming support.
 */
export async function handleRichChatSend(
  { chatService, noteVitals, obsidian }: HandleRichChatDeps,
  message: string,
): Promise<void> {
  if (!chatService || !chatContext.value.notePath) {
    const errorMsg: RichChatMessage = {
      id: `error-${Date.now()}`,
      role: "assistant",
      content: "Chat service is not available. Please wait for initialization.",
      timestamp: new Date(),
    };
    chatMessages.value = [...chatMessages.value, errorMsg];
    return;
  }

  // Add user message immediately
  const userMsg: RichChatMessage = {
    id: `user-${Date.now()}`,
    role: "user",
    content: message,
    timestamp: new Date(),
  };
  chatMessages.value = [...chatMessages.value, userMsg];

  // Clear previous streaming state
  isChatStreaming.value = true;
  chatStreamingContent.value = "";
  chatStreamingThinking.value = "";
  isChatThinking.value = false;
  chatActivities.value = [];

  // Build note context
  let noteContext = null;
  if (noteVitals.value) {
    const content = (await obsidian.readFileByPath(noteVitals.value.path)) || "";
    noteContext = {
      title: noteVitals.value.title,
      path: noteVitals.value.path,
      content,
      wordCount: content.split(/\s+/).filter(Boolean).length,
    };
  }

  // Build chat history for context
  const history = chatMessages.value
    .filter((m) => m.role !== "assistant" || !m.id.startsWith("error-"))
    .slice(-10)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  let fullContent = "";
  let fullThinking = "";
  let statistics: ChatStatistics | null = null;

  try {
    for await (const event of chatService.chat(message, noteContext, history)) {
      switch (event.type) {
        case "started":
          chatActivities.value = [createActivityItem("Starting...", "context")];
          break;

        case "activity":
          chatActivities.value = [
            ...chatActivities.value,
            createActivityItem(event.message, event.phase),
          ];
          break;

        case "thinking":
          isChatThinking.value = true;
          fullThinking += event.content;
          chatStreamingThinking.value = fullThinking;
          break;

        case "thinking-complete":
          isChatThinking.value = false;
          fullThinking = event.content;
          chatStreamingThinking.value = fullThinking;
          break;

        case "chunk":
          fullContent += event.content;
          chatStreamingContent.value = fullContent;
          break;

        case "complete":
          fullContent = event.content;
          fullThinking = event.thinking || "";
          statistics = event.statistics;
          break;

        case "error":
          throw event.error;
      }
    }

    // Add assistant message with full content
    const assistantMsg: RichChatMessage = {
      id: `assistant-${Date.now()}`,
      role: "assistant",
      content: fullContent,
      timestamp: new Date(),
      thinking: fullThinking || null,
      thinkingDurationMs: statistics?.thinkingTimeMs,
      statistics: statistics || undefined,
    };
    chatMessages.value = [...chatMessages.value, assistantMsg];
  } catch (error) {
    const errorMsg: RichChatMessage = {
      id: `error-${Date.now()}`,
      role: "assistant",
      content: `Sorry, something went wrong: ${error instanceof Error ? error.message : "Unknown error"}`,
      timestamp: new Date(),
    };
    chatMessages.value = [...chatMessages.value, errorMsg];
  } finally {
    isChatStreaming.value = false;
    chatStreamingContent.value = "";
    chatStreamingThinking.value = "";
    isChatThinking.value = false;
    chatActivities.value = [...chatActivities.value, createActivityItem("Complete", "complete")];
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
  return {
    id: `action-${Date.now()}`,
    type,
    target,
    title,
    risk,
    reason,
    requiresWriteLock: true,
    payload,
  } as ProposedAction;
}

/**
 * Handle "open-note" action - opens a note in the editor.
 */
function handleOpenNote(obsidian: ObsidianFacade, payload?: Record<string, unknown>): void {
  const path = (payload as { path?: string })?.path;
  if (path) {
    obsidian.openFile(path);
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
    onSuccess: () => obsidian.openFile(notePath),
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
