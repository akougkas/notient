/**
 * Root Preact component for Notient Sidebar v2
 *
 * Structure:
 * - Header: System Dashboard (status & settings)
 * - Content: View-specific content based on active tab
 * - Footer: Navigation Deck (view switcher)
 */

import { Notice, setIcon } from "obsidian";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AgentTaskQueue } from "../../core/agent";
import type { ActionApplier, WorkflowRunner } from "../../core/agentic";
import { ChatService } from "../../core/chat";
import { InsightGenerator } from "../../services/insightGenerator";
import { IndexDashboardModal } from "../modals/IndexDashboardModal";
import { ModelSelectorModal } from "../modals/ModelSelectorModal";
import { AgentStreamsView } from "./components/AgentStreamsView";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { InitializationStateView } from "./components/InitializationStateView";
import { InsightStream } from "./components/InsightStream";
import { NavDeck } from "./components/NavDeck";
import { NoteCard } from "./components/NoteCard";
import { Omnibar } from "./components/Omnibar";
import { QuickActions, createNoteQuickActions } from "./components/QuickActions";
import { SearchResultsView } from "./components/SearchResultsView";
import { SystemDashboard } from "./components/SystemDashboard";
import { VitalsCards } from "./components/VitalsCards";
import { RichChatView } from "./components/chat";
import { useApp, useKernel, useService } from "./context/KernelContext";
import { useAppEvents } from "./hooks/useAppEvents";
import { useBacklinkPreview, useNoteVitals } from "./hooks/useNoteVitals";
import {
  handleChatAction,
  handleRichChatSend,
  prefillChatAndSwitch,
  triggerAgenticAction,
} from "./state/appHandlers";
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
  return (
    <ErrorBoundary name="App">
      <AppContent />
    </ErrorBoundary>
  );
}

