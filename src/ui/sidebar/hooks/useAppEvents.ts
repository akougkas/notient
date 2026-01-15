import { batch } from "@preact/signals";
import { Notice } from "obsidian";
import { useEffect } from "preact/hooks";
import type { AgentTask } from "../../../core/agent/types";
import type { VitalsHint } from "../../../services/insightGenerator";
import type {
  ActionAppliedEvent,
  ActionUndoneEvent,
  AgentTaskUpdateEvent,
  EventType,
  InsightCreatedEvent,
} from "../../../types/events";
import type { ActiveAgent, PendingAction, RecentActivity } from "../components/AgentStreamsView";
import { useKernel } from "../context/KernelContext";
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
  pendingActionSources,
  pendingActions,
  providerStatus,
  recentActivity,
  searchQuery,
  searchResults,
} from "../state";

interface UseAppEventsOptions {
  chatService: unknown;
  createChatService: () => unknown;
}

export function useAppEvents({ chatService, createChatService }: UseAppEventsOptions): void {
  const kernel = useKernel();

  // Helper for registering event listeners with typed events
  function useEventBus<T extends EventType>(
    event: T,
    handler: (data: import("../../../types/events").EventPayloads[T]) => void,
  ) {
    useEffect(() => {
      const unsub = kernel.eventBus.on(event, handler);
      return () => unsub();
    }, [event, handler]);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 1. SYSTEM LIFECYCLE EVENTS
  // ──────────────────────────────────────────────────────────────────────────

  useEventBus("services:initialized", async () => {
    // Refresh chat service when kernel re-initializes
    createChatService();

    // Populate provider status from kernel service health
    const health = kernel.serviceHealth;
    const ollamaService = kernel.getService("ollama");
    const ollamaModel = ollamaService?.getCapabilities()?.model || null;
    const lmstudioModel = kernel.settings.lmstudio?.reasoningModel || null;

    providerStatus.value = {
      ollama: {
        connected: health.ollama.status === "healthy",
        model: ollamaModel,
      },
      lmstudio: {
        connected: health.lmstudio.status === "healthy",
        model: lmstudioModel,
      },
    };

    // Populate index status
    const indexManager = kernel.getService("indexManager");
    if (indexManager) {
      const stats = await indexManager.getStats();
      indexStatus.value = {
        noteCount: stats.noteCount,
        lastSyncedAt: stats.lastFullIndexAt ? new Date(stats.lastFullIndexAt) : null,
        isIndexing: false,
      };
    }
  });

  // Init state machine events - update UI signals
  useEventBus("init:state-changed", (data) => {
    initState.value = data.currentState;
    initContext.value = data.context;

    // Enable content views when services are ready
    if (data.currentState === "READY") {
      isServicesReady.value = true;
    }
  });

  // H5: Indexing status signal wiring
  useEventBus("index:progress", (data) => {
    batch(() => {
      indexStatus.value = {
        ...indexStatus.value,
        isIndexing: true,
        noteCount: data.progress.completed,
      };
    });
  });

  useEventBus("index:complete", (data) => {
    batch(() => {
      indexStatus.value = {
        ...indexStatus.value,
        isIndexing: false,
        noteCount: data.totalIndexed,
        lastSyncedAt: new Date(),
      };
    });
  });

  useEventBus("index:error", () => {
    batch(() => {
      indexStatus.value = {
        ...indexStatus.value,
        isIndexing: false,
      };
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. CHAT EVENTS (Streaming)
  // ──────────────────────────────────────────────────────────────────────────

  // These are handled directly by ChatService and RichChatView via signals
  // We don't need to duplicate logic here, but we could add global notifications

  // ──────────────────────────────────────────────────────────────────────────
  // 3. AGENT TASK EVENTS (Background Agents)
  // ──────────────────────────────────────────────────────────────────────────

  // Handlers for specific task states
  const handleTaskRunning = (task: AgentTask) => {
    batch(() => {
      // Add or update active agent
      const existing = activeAgents.value.find((a: ActiveAgent) => a.id === task.id);
      if (existing) {
        // Update progress
        activeAgents.value = activeAgents.value.map((a: ActiveAgent) =>
          a.id === task.id ? { ...a, status: "running", progress: task.progress } : a,
        );
      } else {
        // Add new agent
        const newAgent: ActiveAgent = {
          id: task.id,
          type: task.agent,
          targetNote: task.noteTitle || "Unknown Note",
          status: "running",
          progress: task.progress || 0,
          startedAt: new Date(),
        };
        activeAgents.value = [...activeAgents.value, newAgent];

        // Update stats
        agentStatus.value = {
          ...agentStatus.value,
          runningCount: agentStatus.value.runningCount + 1,
        };
      }
    });
  };

  const handleTaskCompleted = (task: AgentTask) => {
    batch(() => {
      // Move from active to completed state (keep in list until dismissed)
      activeAgents.value = activeAgents.value.map((a: ActiveAgent) =>
        a.id === task.id
          ? {
              ...a,
              status: "completed",
              progress: 100,
              completedAt: new Date(),
              resultData: task.result
                ? {
                    content: "Task completed", // Placeholder if not structured
                    structured: task.result,
                    insightSummary: "Task completed successfully",
                  }
                : undefined,
            }
          : a,
      );

      // Add to recent activity log
      recentActivity.value = [
        {
          id: task.id,
          status: "success",
          actionType: task.agent,
          targetNote: task.noteTitle || "Unknown",
          summary: "Task completed successfully",
          completedAt: new Date(),
          canUndo: false,
        },
        ...recentActivity.value.slice(0, 19), // Keep last 20
      ];

      // Update stats (only decrement running count, completed tasks tracked in recent activity)
      agentStatus.value = {
        ...agentStatus.value,
        runningCount: Math.max(0, agentStatus.value.runningCount - 1),
      };
    });
  };

  const handleTaskFailed = (task: AgentTask) => {
    batch(() => {
      // Remove from active agents
      activeAgents.value = activeAgents.value.filter((a: ActiveAgent) => a.id !== task.id);

      // Add to recent activity as failure
      recentActivity.value = [
        {
          id: task.id,
          status: "failed",
          actionType: task.agent,
          targetNote: task.noteTitle || "Unknown",
          summary: task.error || "Task failed",
          completedAt: new Date(),
          canUndo: false,
          error: task.error,
        },
        ...recentActivity.value.slice(0, 19),
      ];

      // Update stats (only decrement running count, failures tracked in recent activity)
      agentStatus.value = {
        ...agentStatus.value,
        runningCount: Math.max(0, agentStatus.value.runningCount - 1),
      };

      new Notice(`Agent failed: ${task.error || "Unknown error"}`);
    });
  };

  const handleTaskCancelled = (task: AgentTask) => {
    batch(() => {
      activeAgents.value = activeAgents.value.filter((a: ActiveAgent) => a.id !== task.id);
      agentStatus.value = {
        ...agentStatus.value,
        runningCount: Math.max(0, agentStatus.value.runningCount - 1),
      };
    });
  };

  const handleTaskQueued = (task: AgentTask) => {
    // Optional: show queued items in UI if we want
    // For now, we only show running items to reduce noise
  };

  // Agent task updates - dispatch to handlers
  useEventBus("agent:task-update", (data) => {
    const task = data.task;
    if (!task) {
      return;
    }

    // H4: Handle chat slash command result mirroring
    if (task.status === "completed" || task.status === "failed") {
      const messageId = chatSlashCommandTasks.value.get(task.id);
      if (messageId) {
        batch(() => {
          // Update placeholder message with result
          const resultContent =
            task.status === "failed"
              ? `Task failed: ${task.error || "Unknown error"}`
              : typeof task.result?.data === "string"
                ? task.result.data
                : `Task ${task.status}`;
          chatMessages.value = chatMessages.value.map((message) =>
            message.id === messageId ? { ...message, content: resultContent } : message,
          );
          // Clean up mapping
          const newMap = new Map(chatSlashCommandTasks.value);
          newMap.delete(task.id);
          chatSlashCommandTasks.value = newMap;
        });
      }
    }

    // Skip further processing for chat tasks (handled by ChatService)
    if (task.taskType === "chat") {
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

  // ──────────────────────────────────────────────────────────────────────────
  // 4. ACTION EVENTS (Apply / Undo)
  // ──────────────────────────────────────────────────────────────────────────

  useEventBus("action:applied", (data) => {
    const { record } = data;
    const actionId = record.action.id; // Use action.id, not record.id - pending uses action.id

    batch(() => {
      // Remove from pending
      pendingActions.value = pendingActions.value.filter((a: PendingAction) => a.id !== actionId);
      // Clean up pendingActionSources
      const updatedSources = new Map(pendingActionSources.value);
      updatedSources.delete(actionId);
      pendingActionSources.value = updatedSources;

      // Update pending count
      agentStatus.value = {
        ...agentStatus.value,
        pendingReviewCount: Math.max(0, agentStatus.value.pendingReviewCount - 1),
      };

      // Add to recent activity
      recentActivity.value = [
        {
          id: actionId,
          status: "success",
          actionType: "action", // Generic for applied action
          targetNote: "Applied Action", // Would be better if event had context
          summary: "Action applied successfully",
          completedAt: new Date(),
          canUndo: true,
        },
        ...recentActivity.value.slice(0, 19),
      ];
    });

    new Notice("Action applied successfully");
  });

  useEventBus("action:undone", (data) => {
    const { recordId } = data;

    batch(() => {
      // Mark recent activity as undone
      recentActivity.value = recentActivity.value.map((a: RecentActivity) =>
        a.id === recordId ? { ...a, status: "undone", canUndo: false } : a,
      );
    });

    new Notice("Action undone");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. INSIGHT EVENTS (Agent Outputs)
  // ──────────────────────────────────────────────────────────────────────────

  // Insight events - primary agent output flow (per ID-ARCHITECTURE-SPEC.md)
  // Agent returns → ChiefOfStaff/TaskQueue wraps in Insight container → emit insight:created
  // → UI extracts actions from Insight for pending review
  useEventBus("insight:created", (data) => {
    queueMicrotask(() => {
      const { insight } = data;

      batch(() => {
        // Extract actions from Insight for pending review
        for (const action of insight.actions) {
          agentStatus.value = {
            ...agentStatus.value,
            pendingReviewCount: agentStatus.value.pendingReviewCount + 1,
          };
          pendingActions.value = [
            ...pendingActions.value,
            {
              id: action.id,
              actionType: action.type,
              targetNote: insight.noteContext.title || action.target,
              summary: action.title,
              riskLevel: action.risk,
            },
          ];
          // Store original ProposedAction for when we need to apply it
          const updatedSources = new Map(pendingActionSources.value);
          updatedSources.set(action.id, action);
          pendingActionSources.value = updatedSources;
        }

        // Add insight summary to InsightStream UI as a VitalsHint
        if (insight.summary) {
          const newHint: VitalsHint = {
            text: `${insight.agentType}: ${insight.summary}`,
            action: "View Actions",
            actionIcon: "bot",
            actionCallback: () => {
              activeView.value = "agents";
            },
            priority: "high",
          };
          agentInsights.value = [newHint, ...agentInsights.value.slice(0, 4)];
        }
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. PROGRESSIVE SEARCH EVENTS
  // ──────────────────────────────────────────────────────────────────────────

  // Instant results from native Obsidian search (fast, first pass)
  useEventBus("search:progressive-instant", (data) => {
    // Only update if this matches the current query (avoid stale results)
    if (data.query === searchQuery.value) {
      searchResults.value = data.results;
    }
  });

  // Evolved results after semantic reranking (higher quality, replaces instant)
  useEventBus("search:progressive-evolving", (data) => {
    // Only update if this matches the current query (avoid stale results)
    if (data.query === searchQuery.value) {
      searchResults.value = data.results;
    }
  });
}
