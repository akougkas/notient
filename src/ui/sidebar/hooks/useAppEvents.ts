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
  console.log("[useAppEvents] TRACE: START hook execution");

  // Services initialization
  useEventBus("services:initialized", () => {
    console.log("[useAppEvents:services:initialized] TRACE: START");
    console.log(
      "[useAppEvents:services:initialized] TRACE: Before isServicesReady.value assignment",
    );
    isServicesReady.value = true;
    console.log(
      "[useAppEvents:services:initialized] TRACE: After isServicesReady.value assignment",
    );
    if (!chatService) {
      console.log("[useAppEvents:services:initialized] TRACE: Creating chat service");
      createChatService();
    }
    console.log("[useAppEvents:services:initialized] TRACE: END");
  });

  // Initialization state machine changes
  useEventBus("init:state-changed", (data) => {
    console.log("[useAppEvents:init:state-changed] TRACE: START", data);
    console.log("[useAppEvents:init:state-changed] TRACE: Before initState.value assignment");
    initState.value = data.currentState;
    console.log("[useAppEvents:init:state-changed] TRACE: After initState.value assignment");
    console.log("[useAppEvents:init:state-changed] TRACE: Before initContext.value assignment");
    initContext.value = data.context;
    console.log("[useAppEvents:init:state-changed] TRACE: After initContext.value assignment");
    const isOperational = data.currentState === "READY" || data.currentState === "DEGRADED";
    console.log(
      "[useAppEvents:init:state-changed] TRACE: Before isServicesReady.value assignment, isOperational=",
      isOperational,
    );
    isServicesReady.value = isOperational;
    console.log("[useAppEvents:init:state-changed] TRACE: After isServicesReady.value assignment");
    console.log("[useAppEvents:init:state-changed] TRACE: END");
  });

  // Provider health events
  useEventBus("health:changed", (data) => {
    console.log("[useAppEvents:health:changed] TRACE: START", data);
    const isHealthy = data.health.status === "healthy";
    const modelName = (data.health.details?.model as string) || null;

    if (data.service === "lmstudio") {
      console.log(
        "[useAppEvents:health:changed] TRACE: Before providerStatus.value assignment (lmstudio)",
      );
      providerStatus.value = {
        ...providerStatus.value,
        lmstudio: { connected: isHealthy, model: modelName },
      };
      console.log(
        "[useAppEvents:health:changed] TRACE: After providerStatus.value assignment (lmstudio)",
      );
      if (isHealthy && !chatService) {
        console.log("[useAppEvents:health:changed] TRACE: Creating chat service");
        createChatService();
      }
    } else if (data.service === "ollama") {
      console.log(
        "[useAppEvents:health:changed] TRACE: Before providerStatus.value assignment (ollama)",
      );
      providerStatus.value = {
        ...providerStatus.value,
        ollama: { connected: isHealthy, model: modelName },
      };
      console.log(
        "[useAppEvents:health:changed] TRACE: After providerStatus.value assignment (ollama)",
      );
    }
    console.log("[useAppEvents:health:changed] TRACE: END");
  });

  // Index events
  useEventBus("index:progress", (data) => {
    console.log("[useAppEvents:index:progress] TRACE: START", data);
    const progress = data.progress;
    console.log("[useAppEvents:index:progress] TRACE: Before indexStatus.value assignment");
    indexStatus.value = {
      ...indexStatus.value,
      isIndexing: true,
      indexingProgress:
        progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0,
    };
    console.log("[useAppEvents:index:progress] TRACE: After indexStatus.value assignment");
    console.log("[useAppEvents:index:progress] TRACE: END");
  });

  useEventBus("index:complete", (data) => {
    console.log("[useAppEvents:index:complete] TRACE: START", data);
    console.log("[useAppEvents:index:complete] TRACE: Before indexStatus.value assignment");
    indexStatus.value = {
      ...indexStatus.value,
      noteCount: data.totalIndexed,
      isIndexing: false,
      lastSyncedAt: new Date(),
    };
    console.log("[useAppEvents:index:complete] TRACE: After indexStatus.value assignment");
    console.log("[useAppEvents:index:complete] TRACE: END");
  });

  // Workflow events
  useEventBus("workflow:started", (data) => {
    console.log("[useAppEvents:workflow:started] TRACE: START", data);
    queueMicrotask(() => {
      console.log("[useAppEvents:workflow:started] TRACE: In microtask");
      const workflow = data.workflow;
      batch(() => {
        console.log("[useAppEvents:workflow:started] TRACE: In batch");
        console.log("[useAppEvents:workflow:started] TRACE: Before agentStatus.value assignment");
        agentStatus.value = {
          ...agentStatus.value,
          runningCount: agentStatus.value.runningCount + 1,
        };
        console.log("[useAppEvents:workflow:started] TRACE: After agentStatus.value assignment");
        console.log("[useAppEvents:workflow:started] TRACE: Before activeAgents.value assignment");
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
        console.log("[useAppEvents:workflow:started] TRACE: After activeAgents.value assignment");
      });
      console.log("[useAppEvents:workflow:started] TRACE: After batch");
    });
    console.log("[useAppEvents:workflow:started] TRACE: END (microtask queued)");
  });

  useEventBus("workflow:progress", (data) => {
    console.log("[useAppEvents:workflow:progress] TRACE: START", data);
    queueMicrotask(() => {
      console.log("[useAppEvents:workflow:progress] TRACE: In microtask");
      const workflow = data.workflow;
      console.log("[useAppEvents:workflow:progress] TRACE: Before activeAgents.value assignment");
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
      console.log("[useAppEvents:workflow:progress] TRACE: After activeAgents.value assignment");
    });
    console.log("[useAppEvents:workflow:progress] TRACE: END (microtask queued)");
  });

  useEventBus("workflow:completed", (data) => {
    console.log("[useAppEvents:workflow:completed] TRACE: START", data);
    queueMicrotask(() => {
      console.log("[useAppEvents:workflow:completed] TRACE: In microtask");
      const workflow = data.workflow;
      const agent = activeAgents.value.find((a) => a.id === workflow.id);
      batch(() => {
        console.log("[useAppEvents:workflow:completed] TRACE: In batch");
        console.log("[useAppEvents:workflow:completed] TRACE: Before agentStatus.value assignment");
        agentStatus.value = {
          ...agentStatus.value,
          runningCount: Math.max(0, agentStatus.value.runningCount - 1),
        };
        console.log("[useAppEvents:workflow:completed] TRACE: After agentStatus.value assignment");
        console.log(
          "[useAppEvents:workflow:completed] TRACE: Before activeAgents.value assignment",
        );
        activeAgents.value = activeAgents.value.filter((a) => a.id !== workflow.id);
        console.log("[useAppEvents:workflow:completed] TRACE: After activeAgents.value assignment");
        if (agent) {
          console.log(
            "[useAppEvents:workflow:completed] TRACE: Before recentActivity.value assignment",
          );
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
          console.log(
            "[useAppEvents:workflow:completed] TRACE: After recentActivity.value assignment",
          );
        }
      });
      console.log("[useAppEvents:workflow:completed] TRACE: After batch");
    });
    console.log("[useAppEvents:workflow:completed] TRACE: END (microtask queued)");
  });

  useEventBus("workflow:failed", (data) => {
    console.log("[useAppEvents:workflow:failed] TRACE: START", data);
    queueMicrotask(() => {
      console.log("[useAppEvents:workflow:failed] TRACE: In microtask");
      const workflow = data.workflow;
      const agent = activeAgents.value.find((a) => a.id === workflow.id);
      batch(() => {
        console.log("[useAppEvents:workflow:failed] TRACE: In batch");
        console.log("[useAppEvents:workflow:failed] TRACE: Before agentStatus.value assignment");
        agentStatus.value = {
          ...agentStatus.value,
          runningCount: Math.max(0, agentStatus.value.runningCount - 1),
        };
        console.log("[useAppEvents:workflow:failed] TRACE: After agentStatus.value assignment");
        console.log("[useAppEvents:workflow:failed] TRACE: Before activeAgents.value assignment");
        activeAgents.value = activeAgents.value.filter((a) => a.id !== workflow.id);
        console.log("[useAppEvents:workflow:failed] TRACE: After activeAgents.value assignment");
        if (agent) {
          console.log(
            "[useAppEvents:workflow:failed] TRACE: Before recentActivity.value assignment",
          );
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
          console.log(
            "[useAppEvents:workflow:failed] TRACE: After recentActivity.value assignment",
          );
        }
      });
      console.log("[useAppEvents:workflow:failed] TRACE: After batch");
    });
    console.log("[useAppEvents:workflow:failed] TRACE: END (microtask queued)");
  });

  useEventBus("workflow:cancelled", (data) => {
    console.log("[useAppEvents:workflow:cancelled] TRACE: START", data);
    queueMicrotask(() => {
      console.log("[useAppEvents:workflow:cancelled] TRACE: In microtask");
      const workflow = data.workflow;
      batch(() => {
        console.log("[useAppEvents:workflow:cancelled] TRACE: In batch");
        console.log("[useAppEvents:workflow:cancelled] TRACE: Before agentStatus.value assignment");
        agentStatus.value = {
          ...agentStatus.value,
          runningCount: Math.max(0, agentStatus.value.runningCount - 1),
        };
        console.log("[useAppEvents:workflow:cancelled] TRACE: After agentStatus.value assignment");
        console.log(
          "[useAppEvents:workflow:cancelled] TRACE: Before activeAgents.value assignment",
        );
        activeAgents.value = activeAgents.value.filter((a) => a.id !== workflow.id);
        console.log("[useAppEvents:workflow:cancelled] TRACE: After activeAgents.value assignment");
      });
      console.log("[useAppEvents:workflow:cancelled] TRACE: After batch");
    });
    console.log("[useAppEvents:workflow:cancelled] TRACE: END (microtask queued)");
  });

  // Action events
  useEventBus("action:proposed", (data) => {
    console.log("[useAppEvents:action:proposed] TRACE: START", data);
    queueMicrotask(() => {
      console.log("[useAppEvents:action:proposed] TRACE: In microtask");
      const action = data.action;
      batch(() => {
        console.log("[useAppEvents:action:proposed] TRACE: In batch");
        console.log("[useAppEvents:action:proposed] TRACE: Before agentStatus.value assignment");
        agentStatus.value = {
          ...agentStatus.value,
          pendingReviewCount: agentStatus.value.pendingReviewCount + 1,
        };
        console.log("[useAppEvents:action:proposed] TRACE: After agentStatus.value assignment");
        console.log("[useAppEvents:action:proposed] TRACE: Before pendingActions.value assignment");
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
        console.log("[useAppEvents:action:proposed] TRACE: After pendingActions.value assignment");
      });
      console.log("[useAppEvents:action:proposed] TRACE: After batch");
    });
    console.log("[useAppEvents:action:proposed] TRACE: END (microtask queued)");
  });

  useEventBus("action:applied", (data) => {
    console.log("[useAppEvents:action:applied] TRACE: START", data);
    queueMicrotask(() => {
      console.log("[useAppEvents:action:applied] TRACE: In microtask");
      const record = data.record;
      batch(() => {
        console.log("[useAppEvents:action:applied] TRACE: In batch");
        console.log("[useAppEvents:action:applied] TRACE: Before agentStatus.value assignment");
        agentStatus.value = {
          ...agentStatus.value,
          pendingReviewCount: Math.max(0, agentStatus.value.pendingReviewCount - 1),
        };
        console.log("[useAppEvents:action:applied] TRACE: After agentStatus.value assignment");
        console.log("[useAppEvents:action:applied] TRACE: Before pendingActions.value assignment");
        pendingActions.value = pendingActions.value.filter((a) => a.id !== record.action.id);
        console.log("[useAppEvents:action:applied] TRACE: After pendingActions.value assignment");
        console.log("[useAppEvents:action:applied] TRACE: Before recentActivity.value assignment");
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
        console.log("[useAppEvents:action:applied] TRACE: After recentActivity.value assignment");
      });
      console.log("[useAppEvents:action:applied] TRACE: After batch");
    });
    console.log("[useAppEvents:action:applied] TRACE: END (microtask queued)");
  });

  useEventBus("action:undone", (data) => {
    console.log("[useAppEvents:action:undone] TRACE: START", data);
    queueMicrotask(() => {
      console.log("[useAppEvents:action:undone] TRACE: In microtask");
      console.log("[useAppEvents:action:undone] TRACE: Before recentActivity.value assignment");
      recentActivity.value = recentActivity.value.map((a) =>
        a.id === data.recordId ? { ...a, status: "undone" as const, canUndo: false } : a,
      );
      console.log("[useAppEvents:action:undone] TRACE: After recentActivity.value assignment");
    });
    console.log("[useAppEvents:action:undone] TRACE: END (microtask queued)");
  });

  // Agent task updates - dispatch to handlers
  useEventBus("agent:task-update", (data) => {
    console.log("[useAppEvents:agent:task-update] TRACE: START", data);
    const task = data.task;
    if (!task.taskType || task.taskType === "chat") {
      console.log("[useAppEvents:agent:task-update] TRACE: END (skipping chat/empty taskType)");
      return;
    }

    console.log(
      "[useAppEvents:agent:task-update] TRACE: Dispatching to handler for status:",
      task.status,
    );
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
    console.log("[useAppEvents:agent:task-update] TRACE: END");
  });

  console.log("[useAppEvents] TRACE: END hook execution");
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
  console.log("[useAppEvents:handleTaskRunning] TRACE: START", task.id);
  queueMicrotask(() => {
    console.log("[useAppEvents:handleTaskRunning] TRACE: In microtask");
    const existingAgent = activeAgents.value.find((a) => a.id === task.id);
    if (existingAgent) {
      console.log("[useAppEvents:handleTaskRunning] TRACE: Updating existing agent");
      const wasQueued = existingAgent.status === "queued";
      batch(() => {
        console.log("[useAppEvents:handleTaskRunning] TRACE: In batch (existing agent)");
        console.log("[useAppEvents:handleTaskRunning] TRACE: Before activeAgents.value assignment");
        activeAgents.value = activeAgents.value.map((agent) =>
          agent.id === task.id
            ? { ...agent, status: "running" as const, progress: task.progress || 0 }
            : agent,
        );
        console.log("[useAppEvents:handleTaskRunning] TRACE: After activeAgents.value assignment");
        if (wasQueued) {
          console.log(
            "[useAppEvents:handleTaskRunning] TRACE: Before agentStatus.value assignment (was queued)",
          );
          agentStatus.value = {
            ...agentStatus.value,
            runningCount: agentStatus.value.runningCount + 1,
          };
          console.log("[useAppEvents:handleTaskRunning] TRACE: After agentStatus.value assignment");
        }
      });
      console.log("[useAppEvents:handleTaskRunning] TRACE: After batch");
    } else {
      console.log("[useAppEvents:handleTaskRunning] TRACE: Creating new agent entry");
      batch(() => {
        console.log("[useAppEvents:handleTaskRunning] TRACE: In batch (new agent)");
        console.log("[useAppEvents:handleTaskRunning] TRACE: Before activeAgents.value assignment");
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
        console.log("[useAppEvents:handleTaskRunning] TRACE: After activeAgents.value assignment");
        console.log("[useAppEvents:handleTaskRunning] TRACE: Before agentStatus.value assignment");
        agentStatus.value = {
          ...agentStatus.value,
          runningCount: agentStatus.value.runningCount + 1,
        };
        console.log("[useAppEvents:handleTaskRunning] TRACE: After agentStatus.value assignment");
      });
      console.log("[useAppEvents:handleTaskRunning] TRACE: After batch");
    }
  });
  console.log("[useAppEvents:handleTaskRunning] TRACE: END (microtask queued)");
}

