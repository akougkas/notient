/**
 * App Handlers - Action and event handlers for the sidebar
 *
 * Extracted from App.tsx to reduce component complexity.
 * All handlers are pure functions that operate on signals and services.
 */

import { Notice } from "obsidian";
import type { Signal } from "@preact/signals";
import type { AgentTaskQueue } from "../../../core/agent";
import type { ActionApplier } from "../../../core/agentic";
import type { ChatService, ChatStatistics } from "../../../core/chat";
import type { NoteVitals } from "../../../services/noteVitalsCalculator";
import type { ObsidianFacade } from "../../../adapters/obsidianFacade";
import type { RichChatMessage } from "../components/chat";
import { createActivityItem } from "../components/chat";
import { debugError, debugLog } from "../../../utils/debugLog";
import {
  activeView,
  chatActivities,
  chatContext,
  chatMessages,
  chatStreamingContent,
  chatStreamingThinking,
  isChatStreaming,
  isChatThinking,
} from "../state";

export type AgenticTaskType = "link" | "enrich" | "classify" | "analyze";

/** Human-readable labels for agent task types */
export const ACTION_LABELS: Record<string, string> = {
  link: "Link Finder",
  enrich: "Note Editor",
  classify: "Classifier",
  analyze: "Context Builder",
};

interface TriggerAgenticActionDeps {
  taskQueue: AgentTaskQueue | null;
  noteVitals: Signal<NoteVitals | null>;
}

/**
 * Trigger an agentic action (link, enrich, classify, analyze) for the current note.
 * Routes through ChiefOfStaff via taskQueue.
 */
export function triggerAgenticAction(
  { taskQueue, noteVitals }: TriggerAgenticActionDeps,
  prompt: string,
  taskType: AgenticTaskType,
): void {
  debugLog("triggerAgenticAction", "called", {
    taskType,
    hasTaskQueue: !!taskQueue,
    hasNoteVitals: !!noteVitals.value,
  });

  if (taskQueue && noteVitals.value) {
    try {
      taskQueue.enqueue({
        agent: "chat",
        taskType,
        notePath: noteVitals.value.path,
        noteTitle: noteVitals.value.title,
        chatHistory: [{ role: "user", content: prompt }],
      });

      activeView.value = "agents";
      new Notice(`${ACTION_LABELS[taskType]} started`);
    } catch (err) {
      new Notice(err instanceof Error ? err.message : "Failed to start agent");
    }
  } else {
    debugError("triggerAgenticAction", "services unavailable", {
      hasTaskQueue: !!taskQueue,
      hasNoteVitals: !!noteVitals.value,
    });
    new Notice("Agent system not available");
  }
}

interface PrefillChatDeps {
  taskQueue: AgentTaskQueue | null;
  noteVitals: Signal<NoteVitals | null>;
}

/**
 * Send a message to the chat tab and switch to it.
 */
export function prefillChatAndSwitch(
  { taskQueue, noteVitals }: PrefillChatDeps,
  prompt: string,
): void {
  if (taskQueue && noteVitals.value) {
    try {
      taskQueue.enqueue({
        agent: "chat",
        notePath: noteVitals.value.path,
        noteTitle: noteVitals.value.title,
        chatHistory: [{ role: "user", content: prompt }],
      });
      activeView.value = "chat";
      new Notice("Sent to chat");
    } catch (err) {
      new Notice(err instanceof Error ? err.message : "Failed to send to chat");
    }
  } else {
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
    chatActivities.value = [
      ...chatActivities.value,
      createActivityItem("Complete", "complete"),
    ];
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

/**
 * Handle inline actions from chat messages.
 */
export async function handleChatAction(
  { actionApplier, obsidian }: HandleChatActionDeps,
  action: ChatAction,
): Promise<void> {
  const currentPath = chatContext.value.notePath;

  if (!currentPath && action.type !== "open-note" && action.type !== "create-note") {
    new Notice("No note context for this action");
    return;
  }

  switch (action.type) {
    case "open-note": {
      const path = (action.payload as { path?: string })?.path;
      if (path) {
        obsidian.openFile(path);
      }
      break;
    }

    case "apply-links": {
      if (!actionApplier || !currentPath) {
        new Notice("Action system not available");
        return;
      }
      const links = (action.payload as { links?: string[] })?.links || [];
      if (links.length === 0) {
        new Notice("No links to apply");
        return;
      }
      const result = await actionApplier.applyConfirmed({
        id: `action-${Date.now()}`,
        type: "append_related_links",
        target: currentPath,
        title: `Add ${links.length} related links`,
        risk: "low",
        reason: "User applied links from chat",
        requiresWriteLock: true,
        payload: { links },
      });
      if (result.success) {
        new Notice(`Added ${links.length} links`);
      } else {
        new Notice(`Failed: ${result.error}`);
      }
      break;
    }

    case "apply-tags": {
      if (!actionApplier || !currentPath) {
        new Notice("Action system not available");
        return;
      }
      const tags = (action.payload as { tags?: string[] })?.tags || [];
      if (tags.length === 0) {
        new Notice("No tags to apply");
        return;
      }
      const result = await actionApplier.applyConfirmed({
        id: `action-${Date.now()}`,
        type: "frontmatter_add_tags",
        target: currentPath,
        title: `Add ${tags.length} tags`,
        risk: "low",
        reason: "User applied tags from chat",
        requiresWriteLock: true,
        payload: { tags },
      });
      if (result.success) {
        new Notice(`Added ${tags.length} tags`);
      } else {
        new Notice(`Failed: ${result.error}`);
      }
      break;
    }

    case "create-note": {
      if (!actionApplier) {
        new Notice("Action system not available");
        return;
      }
      const payload = action.payload as { path?: string; content?: string };
      if (!payload?.path || !payload?.content) {
        new Notice("Missing path or content");
        return;
      }
      const result = await actionApplier.applyConfirmed({
        id: `action-${Date.now()}`,
        type: "create_note",
        target: payload.path,
        title: `Create ${payload.path.split("/").pop()}`,
        risk: "low",
        reason: "User created note from chat",
        requiresWriteLock: true,
        payload: { path: payload.path, content: payload.content },
      });
      if (result.success) {
        new Notice(`Created ${payload.path}`);
        obsidian.openFile(payload.path);
      } else {
        new Notice(`Failed: ${result.error}`);
      }
      break;
    }
  }
}
