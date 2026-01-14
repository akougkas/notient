import { batch, useComputed } from "@preact/signals";
import { Notice } from "obsidian";
import { useEffect } from "preact/hooks";
import type { AgentEvent, AgentOutput, AgentType } from "../../../core/agents/types";
import { useKernel } from "../../../main";
import {
  activeAgents,
  activeView,
  agentInsights,
  agentStatus,
  pendingActionSources,
  pendingActions,
  recentActivity,
} from "../signals";
import type { ActiveAgent, AgentResultData, VitalsHint } from "../types";

interface UseAppEventsOptions {
  chatService: any;
  createChatService: () => Promise<void>;
}

export function useAppEvents({ chatService, createChatService }: UseAppEventsOptions): void {
  const kernel = useKernel();

  // Helper for registering event listeners
  function useEventBus<T>(event: string, handler: (data: T) => void) {
    useEffect(() => {
      const unsub = kernel.eventBus.on(event, handler);
      return () => unsub();
    }, [event, handler, kernel.eventBus]);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 1. SYSTEM LIFECYCLE EVENTS
  // ──────────────────────────────────────────────────────────────────────────

  useEventBus("services:initialized", () => {
    // Refresh chat service when kernel re-initializes
    createChatService();
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
  const handleTaskRunning = (task: any) => {
    batch(() => {
      // Add or update active agent
      const existing = activeAgents.value.find((a) => a.id === task.id);
      if (existing) {
        // Update progress
        activeAgents.value = activeAgents.value.map((a) =>
          a.id === task.id ? { ...a, status: "running", progress: task.progress, activeSkill: task.activeSkill } : a,
        );
      } else {
        // Add new agent
        const newAgent: ActiveAgent = {
          id: task.id,
          type: task.agentType,
          targetNote: task.targetNote || "Unknown Note",
          status: "running",
          progress: task.progress || 0,
          startedAt: new Date(),
          activeSkill: task.activeSkill, // From task object
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

  const handleTaskCompleted = (task: any) => {
    batch(() => {
      // Move from active to completed state (keep in list until dismissed)
      activeAgents.value = activeAgents.value.map((a) =>
        a.id === task.id
          ? {
              ...a,
              status: "completed",
              progress: 100,
              completedAt: new Date(),
              resultData: task.result ? {
                content: "Task completed", // Placeholder if not structured
                structured: task.result,
                insightSummary: task.result?.contextSummary || "Task completed successfully"
              } : undefined
            }
          : a,
      );

      // Add to recent activity log
      recentActivity.value = [
        {
          id: task.id,
          status: "success",
          actionType: task.agentType,
          targetNote: task.targetNote || "Unknown",
          summary: "Task completed successfully",
          completedAt: new Date(),
          canUndo: false,
        },
        ...recentActivity.value.slice(0, 19), // Keep last 20
      ];

      // Update stats
      agentStatus.value = {
        ...agentStatus.value,
        runningCount: Math.max(0, agentStatus.value.runningCount - 1),
        completedCount: agentStatus.value.completedCount + 1,
      };
    });
  };

  const handleTaskFailed = (task: any) => {
    batch(() => {
      // Remove from active agents
      activeAgents.value = activeAgents.value.filter((a) => a.id !== task.id);

      // Add to recent activity as failure
      recentActivity.value = [
        {
          id: task.id,
          status: "failed",
          actionType: task.agentType,
          targetNote: task.targetNote || "Unknown",
          summary: task.error || "Task failed",
          completedAt: new Date(),
          canUndo: false,
          error: task.error,
        },
        ...recentActivity.value.slice(0, 19),
      ];

      // Update stats
      agentStatus.value = {
        ...agentStatus.value,
        runningCount: Math.max(0, agentStatus.value.runningCount - 1),
        failedCount: agentStatus.value.failedCount + 1,
      };
      
      new Notice(`Agent failed: ${task.error || "Unknown error"}`);
    });
  };

  const handleTaskCancelled = (task: any) => {
    batch(() => {
      activeAgents.value = activeAgents.value.filter((a) => a.id !== task.id);
      agentStatus.value = {
        ...agentStatus.value,
        runningCount: Math.max(0, agentStatus.value.runningCount - 1),
      };
    });
  };

  const handleTaskQueued = (task: any) => {
    // Optional: show queued items in UI if we want
    // For now, we only show running items to reduce noise
  };

  // Agent task updates - dispatch to handlers
  useEventBus("agent:task-update", (data: any) => {
    const task = data.task;
    if (!task || task.taskType === "chat") {
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

  useEventBus("action:applied", (data: any) => {
    const { actionId, result } = data;
    
    batch(() => {
      // Remove from pending
      pendingActions.value = pendingActions.value.filter(a => a.id !== actionId);
      
      // Update pending count
      agentStatus.value = {
        ...agentStatus.value,
        pendingReviewCount: Math.max(0, agentStatus.value.pendingReviewCount - 1)
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
        ...recentActivity.value.slice(0, 19)
      ];
    });
    
    new Notice("Action applied successfully");
  });

  useEventBus("action:undone", (data: any) => {
    const { actionId } = data;
    
    batch(() => {
      // Mark recent activity as undone
      recentActivity.value = recentActivity.value.map(a => 
        a.id === actionId ? { ...a, status: "undone", canUndo: false } : a
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
  useEventBus("insight:created", (data: any) => {
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
}
