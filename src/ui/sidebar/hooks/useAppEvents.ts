/**
 * useAppEvents - Centralized EventBus subscriptions for App
 *
 * Extracts all EventBus event handling from App.tsx into a single hook.
 * Updates the centralized signals in response to system events.
 */

import { batch } from "@preact/signals";
import { Notice } from "obsidian";
import type { ChatService } from "../../../core/chat";
import { UI_LIMITS } from "../../../core/constants";
import { generateId } from "../../../core/ids";
import type { Insight } from "../../../services/insightGenerator";
import type { AgentResultData } from "../components/AgentStreamsView";
import { useEventBus } from "../context/KernelContext";
import {
  activeAgents,
  activeView,
  agentInsights,
  agentStatus,
  chatMessages,
  chatSlashCommandTasks,
  indexStatus,
  initContext,
  initState,
  isServicesReady,
  pendingActions,
  pendingActionSources,
  providerStatus,
  recentActivity,
} from "../state";
import { ACTION_LABELS } from "../state/appHandlers";

interface UseAppEventsOptions {
  chatService: ChatService | null;
  createChatService: () => ChatService | null;
}

/**
 * Subscribe to all system events and update sidebar state accordingly.
 * Call this once in the root App component.
 */
export function useAppEvents({ chatService, createChatService }: UseAppEventsOptions): void {
  // Services initialization
  useEventBus("services:initialized", () => {
    isServicesReady.value = true;
    if (!chatService) {
      createChatService();
    }
  });

  // Initialization state machine changes
  useEventBus("init:state-changed", (data) => {
    initState.value = data.currentState;
    initContext.value = data.context;
    const isOperational = data.currentState === "READY" || data.currentState === "DEGRADED";
    isServicesReady.value = isOperational;
  });

  // Provider health events
  useEventBus("health:changed", (data) => {
    const isHealthy = data.health.status === "healthy";
    const modelName = (data.health.details?.model as string) || null;

    if (data.service === "lmstudio") {
      providerStatus.value = {
        ...providerStatus.value,
        lmstudio: { connected: isHealthy, model: modelName },
      };
      if (isHealthy && !chatService) {
        createChatService();
      }
    } else if (data.service === "ollama") {
      providerStatus.value = {
        ...providerStatus.value,
        ollama: { connected: isHealthy, model: modelName },
      };
    }
  });

  // Index events
  useEventBus("index:progress", (data) => {
    const progress = data.progress;
    indexStatus.value = {
      ...indexStatus.value,
      isIndexing: true,
      indexingProgress:
        progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0,
    };
  });

  useEventBus("index:complete", (data) => {
    indexStatus.value = {
      ...indexStatus.value,
      noteCount: data.totalIndexed,
      isIndexing: false,
      lastSyncedAt: new Date(),
    };
  });

  // Workflow events
  useEventBus("workflow:started", (data) => {
    queueMicrotask(() => {
      const workflow = data.workflow;
      batch(() => {
        agentStatus.value = {
          ...agentStatus.value,
          runningCount: agentStatus.value.runningCount + 1,
        };
        activeAgents.value = [
          ...activeAgents.value,
          {
            id: workflow.id,
            type: workflow.spec.command || "workflow",
            targetNote: workflow.spec.targets[0] || "vault",
            status: "running",
            progress: 0,
            startedAt: workflow.startedAt ? new Date(workflow.startedAt) : new Date(),
          },
        ];
      });
    });
  });

  useEventBus("workflow:progress", (data) => {
    queueMicrotask(() => {
      const workflow = data.workflow;
      activeAgents.value = activeAgents.value.map((agent) =>
        agent.id === workflow.id
          ? {
              ...agent,
              progress:
                workflow.progress.total > 0
                  ? Math.round((workflow.progress.completed / workflow.progress.total) * 100)
                  : 0,
            }
          : agent,
      );
    });
  });

  useEventBus("workflow:completed", (data) => {
    queueMicrotask(() => {
      const workflow = data.workflow;
      const agent = activeAgents.value.find((a) => a.id === workflow.id);
      batch(() => {
        agentStatus.value = {
          ...agentStatus.value,
          runningCount: Math.max(0, agentStatus.value.runningCount - 1),
        };
        activeAgents.value = activeAgents.value.filter((a) => a.id !== workflow.id);
        if (agent) {
          recentActivity.value = [
            {
              id: generateId("stm"),
              status: "success",
              actionType: "workflow",
              targetNote: agent.targetNote,
              summary: `${agent.type} completed`,
              completedAt: new Date(),
              canUndo: false,
            },
            ...recentActivity.value.slice(0, UI_LIMITS.MAX_RECENT_ACTIVITY_COUNT),
          ];
        }
      });
    });
  });

  useEventBus("workflow:failed", (data) => {
    queueMicrotask(() => {
      const workflow = data.workflow;
      const agent = activeAgents.value.find((a) => a.id === workflow.id);
      batch(() => {
        agentStatus.value = {
          ...agentStatus.value,
          runningCount: Math.max(0, agentStatus.value.runningCount - 1),
        };
        activeAgents.value = activeAgents.value.filter((a) => a.id !== workflow.id);
        if (agent) {
          recentActivity.value = [
            {
              id: generateId("stm"),
              status: "failed",
              actionType: "workflow",
              targetNote: agent.targetNote,
              summary: `${agent.type} failed`,
              completedAt: new Date(),
              canUndo: false,
              error: data.error,
            },
            ...recentActivity.value.slice(0, UI_LIMITS.MAX_RECENT_ACTIVITY_COUNT),
          ];
        }
      });
    });
  });

  useEventBus("workflow:cancelled", (data) => {
    queueMicrotask(() => {
      const workflow = data.workflow;
      batch(() => {
        agentStatus.value = {
          ...agentStatus.value,
          runningCount: Math.max(0, agentStatus.value.runningCount - 1),
        };
        activeAgents.value = activeAgents.value.filter((a) => a.id !== workflow.id);
      });
    });
  });

  // Action events
  useEventBus("action:proposed", (data) => {
    queueMicrotask(() => {
      const action = data.action;
      batch(() => {
        agentStatus.value = {
          ...agentStatus.value,
          pendingReviewCount: agentStatus.value.pendingReviewCount + 1,
        };
        pendingActions.value = [
          ...pendingActions.value,
          {
            id: action.id,
            actionType: action.type,
            targetNote: data.noteContext.title || action.target,
            summary: action.title,
            riskLevel: action.risk,
          },
        ];
        // Store original ProposedAction for when we need to apply it
        const updatedSources = new Map(pendingActionSources.value);
        updatedSources.set(action.id, action);
        pendingActionSources.value = updatedSources;
      });
    });
  });

  useEventBus("action:applied", (data) => {
    queueMicrotask(() => {
      const record = data.record;
      batch(() => {
        agentStatus.value = {
          ...agentStatus.value,
          pendingReviewCount: Math.max(0, agentStatus.value.pendingReviewCount - 1),
        };
        pendingActions.value = pendingActions.value.filter((a) => a.id !== record.action.id);
        // Clean up stored original action
        const updatedSources = new Map(pendingActionSources.value);
        updatedSources.delete(record.action.id);
        pendingActionSources.value = updatedSources;
        recentActivity.value = [
          {
            id: record.id,
            status: "success",
            actionType: record.action.type,
            targetNote: record.action.target.split("/").pop() || record.action.target,
            summary: record.action.title,
            completedAt: new Date(record.timestamp),
            canUndo: true,
          },
          ...recentActivity.value.slice(0, UI_LIMITS.MAX_RECENT_ACTIVITY_COUNT),
        ];
      });
    });
  });

  useEventBus("action:undone", (data) => {
    queueMicrotask(() => {
      recentActivity.value = recentActivity.value.map((a) =>
        a.id === data.recordId ? { ...a, status: "undone" as const, canUndo: false } : a,
      );
    });
  });

  // Agent task updates - dispatch to handlers
  useEventBus("agent:task-update", (data) => {
    const task = data.task;
    if (!task.taskType || task.taskType === "chat") {
      return;
    }

    switch (task.status) {
      case "running":
        handleTaskRunning(task);
        break;
      case "completed":
        handleTaskCompleted(task);
        break;
      case "failed":
        handleTaskFailed(task);
        break;
      case "cancelled":
        handleTaskCancelled(task);
        break;
      case "queued":
        handleTaskQueued(task);
        break;
    }
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Task Status Handlers
// ──────────────────────────────────────────────────────────────────────────

interface TaskData {
  id: string;
  taskType?: string;
  noteTitle?: string;
  progress?: number;
  result?: {
    data?: unknown;
    citations?: string[];
    actions?: Array<{ id: string; type: string; title: string; risk: string }>;
  };
  error?: string;
}

function handleTaskRunning(task: TaskData): void {
  queueMicrotask(() => {
    const existingAgent = activeAgents.value.find((a) => a.id === task.id);
    if (existingAgent) {
      const wasQueued = existingAgent.status === "queued";
      batch(() => {
        activeAgents.value = activeAgents.value.map((agent) =>
          agent.id === task.id
            ? { ...agent, status: "running" as const, progress: task.progress || 0 }
            : agent,
        );
        if (wasQueued) {
          agentStatus.value = {
            ...agentStatus.value,
            runningCount: agentStatus.value.runningCount + 1,
          };
        }
      });
    } else {
      batch(() => {
        activeAgents.value = [
          ...activeAgents.value,
          {
            id: task.id,
            type: ACTION_LABELS[task.taskType || ""] || task.taskType || "Agent",
            targetNote: task.noteTitle || "Note",
            status: "running" as const,
            progress: task.progress || 0,
            startedAt: new Date(),
          },
        ];
        agentStatus.value = {
          ...agentStatus.value,
          runningCount: agentStatus.value.runningCount + 1,
        };
      });
    }
  });
}

function handleTaskCompleted(task: TaskData): void {
  const agent = activeAgents.value.find((a) => a.id === task.id);
  if (!agent) {
    queueMicrotask(() => {
      new Notice(`${task.taskType || "Agent"} completed`);
    });
    return;
  }

  // Defer signal updates to next microtask and batch all updates to prevent cascading re-renders
  // buildResultData is optimized to handle large objects efficiently
  queueMicrotask(() => {
    const resultData = buildResultData(task, agent);
    batch(() => {
      updateAgentAsCompleted(task.id, resultData);
      agentStatus.value = {
        ...agentStatus.value,
        runningCount: Math.max(0, agentStatus.value.runningCount - 1),
      };

      if (task.result?.actions?.length) {
        addPendingActions(task.result.actions, agent.targetNote);
      }

      addCompletionInsight(task.taskType || "agent", resultData.insightSummary || "");

      // Mirror to chat if this was a slash command task
      mirrorTaskResultToChat(
        task.id,
        resultData.content || resultData.insightSummary || "Complete",
      );
    });
    new Notice(`${task.taskType || "Agent"} completed`);
  });
}

function buildResultData(task: TaskData, agent: { startedAt?: Date }): AgentResultData {
  // Optimize JSON.stringify for large objects - use try/catch and limit size
  let resultContent: string;
  if (typeof task.result?.data === "string") {
    resultContent = task.result.data;
  } else {
    try {
      // For large objects, stringify without pretty printing to reduce overhead
      const data = task.result?.data || {};
      // Limit stringification size to prevent UI freeze
      const jsonStr = JSON.stringify(data);
      if (jsonStr.length > 10000) {
        // For very large results, truncate the stringified version
        resultContent = `${jsonStr.slice(0, 10000)}... [truncated]`;
      } else {
        resultContent = JSON.stringify(data, null, 2);
      }
    } catch (error) {
      resultContent = `[Error serializing result: ${error}]`;
    }
  }
  const insightSummary =
    resultContent.length > 100 ? `${resultContent.slice(0, 100).trim()}...` : resultContent;
  const durationMs = agent.startedAt ? Date.now() - agent.startedAt.getTime() : 0;

  return {
    content: resultContent,
    structured: task.result?.data,
    citations: task.result?.citations,
    insightSummary,
    stats: { durationMs },
  };
}

function updateAgentAsCompleted(taskId: string, resultData: AgentResultData): void {
  activeAgents.value = activeAgents.value.map((a) =>
    a.id === taskId
      ? { ...a, status: "completed" as const, completedAt: new Date(), progress: 100, resultData }
      : a,
  );
}

function addPendingActions(
  actions: Array<{ id: string; type: string; title: string; risk: string }>,
  targetNote: string,
): void {
  const newPendingActions = actions.map((action) => ({
    id: action.id,
    actionType: action.type,
    targetNote,
    summary: action.title,
    riskLevel: action.risk as "low" | "medium" | "high",
  }));
  // Batch updates to prevent cascading re-renders
  batch(() => {
    pendingActions.value = [...pendingActions.value, ...newPendingActions];
    agentStatus.value = {
      ...agentStatus.value,
      pendingReviewCount: agentStatus.value.pendingReviewCount + newPendingActions.length,
    };
  });
}

function addCompletionInsight(taskType: string | undefined, summary: string): void {
  const newInsight: Insight = {
    text: `${ACTION_LABELS[taskType || "agent"] || "Agent result"}: ${summary}`,
    action: "View in Agents",
    actionIcon: "bot",
    actionCallback: () => {
      activeView.value = "agents";
    },
    priority: "high",
  };
  agentInsights.value = [newInsight, ...agentInsights.value.slice(0, 4)];
}

/**
 * Mirror a slash command task result to the chat UI.
 * Updates the placeholder message with the actual result.
 */
function mirrorTaskResultToChat(taskId: string, content: string): void {
  const chatMsgId = chatSlashCommandTasks.value.get(taskId);
  if (!chatMsgId) return;

  // Update the placeholder message with the result
  chatMessages.value = chatMessages.value.map((msg) =>
    msg.id === chatMsgId ? { ...msg, content } : msg,
  );

  // Clean up tracking
  const updated = new Map(chatSlashCommandTasks.value);
  updated.delete(taskId);
  chatSlashCommandTasks.value = updated;
}

function handleTaskFailed(task: TaskData): void {
  queueMicrotask(() => {
    const failedAgent = activeAgents.value.find((a) => a.id === task.id);
    batch(() => {
      activeAgents.value = activeAgents.value.filter((a) => a.id !== task.id);
      agentStatus.value = {
        ...agentStatus.value,
        runningCount: Math.max(0, agentStatus.value.runningCount - 1),
      };

      if (failedAgent) {
        recentActivity.value = [
          {
            id: generateId("stm"),
            status: "failed",
            actionType: task.taskType || "agent",
            targetNote: failedAgent.targetNote,
            summary: `${failedAgent.type} failed`,
            completedAt: new Date(),
            canUndo: false,
            error: task.error,
          },
          ...recentActivity.value.slice(0, UI_LIMITS.MAX_RECENT_ACTIVITY_COUNT),
        ];
      }

      // Mirror failure to chat if this was a slash command task
      mirrorTaskResultToChat(task.id, `Failed: ${task.error || "Unknown error"}`);
    });
    new Notice(`Agent failed: ${task.error || "Unknown error"}`);
  });
}

function handleTaskCancelled(task: TaskData): void {
  queueMicrotask(() => {
    const agent = activeAgents.value.find((a) => a.id === task.id);
    const wasRunning = agent?.status === "running";
    batch(() => {
      activeAgents.value = activeAgents.value.filter((a) => a.id !== task.id);
      if (wasRunning) {
        agentStatus.value = {
          ...agentStatus.value,
          runningCount: Math.max(0, agentStatus.value.runningCount - 1),
        };
      }
    });
  });
}

function handleTaskQueued(task: TaskData): void {
  queueMicrotask(() => {
    if (activeAgents.value.some((a) => a.id === task.id)) {
      return;
    }
    activeAgents.value = [
      ...activeAgents.value,
      {
        id: task.id,
        type: ACTION_LABELS[task.taskType || ""] || task.taskType || "Agent",
        targetNote: task.noteTitle || "Note",
        status: "queued" as const,
        progress: 0,
        startedAt: new Date(),
      },
    ];
  });
}
