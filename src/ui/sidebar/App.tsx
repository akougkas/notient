/**
 * Root Preact component for Notient Sidebar v2
 *
 * Structure:
 * - Header: Tabs for Note | Agents | Chat
 * - Content: View-specific content based on active tab
 * - Footer: Three-zone status (Providers | Index | Agents)
 */

import { Notice, setIcon } from "obsidian";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AgentTaskQueue } from "../../core/agent";
import type { ActionApplier, ActionHistory, WorkflowRunner } from "../../core/agentic";
import { type ActivityPhase, ChatService, type ChatStatistics } from "../../core/chat";
import { InsightGenerator } from "../../services/insightGenerator";
import type { SearchResult } from "../../types/search";
import type { InitializationContext, InitializationState } from "../../types/services";
import { IndexDashboardModal } from "../modals/IndexDashboardModal";
import { ModelSelectorModal } from "../modals/ModelSelectorModal";
import { type AgentResultData, AgentStreamsView } from "./components/AgentStreamsView";
import { InsightStream } from "./components/InsightStream";
import { NavDeck } from "./components/NavDeck";
import { NoteCard } from "./components/NoteCard";
import { Omnibar } from "./components/Omnibar";
import { QuickActions, createNoteQuickActions } from "./components/QuickActions";
import { SystemDashboard } from "./components/SystemDashboard";
import { VitalsCards } from "./components/VitalsCards";
import { type RichChatMessage, RichChatView, createActivityItem } from "./components/chat";
import { useApp, useEventBus, useKernel, useService } from "./context/KernelContext";
import { useBacklinkPreview, useNoteVitals } from "./hooks/useNoteVitals";

// Import centralized state
import {
  activeAgents,
  activeView,
  agentInsights,
  agentStatus,
  chatActivities,
  chatContext,
  chatMessages,
  chatStreamingContent,
  chatStreamingThinking,
  indexStatus,
  initContext,
  initState,
  isChatStreaming,
  isChatThinking,
  isServicesReady,
  pendingActions,
  providerStatus,
  recentActivity,
  searchQuery,
  searchResults,
} from "./state";