function handleTaskCompleted(task: TaskData): void {
  console.log("[useAppEvents:handleTaskCompleted] TRACE: START", task.id);
  const agent = activeAgents.value.find((a) => a.id === task.id);
  if (!agent) {
    console.log("[useAppEvents:handleTaskCompleted] TRACE: No agent found, showing notice");
    queueMicrotask(() => {
      console.log("[useAppEvents:handleTaskCompleted] TRACE: In microtask (no agent)");
      new Notice(`${task.taskType || "Agent"} completed`);
    });
    console.log("[useAppEvents:handleTaskCompleted] TRACE: END (no agent)");
    return;
  }

  // Defer signal updates to next microtask and batch all updates to prevent cascading re-renders
  // buildResultData is optimized to handle large objects efficiently
  queueMicrotask(() => {
    console.log("[useAppEvents:handleTaskCompleted] TRACE: In microtask");
    const resultData = buildResultData(task, agent);
    batch(() => {
      console.log("[useAppEvents:handleTaskCompleted] TRACE: In batch");
      console.log("[useAppEvents:handleTaskCompleted] TRACE: Calling updateAgentAsCompleted");
      updateAgentAsCompleted(task.id, resultData);
      console.log("[useAppEvents:handleTaskCompleted] TRACE: Before agentStatus.value assignment");
      agentStatus.value = {
        ...agentStatus.value,
        runningCount: Math.max(0, agentStatus.value.runningCount - 1),
      };
      console.log("[useAppEvents:handleTaskCompleted] TRACE: After agentStatus.value assignment");

      if (task.result?.actions?.length) {
        console.log("[useAppEvents:handleTaskCompleted] TRACE: Calling addPendingActions");
        addPendingActions(task.result.actions, agent.targetNote);
      }

      console.log("[useAppEvents:handleTaskCompleted] TRACE: Calling addCompletionInsight");
      addCompletionInsight(task.taskType || "agent", resultData.insightSummary || "");
    });
    console.log("[useAppEvents:handleTaskCompleted] TRACE: After batch");
    new Notice(`${task.taskType || "Agent"} completed`);
  });
  console.log("[useAppEvents:handleTaskCompleted] TRACE: END (microtask queued)");
}

