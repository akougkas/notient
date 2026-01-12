/**
 * useAppEvents - Centralized EventBus subscriptions for App
 *
 * Extracts all EventBus event handling from App.tsx into a single hook.
 * Updates the centralized signals in response to system events.
 */

import { Notice } from "obsidian";
import type { ChatService } from "../../../core/chat";
import { UI_LIMITS } from "../../../core/constants";
import type { Insight } from "../../../services/insightGenerator";
import type { AgentResultData } from "../components/AgentStreamsView";
import { useEventBus } from "../context/KernelContext";
import {
  activeAgents,
  activeView,
  agentInsights,
  agentStatus,
  indexStatus,
  initContext,
  initState,
  isServicesReady,
  pendingActions,
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
    const workflow = data.workflow;
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

  useEventBus("workflow:progress", (data) => {
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

  useEventBus("workflow:completed", (data) => {
    const workflow = data.workflow;
    const agent = activeAgents.value.find((a) => a.id === workflow.id);
    agentStatus.value = {
      ...agentStatus.value,
      runningCount: Math.max(0, agentStatus.value.runningCount - 1),
    };
    activeAgents.value = activeAgents.value.filter((a) => a.id !== workflow.id);
    if (agent) {
      recentActivity.value = [
        {
          id: `activity-${Date.now()}`,
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

  useEventBus("workflow:failed", (data) => {
    const workflow = data.workflow;
    const agent = activeAgents.value.find((a) => a.id === workflow.id);
    agentStatus.value = {
      ...agentStatus.value,
      runningCount: Math.max(0, agentStatus.value.runningCount - 1),
    };
    activeAgents.value = activeAgents.value.filter((a) => a.id !== workflow.id);
    if (agent) {
      recentActivity.value = [
        {
          id: `activity-${Date.now()}`,
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

  useEventBus("workflow:cancelled", (data) => {
    const workflow = data.workflow;
    agentStatus.value = {
      ...agentStatus.value,
      runningCount: Math.max(0, agentStatus.value.runningCount - 1),
    };
    activeAgents.value = activeAgents.value.filter((a) => a.id !== workflow.id);
  });

  // Action events
  useEventBus("action:proposed", (data) => {
    const action = data.action;
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
  });

  useEventBus("action:applied", (data) => {
    const record = data.record;
    agentStatus.value = {
      ...agentStatus.value,
      pendingReviewCount: Math.max(0, agentStatus.value.pendingReviewCount - 1),
    };
    pendingActions.value = pendingActions.value.filter((a) => a.id !== record.action.id);
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

  useEventBus("action:undone", (data) => {
    recentActivity.value = recentActivity.value.map((a) =>
      a.id === data.recordId ? { ...a, status: "undone" as const, canUndo: false } : a,
    );
  });

  // Agent task updates - dispatch to handlers
  useEventBus("agent:task-update", (data) => {
    const task = data.task;
    if (!task.taskType || task.taskType === "chat") return;

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
  const existingAgent = activeAgents.value.find((a) => a.id === task.id);
  if (existingAgent) {
    const wasQueued = existingAgent.status === "queued";
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
  } else {
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
    agentStatus.value = { ...agentStatus.value, runningCount: agentStatus.value.runningCount + 1 };
  }
}

function handleTaskCompleted(task: TaskData): void {
  const agent = activeAgents.value.find((a) => a.id === task.id);
  if (!agent) {
    new Notice(`${task.taskType || "Agent"} completed`);
    return;
  }

  // Defer signal updates to next tick to prevent synchronous cascade/freeze
  setTimeout(() => {
    const resultData = buildResultData(task, agent);
    updateAgentAsCompleted(task.id, resultData);
    agentStatus.value = {
      ...agentStatus.value,
      runningCount: Math.max(0, agentStatus.value.runningCount - 1),
    };

    if (task.result?.actions?.length) {
      addPendingActions(task.result.actions, agent.targetNote);
    }

    addCompletionInsight(task.taskType || "agent", resultData.insightSummary || "");
    new Notice(`${task.taskType || "Agent"} completed`);
  }, 0);
}

function buildResultData(task: TaskData, agent: { startedAt?: Date }): AgentResultData {
  const resultContent =
    typeof task.result?.data === "string"
      ? task.result.data
      : JSON.stringify(task.result?.data || {}, null, 2);
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
  pendingActions.value = [...pendingActions.value, ...newPendingActions];
  agentStatus.value = {
    ...agentStatus.value,
    pendingReviewCount: agentStatus.value.pendingReviewCount + newPendingActions.length,
  };
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

function handleTaskFailed(task: TaskData): void {
  const failedAgent = activeAgents.value.find((a) => a.id === task.id);
  activeAgents.value = activeAgents.value.filter((a) => a.id !== task.id);
  agentStatus.value = {
    ...agentStatus.value,
    runningCount: Math.max(0, agentStatus.value.runningCount - 1),
  };

  if (failedAgent) {
    recentActivity.value = [
      {
        id: `activity-${Date.now()}`,
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
  new Notice(`Agent failed: ${task.error || "Unknown error"}`);
}

function handleTaskCancelled(task: TaskData): void {
  const agent = activeAgents.value.find((a) => a.id === task.id);
  const wasRunning = agent?.status === "running";
  activeAgents.value = activeAgents.value.filter((a) => a.id !== task.id);
  if (wasRunning) {
    agentStatus.value = {
      ...agentStatus.value,
      runningCount: Math.max(0, agentStatus.value.runningCount - 1),
    };
  }
}

function handleTaskQueued(task: TaskData): void {
  if (activeAgents.value.some((a) => a.id === task.id)) return;
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
}