export function App() {
  const kernel = useKernel();
  const app = useApp();
  const { noteVitals, isLoading } = useNoteVitals();
  const backlinkPreview = useBacklinkPreview();
  const taskQueue = useService<AgentTaskQueue>("taskQueue");
  const actionApplier = useService<ActionApplier>("actionApplier");
  const actionHistory = useService<ActionHistory>("actionHistory");
  const workflowRunner = useService<WorkflowRunner>("workflowRunner");

  // Create ChatService instance - needs state + effect since LLM may not be available initially
  const [chatService, setChatService] = useState<ChatService | null>(null);

  // Helper to create ChatService when LLM is available
  const createChatService = useCallback(() => {
    const llm = kernel.getService("llmProvider");
    if (llm) {
      const service = new ChatService(llm, undefined, {
        modelName: (llm as any).model || "unknown",
        contextWindowMax: 8192,
        thinkingConfig: {
          startTag: "<think>",
          endTag: "</think>",
          checkReasoningField: true,
        },
        delegationKeywords: {
          edit: ["edit", "improve", "enhance", "fix", "restructure", "rewrite"],
          classify: ["classify", "categorize", "organize", "para", "move to", "tag as"],
          link: ["link", "connect", "related", "similar", "connections", "find notes"],
        },
      });
      setChatService(service);
      return service;
    }
    return null;
  }, [kernel]);

  // Create ChatService on mount if services already initialized
  useEffect(() => {
    if (kernel.isServicesInitialized && !chatService) {
      createChatService();
    }
  }, [kernel.isServicesInitialized, chatService, createChatService]);

  // Initialize signal with current kernel state on mount
  useEffect(() => {
    isServicesReady.value = kernel.isServicesInitialized;
  }, [kernel]);

  // Sync chat context with current note
  useEffect(() => {
    if (noteVitals.value) {
      chatContext.value = {
        notePath: noteVitals.value.path,
        noteTitle: noteVitals.value.title,
      };
    }
  }, [noteVitals.value?.path]);

  // Subscribe to services:initialized event
  useEventBus("services:initialized", () => {
    isServicesReady.value = true;
    // Create ChatService now that services are available
    if (!chatService) {
      createChatService();
    }
  });

  // Subscribe to initialization state changes
  useEventBus("init:state-changed", (data) => {
    initState.value = data.currentState;
    initContext.value = data.context;

    // Update isServicesReady based on state machine
    const isOperational = data.currentState === "READY" || data.currentState === "DEGRADED";
    isServicesReady.value = isOperational;
  });

  // Subscribe to provider health events
  useEventBus("health:changed", (data) => {
    const isHealthy = data.health.status === "healthy";
    const modelName = (data.health.details?.model as string) || null;

    if (data.service === "lmstudio") {
      providerStatus.value = {
        ...providerStatus.value,
        lmstudio: { connected: isHealthy, model: modelName },
      };
      // Try to create ChatService when LM Studio becomes healthy
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

  // Subscribe to index events
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

  // Subscribe to agent/workflow events for AgentStreamsView
  useEventBus("workflow:started", (data) => {
    const workflow = data.workflow;
    agentStatus.value = {
      ...agentStatus.value,
      runningCount: agentStatus.value.runningCount + 1,
    };
    // Add to active agents
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
    // Update progress for active agent
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
    // Remove from active agents
    activeAgents.value = activeAgents.value.filter((a) => a.id !== workflow.id);
    // Add to recent activity if we had the agent tracked
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
        ...recentActivity.value.slice(0, 9),
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
    // Remove from active agents
    activeAgents.value = activeAgents.value.filter((a) => a.id !== workflow.id);
    // Add to recent activity with error
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
        ...recentActivity.value.slice(0, 9),
      ];
    }
  });

  useEventBus("workflow:cancelled", (data) => {
    const workflow = data.workflow;
    agentStatus.value = {
      ...agentStatus.value,
      runningCount: Math.max(0, agentStatus.value.runningCount - 1),
    };
    // Remove from active agents
    activeAgents.value = activeAgents.value.filter((a) => a.id !== workflow.id);
  });

  // Subscribe to action proposed events
  useEventBus("action:proposed", (data) => {
    const action = data.action;
    agentStatus.value = {
      ...agentStatus.value,
      pendingReviewCount: agentStatus.value.pendingReviewCount + 1,
    };
    // Add to pending actions
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
    // Remove from pending actions
    pendingActions.value = pendingActions.value.filter((a) => a.id !== record.action.id);
    // Add to recent activity
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
      ...recentActivity.value.slice(0, 9),
    ];
  });

  useEventBus("action:undone", (data) => {
    // Update recent activity to show undone status
    recentActivity.value = recentActivity.value.map((a) =>
      a.id === data.recordId ? { ...a, status: "undone" as const, canUndo: false } : a,
    );
  });

  // Subscribe to agent task updates
  useEventBus("agent:task-update", (data) => {
    const task = data.task;

    // Check if this is an agentic task (has taskType like link, enrich, classify)
    const isAgenticTask = task.taskType && task.taskType !== "chat";

    if (isAgenticTask) {
      // Update Agent Streams view for agentic tasks
      switch (task.status) {
        case "running":
          // Update progress in active agents
          activeAgents.value = activeAgents.value.map((agent) =>
            agent.id === task.id ? { ...agent, progress: task.progress || 0 } : agent,
          );
          break;

        case "completed": {
          // Find the agent and update with results (keep in activeAgents as "completed")
          const agent = activeAgents.value.find((a) => a.id === task.id);

          if (agent) {
            // Extract content from result
            const resultContent =
              typeof task.result?.data === "string"
                ? task.result.data
                : JSON.stringify(task.result?.data || {}, null, 2);

            // Create a one-liner insight summary from the result
            const insightSummary =
              resultContent.length > 100
                ? resultContent.slice(0, 100).trim() + "..."
                : resultContent;

            // Calculate duration
            const durationMs = agent.startedAt ? Date.now() - agent.startedAt.getTime() : 0;

            // Build result data for "View Results" modal
            const resultData: AgentResultData = {
              content: resultContent,
              structured: task.result?.data,
              citations: task.result?.citations,
              insightSummary,
              stats: { durationMs },
            };

            // Update agent to completed state with results
            activeAgents.value = activeAgents.value.map((a) =>
              a.id === task.id
                ? {
                    ...a,
                    status: "completed" as const,
                    completedAt: new Date(),
                    progress: 100,
                    resultData,
                  }
                : a,
            );

            // Decrease running count
            agentStatus.value = {
              ...agentStatus.value,
              runningCount: Math.max(0, agentStatus.value.runningCount - 1),
            };

            // Add proposed actions to pending if any
            if (task.result?.actions && task.result.actions.length > 0) {
              const newPendingActions = task.result.actions.map((action) => ({
                id: action.id,
                actionType: action.type,
                targetNote: agent.targetNote,
                summary: action.title,
                riskLevel: action.risk,
              }));
              pendingActions.value = [...pendingActions.value, ...newPendingActions];
              agentStatus.value = {
                ...agentStatus.value,
                pendingReviewCount: agentStatus.value.pendingReviewCount + newPendingActions.length,
              };
            }

            // Create insight for Vitals InsightStream
            const actionLabels: Record<string, string> = {
              link: "Found connections",
              enrich: "Enrichment ready",
              classify: "Classification complete",
              analyze: "Analysis complete",
            };

            const newInsight: import("../../services/insightGenerator").Insight = {
              text: `${actionLabels[task.taskType || "agent"] || "Agent result"}: ${insightSummary}`,
              action: "View in Agents",
              actionIcon: "bot",
              actionCallback: () => {
                activeView.value = "agents";
              },
              priority: "high",
            };
            agentInsights.value = [newInsight, ...agentInsights.value.slice(0, 4)];
          }

          new Notice(`${task.taskType || "Agent"} completed`);
          break;
        }

        case "failed": {
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
              ...recentActivity.value.slice(0, 9),
            ];
          }
          new Notice(`Agent failed: ${task.error || "Unknown error"}`);
          break;
        }

        case "cancelled": {
          activeAgents.value = activeAgents.value.filter((a) => a.id !== task.id);
          agentStatus.value = {
            ...agentStatus.value,
            runningCount: Math.max(0, agentStatus.value.runningCount - 1),
          };
          break;
        }
      }
    }
  });

  // Callback for agentic quick actions - routes through ChiefOfStaff with proper taskType
  const triggerAgenticAction = useCallback(
    (prompt: string, taskType: "link" | "enrich" | "classify" | "analyze") => {
      if (taskQueue && noteVitals.value) {
        try {
          const taskId = taskQueue.enqueue({
            agent: "chat", // Legacy field
            taskType, // This triggers proper routing in ChiefOfStaff
            notePath: noteVitals.value.path,
            noteTitle: noteVitals.value.title,
            chatHistory: [{ role: "user", content: prompt }],
          });

          // Add to active agents for Agent Streams view
          const actionLabels: Record<string, string> = {
            link: "Link Finder",
            enrich: "Note Editor",
            classify: "Classifier",
            analyze: "Context Builder",
          };

          activeAgents.value = [
            ...activeAgents.value,
            {
              id: taskId,
              type: actionLabels[taskType] || taskType,
              targetNote: noteVitals.value.title,
              status: "running",
              progress: 0,
              startedAt: new Date(),
            },
          ];

          agentStatus.value = {
            ...agentStatus.value,
            runningCount: agentStatus.value.runningCount + 1,
          };

          // Switch to agents view to show progress
          activeView.value = "agents";
          new Notice(`${actionLabels[taskType]} started`);
        } catch (err) {
          new Notice(err instanceof Error ? err.message : "Failed to start agent");
        }
      } else {
        new Notice("Agent system not available");
      }
    },
    [taskQueue, noteVitals],
  );

  // Callback for conversational chat - sends to chat tab directly
  const prefillChatAndSwitch = useCallback(
    (prompt: string) => {
      if (taskQueue && noteVitals.value) {
        try {
          taskQueue.enqueue({
            agent: "chat",
            notePath: noteVitals.value.path,
            noteTitle: noteVitals.value.title,
            chatHistory: [{ role: "user", content: prompt }],
          });
          // Switch to chat view
          activeView.value = "chat";
          new Notice("Sent to chat");
        } catch (err) {
          new Notice(err instanceof Error ? err.message : "Failed to send to chat");
        }
      } else {
        new Notice("Agent system not available");
      }
    },
    [taskQueue, noteVitals],
  );

  // Callback for opening files
  const openFile = useCallback(
    async (path: string) => {
      await kernel.obsidian.openFile(path);
    },
    [kernel.obsidian],
  );

  // Handler for rich chat messages (uses new ChatService)
  const handleRichChatSend = useCallback(
    async (message: string) => {
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
        const content = (await kernel.obsidian.readFileByPath(noteVitals.value.path)) || "";
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
      const startTime = Date.now();

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
    },
    [chatService, noteVitals, kernel.obsidian],
  );

  // Generate insights using InsightGenerator
  const insightGenerator = useMemo(
    () =>
      new InsightGenerator({
        prefillChatAndSwitch,
        onMetricClick: (metric) => {
          if (noteVitals.value) {
            const prompts: Record<string, string> = {
              health: `Analyze the health of my note "${noteVitals.value.title}" and suggest improvements`,
              links: `Show me all the connections for "${noteVitals.value.title}" and suggest new links`,
              freshness: `What has changed in "${noteVitals.value.title}" and what should I review?`,
            };
            prefillChatAndSwitch(prompts[metric]);
          }
        },
        showNotice: (msg) => new Notice(msg),
      }),
    [prefillChatAndSwitch, noteVitals],
  );

  // Static insights from note vitals analysis
  const staticInsights = useMemo(
    () => insightGenerator.generate(noteVitals.value),
    [insightGenerator, noteVitals.value],
  );

  // Merge agent insights (dynamic) with static insights
  // Agent insights appear first as they're more actionable
  const insights = useMemo(() => [...agentInsights.value, ...staticInsights], [staticInsights]);

  // Quick actions for current note
  const quickActions = useMemo(
    () =>
      createNoteQuickActions(noteVitals.value?.title || "this note", {
        triggerAgent: triggerAgenticAction,
        sendToChat: prefillChatAndSwitch,
      }),
    [noteVitals.value?.title, triggerAgenticAction, prefillChatAndSwitch],
  );

  const isReady = isServicesReady.value;
  const hasNote = noteVitals.value !== null;
  const currentView = activeView.value;

  // Modal open handlers - use Obsidian native modals
  const openModelSelector = useCallback(() => {
    const currentModel = providerStatus.value.lmstudio.model || providerStatus.value.ollama.model;
    new ModelSelectorModal(app, kernel, currentModel).open();
  }, [app, kernel]);

  const openIndexDashboard = useCallback(() => {
    new IndexDashboardModal(app, kernel, indexStatus.value).open();
  }, [app, kernel]);

  return (
    <div class="nv2-app">
      {/* Top: System Dashboard (Status & Settings) */}
      <SystemDashboard
        providers={providerStatus}
        index={indexStatus}
        onModelClick={openModelSelector}
        onIndexClick={openIndexDashboard}
        onSettingsClick={() => {
          // Open Notient settings tab
          const setting = (app as any).setting;
          if (setting) {
            setting.open();
            setting.openTabById("notient");
          }
        }}
      />

      {/* Content - View Specific */}
      <div class="nv2-content" key={currentView}>
        {!isReady ? (
          <InitializationStateView state={initState.value} context={initContext.value} />
        ) : currentView === "note" ? (
          // Note Vitals View - 4 sections: Identity, Vitals, Actions, Insights
          <>
            {/* Omnibar for vault-wide search */}
            <Omnibar
              placeholder="Search notes..."
              onResults={(results, query) => {
                searchResults.value = results;
                searchQuery.value = query;
              }}
            />
            {/* Search Results (when available) */}
            {searchResults.value.length > 0 && (
              <SearchResultsView
                results={searchResults.value}
                query={searchQuery.value}
                onOpenNote={openFile}
                onClear={() => {
                  searchResults.value = [];
                  searchQuery.value = "";
                }}
              />
            )}
            {/* Note content (hidden when search results shown) */}
            {searchResults.value.length === 0 &&
              (isLoading.value ? (
                <NoteVitalsSkeleton />
              ) : hasNote ? (
                <>
                  {/* Section 1: Note Identity */}
                  <NoteCard noteVitals={noteVitals.value!} backlinkPreview={backlinkPreview} />
                  {/* Section 2: Vitals Cards (4 metrics) */}
                  <VitalsCards
                    vitals={noteVitals.value!}
                    onCardClick={(metric) => {
                      const prompts: Record<string, string> = {
                        health: `Analyze the health of "${noteVitals.value!.title}" and suggest improvements`,
                        links: `Show me connections for "${noteVitals.value!.title}" and suggest new links`,
                        freshness: `What has changed in "${noteVitals.value!.title}" recently?`,
                        grade: `How can I improve the quality grade of "${noteVitals.value!.title}"?`,
                      };
                      prefillChatAndSwitch(prompts[metric]);
                    }}
                  />
                  {/* Section 3: Quick Actions */}
                  <QuickActions actions={quickActions} />
                  {/* Section 4: AI Insights */}
                  <InsightStream insights={insights} onOpenFile={openFile} />
                </>
              ) : (
                <EmptyState />
              ))}
          </>
        ) : currentView === "agents" ? (
          // Agent Streams View
          <AgentStreamsView
            activeAgents={activeAgents}
            pendingActions={pendingActions}
            recentActivity={recentActivity}
            onPauseAgent={(id) => {
              // Toggle pause state in UI (pause/resume not yet supported by WorkflowRunner)
              activeAgents.value = activeAgents.value.map((a) =>
                a.id === id ? { ...a, status: a.status === "paused" ? "running" : "paused" } : a,
              );
              const isPaused = activeAgents.value.find((a) => a.id === id)?.status === "paused";
              new Notice(isPaused ? "Agent paused" : "Agent resumed");
            }}
            onStopAgent={(id) => {
              if (workflowRunner) {
                workflowRunner.cancel(id);
              }
              // Remove from active agents
              activeAgents.value = activeAgents.value.filter((a) => a.id !== id);
              agentStatus.value = {
                ...agentStatus.value,
                runningCount: Math.max(0, agentStatus.value.runningCount - 1),
              };
              new Notice("Agent stopped");
            }}
            onApplyAction={(id) => {
              const action = pendingActions.value.find((a) => a.id === id);
              if (!action) return;

              // Emit event for kernel to handle the actual apply
              kernel.eventBus.emit("action:apply-requested", { actionId: id });

              // Optimistically move to recent activity
              recentActivity.value = [
                {
                  id: `activity-${Date.now()}`,
                  status: "success",
                  actionType: action.actionType,
                  targetNote: action.targetNote,
                  summary: action.summary,
                  completedAt: new Date(),
                  canUndo: true,
                },
                ...recentActivity.value.slice(0, 9),
              ];
              // Remove from pending
              pendingActions.value = pendingActions.value.filter((a) => a.id !== id);
              agentStatus.value = {
                ...agentStatus.value,
                pendingReviewCount: Math.max(0, agentStatus.value.pendingReviewCount - 1),
              };
              new Notice(`Applied: ${action.summary}`);
            }}
            onDismissAction={(id) => {
              // Remove from pending
              pendingActions.value = pendingActions.value.filter((a) => a.id !== id);
              agentStatus.value = {
                ...agentStatus.value,
                pendingReviewCount: Math.max(0, agentStatus.value.pendingReviewCount - 1),
              };
            }}
            onUndoAction={(id) => {
              const activity = recentActivity.value.find((a) => a.id === id);
              if (!activity || !activity.canUndo) return;

              // Emit event for kernel to handle the actual undo
              kernel.eventBus.emit("action:undo-requested", { actionId: id });

              // Optimistically update UI
              recentActivity.value = recentActivity.value.map((a) =>
                a.id === id ? { ...a, status: "undone", canUndo: false } : a,
              );
              new Notice(`Undone: ${activity.summary}`);
            }}
            onViewResults={(agent) => {
              // Open modal with agent results
              if (agent.resultData) {
                // Use Obsidian's native modal
                const content = agent.resultData.content;
                const stats = agent.resultData.stats;
                const citations = agent.resultData.citations;

                // Create a formatted message for the modal
                let message = `## ${agent.type} Results\n\n`;
                message += `**Target:** ${agent.targetNote}\n\n`;
                if (stats?.durationMs) {
                  message += `**Duration:** ${(stats.durationMs / 1000).toFixed(1)}s\n\n`;
                }
                message += `---\n\n${content}`;
                if (citations && citations.length > 0) {
                  message += `\n\n**Related Notes:**\n${citations.map((c) => `- [[${c}]]`).join("\n")}`;
                }

                // For now, show in a Notice (TODO: proper modal)
                new Notice(`${agent.type} completed. Results available.`);
                console.log("[AgentResults]", message);
              }
            }}
            onDismissAgent={(id) => {
              // Remove completed agent from the list
              activeAgents.value = activeAgents.value.filter((a) => a.id !== id);
            }}
          />
        ) : (
          // Chat View
          <RichChatView
            context={chatContext}
            messages={chatMessages}
            isStreaming={isChatStreaming}
            streamingContent={chatStreamingContent}
            streamingThinking={chatStreamingThinking}
            isThinking={isChatThinking}
            activities={chatActivities}
            onSendMessage={handleRichChatSend}
            onClearContext={() => {
              chatContext.value = { notePath: null, noteTitle: null };
              chatMessages.value = [];
            }}
            onOpenNote={(path) => {
              kernel.obsidian.openFile(path);
            }}
            showStats={true}
          />
        )}
      </div>

      {/* Bottom: Navigation Deck (View Switcher) */}
      <NavDeck activeView={activeView} agentStatus={agentStatus} />
    </div>
  );
}