function buildResultData(task: TaskData, agent: { startedAt?: Date }): AgentResultData {
  console.log("[useAppEvents:buildResultData] TRACE: START");
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

  console.log("[useAppEvents:buildResultData] TRACE: END");
  return {
    content: resultContent,
    structured: task.result?.data,
    citations: task.result?.citations,
    insightSummary,
    stats: { durationMs },
  };
}

function updateAgentAsCompleted(taskId: string, resultData: AgentResultData): void {
  console.log("[useAppEvents:updateAgentAsCompleted] TRACE: START", taskId);
  console.log("[useAppEvents:updateAgentAsCompleted] TRACE: Before activeAgents.value assignment");
  activeAgents.value = activeAgents.value.map((a) =>
    a.id === taskId
      ? { ...a, status: "completed" as const, completedAt: new Date(), progress: 100, resultData }
      : a,
  );
  console.log("[useAppEvents:updateAgentAsCompleted] TRACE: After activeAgents.value assignment");
  console.log("[useAppEvents:updateAgentAsCompleted] TRACE: END");
}

function addPendingActions(
  actions: Array<{ id: string; type: string; title: string; risk: string }>,
  targetNote: string,
): void {
  console.log("[useAppEvents:addPendingActions] TRACE: START", actions.length, "actions");
  const newPendingActions = actions.map((action) => ({
    id: action.id,
    actionType: action.type,
    targetNote,
    summary: action.title,
    riskLevel: action.risk as "low" | "medium" | "high",
  }));
  // Batch updates to prevent cascading re-renders
  batch(() => {
    console.log("[useAppEvents:addPendingActions] TRACE: In batch");
    console.log("[useAppEvents:addPendingActions] TRACE: Before pendingActions.value assignment");
    pendingActions.value = [...pendingActions.value, ...newPendingActions];
    console.log("[useAppEvents:addPendingActions] TRACE: After pendingActions.value assignment");
    console.log("[useAppEvents:addPendingActions] TRACE: Before agentStatus.value assignment");
    agentStatus.value = {
      ...agentStatus.value,
      pendingReviewCount: agentStatus.value.pendingReviewCount + newPendingActions.length,
    };
    console.log("[useAppEvents:addPendingActions] TRACE: After agentStatus.value assignment");
  });
  console.log("[useAppEvents:addPendingActions] TRACE: After batch");
  console.log("[useAppEvents:addPendingActions] TRACE: END");
}