function AppContent() {
  const kernel = useKernel();
  const app = useApp();
  const { noteVitals, isLoading } = useNoteVitals();
  const backlinkPreview = useBacklinkPreview();
  const taskQueue = useService<AgentTaskQueue>("taskQueue");
  const actionApplier = useService<ActionApplier>("actionApplier");
  const workflowRunner = useService<WorkflowRunner>("workflowRunner");

  // ChatService state
  const [chatService, setChatService] = useState<ChatService | null>(null);

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

  // Initialize services
  useEffect(() => {
    if (kernel.isServicesInitialized && !chatService) {
      createChatService();
    }
  }, [kernel.isServicesInitialized, chatService, createChatService]);

  useEffect(() => {
    isServicesReady.value = kernel.isServicesInitialized;
  }, [kernel]);

  useEffect(() => {
    if (noteVitals.value) {
      chatContext.value = {
        notePath: noteVitals.value.path,
        noteTitle: noteVitals.value.title,
      };
    }
  }, [noteVitals.value?.path]);

  // Subscribe to all system events
  useAppEvents({ chatService, createChatService });

  // Handler callbacks
  const onTriggerAgenticAction = useCallback(
    (prompt: string, taskType: "link" | "enrich" | "classify" | "analyze") => {
      triggerAgenticAction({ taskQueue, noteVitals }, prompt, taskType);
    },
    [taskQueue, noteVitals],
  );

  const onPrefillChatAndSwitch = useCallback(
    (prompt: string) => {
      prefillChatAndSwitch({ taskQueue, noteVitals }, prompt);
    },
    [taskQueue, noteVitals],
  );

  const onRichChatSend = useCallback(
    async (message: string) => {
      await handleRichChatSend(
        { chatService, noteVitals, obsidian: kernel.obsidian },
        message,
      );
    },
    [chatService, noteVitals, kernel.obsidian],
  );

  const openFile = useCallback(
    async (path: string) => {
      await kernel.obsidian.openFile(path);
    },
    [kernel.obsidian],
  );

  // Insights
  const insightGenerator = useMemo(
    () =>
      new InsightGenerator({
        triggerAgent: onTriggerAgenticAction,
        showNotice: (msg) => new Notice(msg),
      }),
    [onTriggerAgenticAction],
  );

  const staticInsights = useMemo(
    () => insightGenerator.generate(noteVitals.value),
    [insightGenerator, noteVitals.value],
  );

  const insights = useMemo(
    () => [...agentInsights.value, ...staticInsights],
    [staticInsights],
  );

  const quickActions = useMemo(
    () =>
      createNoteQuickActions(noteVitals.value?.title || "this note", {
        triggerAgent: onTriggerAgenticAction,
        sendToChat: onPrefillChatAndSwitch,
      }),
    [noteVitals.value?.title, onTriggerAgenticAction, onPrefillChatAndSwitch],
  );

  // Modal handlers
  const openModelSelector = useCallback(() => {
    const currentModel = providerStatus.value.lmstudio.model || providerStatus.value.ollama.model;
    new ModelSelectorModal(app, kernel, currentModel).open();
  }, [app, kernel]);

  const openIndexDashboard = useCallback(() => {
    new IndexDashboardModal(app, kernel, indexStatus.value).open();
  }, [app, kernel]);

  const isReady = isServicesReady.value;
  const hasNote = noteVitals.value !== null;
  const currentView = activeView.value;

  return (
    <div class="nv2-app">
      <SystemDashboard
        providers={providerStatus}
        index={indexStatus}
        onModelClick={openModelSelector}
        onIndexClick={openIndexDashboard}
        onSettingsClick={() => {
          const setting = (app as any).setting;
          if (setting) {
            setting.open();
            setting.openTabById("notient");
          }
        }}
      />

      <div class="nv2-content" key={currentView}>
        {!isReady ? (
          <InitializationStateView state={initState.value} context={initContext.value} />
        ) : currentView === "note" ? (
          <ErrorBoundary name="NoteVitals">
            <NoteVitalsContent
              noteVitals={noteVitals}
              isLoading={isLoading}
              hasNote={hasNote}
              backlinkPreview={backlinkPreview}
              quickActions={quickActions}
              insights={insights}
              openFile={openFile}
            />
          </ErrorBoundary>
        ) : currentView === "agents" ? (
          <ErrorBoundary name="AgentStreams">
            <AgentStreamsContent workflowRunner={workflowRunner} kernel={kernel} />
          </ErrorBoundary>
        ) : (
          <ErrorBoundary name="Chat">
            <ChatContent
              onRichChatSend={onRichChatSend}
              kernel={kernel}
              actionApplier={actionApplier}
            />
          </ErrorBoundary>
        )}
      </div>

      <NavDeck activeView={activeView} agentStatus={agentStatus} />
    </div>
  );
}

// Sub-components to keep AppContent clean

function NoteVitalsContent({
  noteVitals,
  isLoading,
  hasNote,
  backlinkPreview,
  quickActions,
  insights,
  openFile,
}: any) {
  return (
    <>
      <Omnibar
        placeholder="Search notes..."
        onResults={(results: any, query: string) => {
          searchResults.value = results;
          searchQuery.value = query;
        }}
        onResultSelect={(path: string) => {
          openFile(path);
          searchResults.value = [];
          searchQuery.value = "";
        }}
        onDeepSearchComplete={(results: any, query: string) => {
          const deepInsights = results.slice(0, 5).map((result: any) => ({
            text: `Deep search for "${query}": ${result.title}`,
            linkText: result.title,
            linkPath: result.path,
            priority: "high" as const,
          }));
          agentInsights.value = [...deepInsights, ...agentInsights.value.slice(0, 4)];
          if (activeView.value !== "note") {
            activeView.value = "note";
          }
        }}
      />
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
      {searchResults.value.length === 0 &&
        (isLoading.value ? (
          <NoteVitalsSkeleton />
        ) : hasNote ? (
          <>
            <NoteCard noteVitals={noteVitals.value!} backlinkPreview={backlinkPreview} />
            <VitalsCards vitals={noteVitals.value!} />
            <QuickActions actions={quickActions} />
            <InsightStream insights={insights} onOpenFile={openFile} />
          </>
        ) : (
          <EmptyState />
        ))}
    </>
  );
}