function LoadingState({ message }: { message: string }) {
  return (
    <div class="nv2-loading" role="status" aria-live="polite">
      <div class="nv2-loading-spinner" aria-hidden="true" />
      <div class="nv2-loading-text">{message}</div>
    </div>
  );
}

/**
 * Displays initialization state with appropriate messaging for each state
 */
function InitializationStateView({
  state,
  context,
}: {
  state: InitializationState;
  context: InitializationContext | null;
}) {
  const getStateDisplay = (): {
    icon: string;
    title: string;
    message: string;
    isError: boolean;
  } => {
    switch (state) {
      case "UNINITIALIZED":
        return {
          icon: "hourglass",
          title: "Starting Up",
          message: "Preparing Notient...",
          isError: false,
        };
      case "CHECKING_PROVIDERS":
        return {
          icon: "hourglass",
          title: "Connecting",
          message: context?.progress?.message || "Checking Ollama and LM Studio connections...",
          isError: false,
        };
      case "LOADING_INDEX":
        return {
          icon: "hourglass",
          title: "Loading Index",
          message: context?.progress
            ? `${context.progress.message} (${context.progress.percent}%)`
            : "Loading vector index...",
          isError: false,
        };
      case "WARMING_SERVICES":
        return {
          icon: "hourglass",
          title: "Almost Ready",
          message: context?.progress?.message || "Warming up services...",
          isError: false,
        };
      case "DEGRADED":
        return {
          icon: "alert-triangle",
          title: "Limited Mode",
          message: getDegradedMessage(context?.degradedReason),
          isError: false,
        };
      case "FAILED":
        return {
          icon: "x-circle",
          title: "Connection Failed",
          message: context?.errorMessage || getFailedMessage(context?.failedReason),
          isError: true,
        };
      case "CRASHED":
        return {
          icon: "alert-octagon",
          title: "Recovery Needed",
          message: context?.errorMessage || getCrashedMessage(context?.crashedReason),
          isError: true,
        };
      case "READY":
        // Should not typically display this (isReady = true bypasses this component)
        return {
          icon: "check-circle",
          title: "Ready",
          message: "Notient is ready to use.",
          isError: false,
        };
      default:
        return {
          icon: "hourglass",
          title: "Initializing",
          message: "Please wait...",
          isError: false,
        };
    }
  };

  const display = getStateDisplay();
  const showSpinner = !display.isError && state !== "READY";

  return (
    <div
      class={`nv2-init-state ${display.isError ? "nv2-init-state--error" : ""}`}
      role="status"
      aria-live="polite"
    >
      {showSpinner && <div class="nv2-loading-spinner" aria-hidden="true" />}
      {display.isError && (
        <div class="nv2-init-state-icon nv2-init-state-icon--error" aria-hidden="true">
          {display.icon === "x-circle" ? "!" : "!!"}
        </div>
      )}
      <div class="nv2-init-state-title">{display.title}</div>
      <div class="nv2-init-state-message">{display.message}</div>
      {context?.capabilities && (
        <div class="nv2-init-state-capabilities">
          {context.capabilities.search && (
            <span class="nv2-capability nv2-capability--active">Search</span>
          )}
          {context.capabilities.chat && (
            <span class="nv2-capability nv2-capability--active">Chat</span>
          )}
          {context.capabilities.indexing && (
            <span class="nv2-capability nv2-capability--active">Indexing</span>
          )}
        </div>
      )}
    </div>
  );
}