function addCompletionInsight(taskType: string | undefined, summary: string): void {
  console.log("[useAppEvents:addCompletionInsight] TRACE: START", taskType);
  const newInsight: Insight = {
    text: `${ACTION_LABELS[taskType || "agent"] || "Agent result"}: ${summary}`,
    action: "View in Agents",
    actionIcon: "bot",
    actionCallback: () => {
      console.log("[useAppEvents:addCompletionInsight:actionCallback] TRACE: START");
      console.log(
        "[useAppEvents:addCompletionInsight:actionCallback] TRACE: Before activeView.value assignment",
      );
      activeView.value = "agents";
      console.log(
        "[useAppEvents:addCompletionInsight:actionCallback] TRACE: After activeView.value assignment",
      );
      console.log("[useAppEvents:addCompletionInsight:actionCallback] TRACE: END");
    },
    priority: "high",
  };
  console.log("[useAppEvents:addCompletionInsight] TRACE: Before agentInsights.value assignment");
  agentInsights.value = [newInsight, ...agentInsights.value.slice(0, 4)];
  console.log("[useAppEvents:addCompletionInsight] TRACE: After agentInsights.value assignment");
  console.log("[useAppEvents:addCompletionInsight] TRACE: END");
}

function handleTaskFailed(task: TaskData): void {
  console.log("[useAppEvents:handleTaskFailed] TRACE: START", task.id);
  queueMicrotask(() => {
    console.log("[useAppEvents:handleTaskFailed] TRACE: In microtask");
    const failedAgent = activeAgents.value.find((a) => a.id === task.id);
    batch(() => {
      console.log("[useAppEvents:handleTaskFailed] TRACE: In batch");
      console.log("[useAppEvents:handleTaskFailed] TRACE: Before activeAgents.value assignment");
      activeAgents.value = activeAgents.value.filter((a) => a.id !== task.id);
      console.log("[useAppEvents:handleTaskFailed] TRACE: After activeAgents.value assignment");
      console.log("[useAppEvents:handleTaskFailed] TRACE: Before agentStatus.value assignment");
      agentStatus.value = {
        ...agentStatus.value,
        runningCount: Math.max(0, agentStatus.value.runningCount - 1),
      };
      console.log("[useAppEvents:handleTaskFailed] TRACE: After agentStatus.value assignment");

      if (failedAgent) {
        console.log(
          "[useAppEvents:handleTaskFailed] TRACE: Before recentActivity.value assignment",
        );
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
        console.log("[useAppEvents:handleTaskFailed] TRACE: After recentActivity.value assignment");
      }
    });
    console.log("[useAppEvents:handleTaskFailed] TRACE: After batch");
    new Notice(`Agent failed: ${task.error || "Unknown error"}`);
  });
  console.log("[useAppEvents:handleTaskFailed] TRACE: END (microtask queued)");
}