function AgentStreamsContent({ workflowRunner, kernel }: any) {
  return (
    <AgentStreamsView
      activeAgents={activeAgents}
      pendingActions={pendingActions}
      recentActivity={recentActivity}
      onPauseAgent={(id: string) => {
        activeAgents.value = activeAgents.value.map((a) =>
          a.id === id ? { ...a, status: a.status === "paused" ? "running" : "paused" } : a,
        );
        const isPaused = activeAgents.value.find((a) => a.id === id)?.status === "paused";
        new Notice(isPaused ? "Agent paused" : "Agent resumed");
      }}
      onStopAgent={(id: string) => {
        if (workflowRunner) {
          workflowRunner.cancel(id);
        }
        activeAgents.value = activeAgents.value.filter((a) => a.id !== id);
        agentStatus.value = {
          ...agentStatus.value,
          runningCount: Math.max(0, agentStatus.value.runningCount - 1),
        };
        new Notice("Agent stopped");
      }}
      onApplyAction={(id: string) => {
        const action = pendingActions.value.find((a) => a.id === id);
        if (!action) return;
        kernel.eventBus.emit("action:apply-requested", { actionId: id });
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
        pendingActions.value = pendingActions.value.filter((a) => a.id !== id);
        agentStatus.value = {
          ...agentStatus.value,
          pendingReviewCount: Math.max(0, agentStatus.value.pendingReviewCount - 1),
        };
        new Notice(`Applied: ${action.summary}`);
      }}
      onDismissAction={(id: string) => {
        pendingActions.value = pendingActions.value.filter((a) => a.id !== id);
        agentStatus.value = {
          ...agentStatus.value,
          pendingReviewCount: Math.max(0, agentStatus.value.pendingReviewCount - 1),
        };
      }}
      onUndoAction={(id: string) => {
        const activity = recentActivity.value.find((a) => a.id === id);
        if (!activity || !activity.canUndo) return;
        kernel.eventBus.emit("action:undo-requested", { actionId: id });
        recentActivity.value = recentActivity.value.map((a) =>
          a.id === id ? { ...a, status: "undone", canUndo: false } : a,
        );
        new Notice(`Undone: ${activity.summary}`);
      }}
      onViewResults={(agent: any) => {
        if (agent.resultData) {
          new Notice(`${agent.type} completed. Results available.`);
          console.log("[AgentResults]", agent.resultData.content);
        }
      }}
      onDismissAgent={(id: string) => {
        activeAgents.value = activeAgents.value.filter((a) => a.id !== id);
      }}
    />
  );
}

function ChatContent({ onRichChatSend, kernel, actionApplier }: any) {
  return (
    <RichChatView
      context={chatContext}
      messages={chatMessages}
      isStreaming={isChatStreaming}
      streamingContent={chatStreamingContent}
      streamingThinking={chatStreamingThinking}
      isThinking={isChatThinking}
      activities={chatActivities}
      onSendMessage={onRichChatSend}
      onClearContext={() => {
        chatContext.value = { notePath: null, noteTitle: null };
        chatMessages.value = [];
      }}
      onOpenNote={(path: string) => {
        kernel.obsidian.openFile(path);
      }}
      onAction={async (action: any) => {
        await handleChatAction(
          { actionApplier, obsidian: kernel.obsidian },
          action,
        );
      }}
      showStats={true}
    />
  );
}

function NoteVitalsSkeleton() {
  return (
    <div class="nv2-content" aria-busy="true" aria-label="Loading note vitals">
      <div class="nv2-section">
        <div class="nv2-skeleton nv2-skeleton-text nv2-skeleton-text--medium" />
        <div class="nv2-skeleton nv2-skeleton-text nv2-skeleton-text--short" />
      </div>
      <div class="nv2-section">
        <div class="nv2-vitals-cards">
          <div class="nv2-skeleton nv2-skeleton-card" />
          <div class="nv2-skeleton nv2-skeleton-card" />
          <div class="nv2-skeleton nv2-skeleton-card" />
          <div class="nv2-skeleton nv2-skeleton-card" />
        </div>
      </div>
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