function getDegradedMessage(reason?: string): string {
  switch (reason) {
    case "lmstudio_down":
      return "LM Studio is not connected. Search works, but chat is unavailable.";
    case "index_stale":
      return "Index may be outdated. Consider rebuilding for best results.";
    case "embedding_mismatch":
      return "Embedding model changed. Rebuild index for accurate search.";
    case "partial_init":
      return "Some services failed to initialize. Limited functionality available.";
    default:
      return "Running with limited capabilities.";
  }
}

function getFailedMessage(reason?: string): string {
  switch (reason) {
    case "ollama_down":
      return "Cannot connect to Ollama. Please ensure Ollama is running.";
    case "missing_config":
      return "Missing configuration. Please check your settings.";
    case "connection_failed":
      return "Connection failed. Check that Ollama and LM Studio are running.";
    case "index_corrupt":
      return "Index appears corrupted. Try rebuilding from settings.";
    case "critical_error":
      return "A critical error occurred. Please restart Obsidian.";
    default:
      return "Initialization failed. Check settings and try again.";
  }
}

function getCrashedMessage(reason?: string): string {
  switch (reason) {
    case "indexing_interrupted":
      return "Indexing was interrupted. Resume or rebuild the index.";
    case "recovery_needed":
      return "Recovery is needed. Try reopening Obsidian.";
    default:
      return "An unexpected error occurred. Restart may be required.";
  }
}

