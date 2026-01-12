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
  console.log("[appHandlers:triggerAgenticAction] TRACE: START");
  // Always log to console for debugging - helps identify first-click issues
  console.log("[appHandlers:triggerAgenticAction] TRACE: params", {
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
    console.warn("[appHandlers:triggerAgenticAction] TRACE: Blocked - indexing in progress");
    new Notice("Please wait for indexing to complete before running agents");
    console.log("[appHandlers:triggerAgenticAction] TRACE: END (blocked by indexing)");
    return;
  }

  if (taskQueue && noteVitals.value) {
    try {
      console.log(
        "[appHandlers:triggerAgenticAction] TRACE: Enqueueing task for",
        noteVitals.value.path,
      );
      taskQueue.enqueue({
        agent: "chat",
        taskType: agentType, // taskQueue field name preserved for compatibility
        notePath: noteVitals.value.path,
        noteTitle: noteVitals.value.title,
        chatHistory: [{ role: "user", content: prompt }],
      });

      console.log("[appHandlers:triggerAgenticAction] TRACE: Before queueMicrotask for activeView");
      queueMicrotask(() => {
        console.log("[appHandlers:triggerAgenticAction] TRACE: In microtask");
        console.log("[appHandlers:triggerAgenticAction] TRACE: Before activeView.value assignment");
        activeView.value = "agents";
        console.log("[appHandlers:triggerAgenticAction] TRACE: After activeView.value assignment");
      });
      new Notice(`${ACTION_LABELS[agentType]} started`);
      console.log("[appHandlers:triggerAgenticAction] TRACE: END (success)");
    } catch (err) {
      console.error("[appHandlers:triggerAgenticAction] TRACE: Enqueue failed:", err);
      new Notice(err instanceof Error ? err.message : "Failed to start agent");
      console.log("[appHandlers:triggerAgenticAction] TRACE: END (error)");
    }
  } else {
    console.warn("[appHandlers:triggerAgenticAction] TRACE: Services unavailable", {
      hasTaskQueue: !!taskQueue,
      hasNoteVitals: !!noteVitals.value,
    });
    debugError("triggerAgenticAction", "services unavailable", {
      hasTaskQueue: !!taskQueue,
      hasNoteVitals: !!noteVitals.value,
    });
    new Notice("Agent system not available");
    console.log("[appHandlers:triggerAgenticAction] TRACE: END (services unavailable)");
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
  console.log("[appHandlers:handleRichChatSend] TRACE: START");
  if (!chatService || !chatContext.value.notePath) {
    console.log("[appHandlers:handleRichChatSend] TRACE: No chat service or context");
    const errorMsg: RichChatMessage = {
      id: `error-${Date.now()}`,
      role: "assistant",
      content: "Chat service is not available. Please wait for initialization.",
      timestamp: new Date(),
    };
    console.log(
      "[appHandlers:handleRichChatSend] TRACE: Before chatMessages.value assignment (error)",
    );
    chatMessages.value = [...chatMessages.value, errorMsg];
    console.log(
      "[appHandlers:handleRichChatSend] TRACE: After chatMessages.value assignment (error)",
    );
    console.log("[appHandlers:handleRichChatSend] TRACE: END (no service)");
    return;
  }

  // Add user message immediately
  console.log("[appHandlers:handleRichChatSend] TRACE: Adding user message");
  const userMsg: RichChatMessage = {
    id: `user-${Date.now()}`,
    role: "user",
    content: message,
    timestamp: new Date(),
  };
  console.log(
    "[appHandlers:handleRichChatSend] TRACE: Before chatMessages.value assignment (user)",
  );
  chatMessages.value = [...chatMessages.value, userMsg];
  console.log("[appHandlers:handleRichChatSend] TRACE: After chatMessages.value assignment (user)");

  // Clear previous streaming state
  console.log("[appHandlers:handleRichChatSend] TRACE: Clearing streaming state");
  console.log("[appHandlers:handleRichChatSend] TRACE: Before isChatStreaming.value assignment");
  isChatStreaming.value = true;
  console.log("[appHandlers:handleRichChatSend] TRACE: After isChatStreaming.value assignment");
  console.log(
    "[appHandlers:handleRichChatSend] TRACE: Before chatStreamingContent.value assignment",
  );
  chatStreamingContent.value = "";
  console.log(
    "[appHandlers:handleRichChatSend] TRACE: After chatStreamingContent.value assignment",
  );
  console.log(
    "[appHandlers:handleRichChatSend] TRACE: Before chatStreamingThinking.value assignment",
  );
  chatStreamingThinking.value = "";
  console.log(
    "[appHandlers:handleRichChatSend] TRACE: After chatStreamingThinking.value assignment",
  );
  console.log("[appHandlers:handleRichChatSend] TRACE: Before isChatThinking.value assignment");
  isChatThinking.value = false;
  console.log("[appHandlers:handleRichChatSend] TRACE: After isChatThinking.value assignment");
  console.log("[appHandlers:handleRichChatSend] TRACE: Before chatActivities.value assignment");
  chatActivities.value = [];
  console.log("[appHandlers:handleRichChatSend] TRACE: After chatActivities.value assignment");

  // Build note context
  console.log("[appHandlers:handleRichChatSend] TRACE: Building note context");
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
  console.log("[appHandlers:handleRichChatSend] TRACE: Building chat history");
  const history = chatMessages.value
    .filter((m) => m.role !== "assistant" || !m.id.startsWith("error-"))
    .slice(-10)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  let fullContent = "";
  let fullThinking = "";
  let statistics: ChatStatistics | null = null;

  try {
    console.log("[appHandlers:handleRichChatSend] TRACE: Starting chat stream");
    for await (const event of chatService.chat(message, noteContext, history)) {
      console.log("[appHandlers:handleRichChatSend] TRACE: Chat event:", event.type);
      switch (event.type) {
        case "started":
          console.log(
            "[appHandlers:handleRichChatSend] TRACE: Before chatActivities.value assignment (started)",
          );
          chatActivities.value = [createActivityItem("Starting...", "context")];
          console.log(
            "[appHandlers:handleRichChatSend] TRACE: After chatActivities.value assignment (started)",
          );
          break;

        case "activity":
          console.log(
            "[appHandlers:handleRichChatSend] TRACE: Before chatActivities.value assignment (activity)",
          );
          chatActivities.value = [
            ...chatActivities.value,
            createActivityItem(event.message, event.phase),
          ];
          console.log(
            "[appHandlers:handleRichChatSend] TRACE: After chatActivities.value assignment (activity)",
          );
          break;

        case "thinking":
          console.log(
            "[appHandlers:handleRichChatSend] TRACE: Before isChatThinking.value assignment (thinking)",
          );
          isChatThinking.value = true;
          console.log(
            "[appHandlers:handleRichChatSend] TRACE: After isChatThinking.value assignment (thinking)",
          );
          fullThinking += event.content;
          console.log(
            "[appHandlers:handleRichChatSend] TRACE: Before chatStreamingThinking.value assignment (thinking)",
          );
          chatStreamingThinking.value = fullThinking;
          console.log(
            "[appHandlers:handleRichChatSend] TRACE: After chatStreamingThinking.value assignment (thinking)",
          );
          break;

        case "thinking-complete":
          console.log(
            "[appHandlers:handleRichChatSend] TRACE: Before isChatThinking.value assignment (thinking-complete)",
          );
          isChatThinking.value = false;
          console.log(
            "[appHandlers:handleRichChatSend] TRACE: After isChatThinking.value assignment (thinking-complete)",
          );
          fullThinking = event.content;
          console.log(
            "[appHandlers:handleRichChatSend] TRACE: Before chatStreamingThinking.value assignment (thinking-complete)",
          );
          chatStreamingThinking.value = fullThinking;
          console.log(
            "[appHandlers:handleRichChatSend] TRACE: After chatStreamingThinking.value assignment (thinking-complete)",
          );
          break;

        case "chunk":
          fullContent += event.content;
          console.log(
            "[appHandlers:handleRichChatSend] TRACE: Before chatStreamingContent.value assignment (chunk)",
          );
          chatStreamingContent.value = fullContent;
          console.log(
            "[appHandlers:handleRichChatSend] TRACE: After chatStreamingContent.value assignment (chunk)",
          );
          break;

        case "complete":
          console.log("[appHandlers:handleRichChatSend] TRACE: Chat complete");
          fullContent = event.content;
          fullThinking = event.thinking || "";
          statistics = event.statistics;
          break;

        case "error":
          console.log("[appHandlers:handleRichChatSend] TRACE: Chat error:", event.error);
          throw event.error;
      }
    }

    // Add assistant message with full content
    console.log("[appHandlers:handleRichChatSend] TRACE: Adding assistant message");
    const assistantMsg: RichChatMessage = {
      id: `assistant-${Date.now()}`,
      role: "assistant",
      content: fullContent,
      timestamp: new Date(),
      thinking: fullThinking || null,
      thinkingDurationMs: statistics?.thinkingTimeMs,
      statistics: statistics || undefined,
    };
    console.log(
      "[appHandlers:handleRichChatSend] TRACE: Before chatMessages.value assignment (assistant)",
    );
    chatMessages.value = [...chatMessages.value, assistantMsg];
    console.log(
      "[appHandlers:handleRichChatSend] TRACE: After chatMessages.value assignment (assistant)",
    );
  } catch (error) {
    console.log("[appHandlers:handleRichChatSend] TRACE: Caught error:", error);
    const errorMsg: RichChatMessage = {
      id: `error-${Date.now()}`,
      role: "assistant",
      content: `Sorry, something went wrong: ${error instanceof Error ? error.message : "Unknown error"}`,
      timestamp: new Date(),
    };
    console.log(
      "[appHandlers:handleRichChatSend] TRACE: Before chatMessages.value assignment (error in catch)",
    );
    chatMessages.value = [...chatMessages.value, errorMsg];
    console.log(
      "[appHandlers:handleRichChatSend] TRACE: After chatMessages.value assignment (error in catch)",
    );
  } finally {
    console.log("[appHandlers:handleRichChatSend] TRACE: In finally block");
    console.log(
      "[appHandlers:handleRichChatSend] TRACE: Before isChatStreaming.value assignment (finally)",
    );
    isChatStreaming.value = false;
    console.log(
      "[appHandlers:handleRichChatSend] TRACE: After isChatStreaming.value assignment (finally)",
    );
    console.log(
      "[appHandlers:handleRichChatSend] TRACE: Before chatStreamingContent.value assignment (finally)",
    );
    chatStreamingContent.value = "";
    console.log(
      "[appHandlers:handleRichChatSend] TRACE: After chatStreamingContent.value assignment (finally)",
    );
    console.log(
      "[appHandlers:handleRichChatSend] TRACE: Before chatStreamingThinking.value assignment (finally)",
    );
    chatStreamingThinking.value = "";
    console.log(
      "[appHandlers:handleRichChatSend] TRACE: After chatStreamingThinking.value assignment (finally)",
    );
    console.log(
      "[appHandlers:handleRichChatSend] TRACE: Before isChatThinking.value assignment (finally)",
    );
    isChatThinking.value = false;
    console.log(
      "[appHandlers:handleRichChatSend] TRACE: After isChatThinking.value assignment (finally)",
    );
    console.log(
      "[appHandlers:handleRichChatSend] TRACE: Before chatActivities.value assignment (finally)",
    );
    chatActivities.value = [...chatActivities.value, createActivityItem("Complete", "complete")];
    console.log(
      "[appHandlers:handleRichChatSend] TRACE: After chatActivities.value assignment (finally)",
    );
    console.log("[appHandlers:handleRichChatSend] TRACE: END");
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
  console.log("[appHandlers:applyActionWithNotice] TRACE: START");
  const result = await actionApplier.applyConfirmed(action);
  if (result.success) {
    console.log("[appHandlers:applyActionWithNotice] TRACE: Success");
    new Notice(successMessage);
    onSuccess?.();
  } else {
    console.log("[appHandlers:applyActionWithNotice] TRACE: Failed:", result.error);
    new Notice(`Failed: ${result.error}`);
  }
  console.log("[appHandlers:applyActionWithNotice] TRACE: END");
}

function buildAction(
  type: ProposedAction["type"],
  target: string,
  title: string,
  reason: string,
  payload: Record<string, unknown>,
  risk: RiskLevel = "low",
): ProposedAction {
  console.log("[appHandlers:buildAction] TRACE: START", type, target);
  const action = {
    id: `action-${Date.now()}`,
    type,
    target,
    title,
    risk,
    reason,
    requiresWriteLock: true,
    payload,
  } as ProposedAction;
  console.log("[appHandlers:buildAction] TRACE: END");
  return action;
}

/**
 * Handle "open-note" action - opens a note in the editor.
 */
function handleOpenNote(obsidian: ObsidianFacade, payload?: Record<string, unknown>): void {
  console.log("[appHandlers:handleOpenNote] TRACE: START");
  const path = (payload as { path?: string })?.path;
  if (path) {
    console.log("[appHandlers:handleOpenNote] TRACE: Opening file:", path);
    obsidian.openFile(path);
  } else {
    console.log("[appHandlers:handleOpenNote] TRACE: No path provided");
  }
  console.log("[appHandlers:handleOpenNote] TRACE: END");
}

/**
 * Handle "apply-links" action - adds related links to current note.
 */
async function handleApplyLinks(
  actionApplier: ActionApplier,
  currentPath: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  console.log("[appHandlers:handleApplyLinks] TRACE: START");
  const links = (payload as { links?: string[] })?.links || [];
  if (links.length === 0) {
    console.log("[appHandlers:handleApplyLinks] TRACE: No links to apply");
    new Notice("No links to apply");
    console.log("[appHandlers:handleApplyLinks] TRACE: END (no links)");
    return;
  }
  console.log("[appHandlers:handleApplyLinks] TRACE: Applying", links.length, "links");
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
  console.log("[appHandlers:handleApplyLinks] TRACE: END");
}

/**
 * Handle "apply-tags" action - adds tags to current note frontmatter.
 */
async function handleApplyTags(
  actionApplier: ActionApplier,
  currentPath: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  console.log("[appHandlers:handleApplyTags] TRACE: START");
  const tags = (payload as { tags?: string[] })?.tags || [];
  if (tags.length === 0) {
    console.log("[appHandlers:handleApplyTags] TRACE: No tags to apply");
    new Notice("No tags to apply");
    console.log("[appHandlers:handleApplyTags] TRACE: END (no tags)");
    return;
  }
  console.log("[appHandlers:handleApplyTags] TRACE: Applying", tags.length, "tags");
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
  console.log("[appHandlers:handleApplyTags] TRACE: END");
}

/**
 * Handle "create-note" action - creates a new note with content.
 */
async function handleCreateNote(
  actionApplier: ActionApplier,
  obsidian: ObsidianFacade,
  payload?: Record<string, unknown>,
): Promise<void> {
  console.log("[appHandlers:handleCreateNote] TRACE: START");
  const typedPayload = payload as { path?: string; content?: string } | undefined;
  const notePath = typedPayload?.path;
  const noteContent = typedPayload?.content;
  if (!notePath || !noteContent) {
    console.log("[appHandlers:handleCreateNote] TRACE: Missing path or content");
    new Notice("Missing path or content");
    console.log("[appHandlers:handleCreateNote] TRACE: END (missing data)");
    return;
  }
  console.log("[appHandlers:handleCreateNote] TRACE: Creating note:", notePath);
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
      console.log("[appHandlers:handleCreateNote:onSuccess] TRACE: Opening created file");
      obsidian.openFile(notePath);
    },
  });
  console.log("[appHandlers:handleCreateNote] TRACE: END");
}