function handleTaskCancelled(task: TaskData): void {
  console.log("[useAppEvents:handleTaskCancelled] TRACE: START", task.id);
  queueMicrotask(() => {
    console.log("[useAppEvents:handleTaskCancelled] TRACE: In microtask");
    const agent = activeAgents.value.find((a) => a.id === task.id);
    const wasRunning = agent?.status === "running";
    batch(() => {
      console.log("[useAppEvents:handleTaskCancelled] TRACE: In batch");
      console.log("[useAppEvents:handleTaskCancelled] TRACE: Before activeAgents.value assignment");
      activeAgents.value = activeAgents.value.filter((a) => a.id !== task.id);
      console.log("[useAppEvents:handleTaskCancelled] TRACE: After activeAgents.value assignment");
      if (wasRunning) {
        console.log(
          "[useAppEvents:handleTaskCancelled] TRACE: Before agentStatus.value assignment",
        );
        agentStatus.value = {
          ...agentStatus.value,
          runningCount: Math.max(0, agentStatus.value.runningCount - 1),
        };
        console.log("[useAppEvents:handleTaskCancelled] TRACE: After agentStatus.value assignment");
      }
    });
    console.log("[useAppEvents:handleTaskCancelled] TRACE: After batch");
  });
  console.log("[useAppEvents:handleTaskCancelled] TRACE: END (microtask queued)");
}

function handleTaskQueued(task: TaskData): void {
  console.log("[useAppEvents:handleTaskQueued] TRACE: START", task.id);
  queueMicrotask(() => {
    console.log("[useAppEvents:handleTaskQueued] TRACE: In microtask");
    if (activeAgents.value.some((a) => a.id === task.id)) {
      console.log("[useAppEvents:handleTaskQueued] TRACE: Agent already exists, skipping");
      return;
    }
    console.log("[useAppEvents:handleTaskQueued] TRACE: Before activeAgents.value assignment");
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
    console.log("[useAppEvents:handleTaskQueued] TRACE: After activeAgents.value assignment");
  });
  console.log("[useAppEvents:handleTaskQueued] TRACE: END (microtask queued)");
}