// Skeleton loading for Note Vitals
function NoteVitalsSkeleton() {
  return (
    <div class="nv2-content" aria-busy="true" aria-label="Loading note vitals">
      {/* Note Identity skeleton */}
      <div class="nv2-section">
        <div class="nv2-skeleton nv2-skeleton-text nv2-skeleton-text--medium" />
        <div class="nv2-skeleton nv2-skeleton-text nv2-skeleton-text--short" />
      </div>
      {/* Vitals cards skeleton */}
      <div class="nv2-section">
        <div class="nv2-vitals-cards">
          <div class="nv2-skeleton nv2-skeleton-card" />
          <div class="nv2-skeleton nv2-skeleton-card" />
          <div class="nv2-skeleton nv2-skeleton-card" />
          <div class="nv2-skeleton nv2-skeleton-card" />
        </div>
      </div>
      {/* Quick actions skeleton */}
      <div class="nv2-section">
        <div class="nv2-skeleton nv2-skeleton-text nv2-skeleton-text--short" />
        <div class="nv2-quick-actions">
          <div class="nv2-skeleton" style={{ height: "54px" }} />
          <div class="nv2-skeleton" style={{ height: "54px" }} />
          <div class="nv2-skeleton" style={{ height: "54px" }} />
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  const iconRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (iconRef.current) {
      setIcon(iconRef.current, "file-text");
    }
  }, []);

  return (
    <div class="nv2-empty-state" role="status">
      <div class="nv2-empty-state-icon" ref={iconRef} aria-hidden="true" />
      <div class="nv2-empty-state-title">No Note Open</div>
      <div class="nv2-empty-state-text">
        Open a markdown file to see its vitals and work with the AI assistant.
      </div>
    </div>
  );
}