/**
 * Handle inline actions from chat messages.
 */
export async function handleChatAction(
  { actionApplier, obsidian }: HandleChatActionDeps,
  action: ChatAction,
): Promise<void> {
  console.log("[appHandlers:handleChatAction] TRACE: START", action.type);
  if (action.type === "open-note") {
    handleOpenNote(obsidian, action.payload);
    console.log("[appHandlers:handleChatAction] TRACE: END (open-note)");
    return;
  }

  if (action.type === "create-note") {
    if (!actionApplier) {
      console.log("[appHandlers:handleChatAction] TRACE: No action applier for create-note");
      new Notice("Action system not available");
      console.log("[appHandlers:handleChatAction] TRACE: END (no applier)");
      return;
    }
    await handleCreateNote(actionApplier, obsidian, action.payload);
    console.log("[appHandlers:handleChatAction] TRACE: END (create-note)");
    return;
  }

  const currentPath = chatContext.value.notePath;
  if (!currentPath) {
    console.log("[appHandlers:handleChatAction] TRACE: No note context");
    new Notice("No note context for this action");
    console.log("[appHandlers:handleChatAction] TRACE: END (no context)");
    return;
  }

  if (!actionApplier) {
    console.log("[appHandlers:handleChatAction] TRACE: No action applier");
    new Notice("Action system not available");
    console.log("[appHandlers:handleChatAction] TRACE: END (no applier)");
    return;
  }

  if (action.type === "apply-links") {
    await handleApplyLinks(actionApplier, currentPath, action.payload);
  } else if (action.type === "apply-tags") {
    await handleApplyTags(actionApplier, currentPath, action.payload);
  }
  console.log("[appHandlers:handleChatAction] TRACE: END");
}