/**
 * Display search results from the Omnibar
 */
function SearchResultsView({
  results,
  query,
  onOpenNote,
  onClear,
}: {
  results: SearchResult[];
  query: string;
  onOpenNote: (path: string) => void;
  onClear: () => void;
}) {
  return (
    <div class="nv2-search-results" role="region" aria-label="Search results">
      <div class="nv2-search-results-header">
        <span class="nv2-search-results-title">Results for "{query}"</span>
        <button
          type="button"
          class="nv2-search-results-clear"
          onClick={onClear}
          aria-label="Clear search results"
        >
          Clear
        </button>
      </div>
      {results.length === 0 ? (
        <div class="nv2-search-no-results">No notes found matching your query.</div>
      ) : (
        <div class="nv2-search-results-list">
          {results.map((result) => (
            <button
              key={result.path}
              type="button"
              class="nv2-search-result-item"
              onClick={() => onOpenNote(result.path)}
              aria-label={`Open note: ${result.title || result.path.split("/").pop()?.replace(".md", "") || result.path}`}
            >
              <div class="nv2-search-result-title">
                {result.title || result.path.split("/").pop()?.replace(".md", "") || result.path}
              </div>
              {result.chunks?.[0]?.text && (
                <div class="nv2-search-result-snippet">
                  {result.chunks[0].text.slice(0, 150)}...
                </div>
              )}
              <div class="nv2-search-result-meta">
                <span class="nv2-search-result-score">
                  {Math.round(result.bestScore * 100)}% match
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
