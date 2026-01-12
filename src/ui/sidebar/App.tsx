/**
 * Root Preact component for Notient Sidebar v2
 *
 * Structure:
 * - Header: System Dashboard (status & settings)
 * - Content: View-specific content based on active tab
 * - Footer: Navigation Deck (view switcher)
 */

import { batch } from "@preact/signals";
import type { Signal } from "@preact/signals";
import { Notice, setIcon } from "obsidian";
import type { JSX } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AgentTaskQueue } from "../../core/agent";
import type { ActionApplier, WorkflowRunner } from "../../core/agentic";
import { ChatService } from "../../core/chat";
import type { Kernel } from "../../core/kernel";
import type {
  Insight,
  InsightGenerator as InsightGeneratorType,
} from "../../services/insightGenerator";
import { InsightGenerator } from "../../services/insightGenerator";
import type { NoteVitals } from "../../services/noteVitalsCalculator";
import type { SearchResult } from "../../types/search";
import { IndexDashboardModal } from "../modals/IndexDashboardModal";
import { ModelSelectorModal } from "../modals/ModelSelectorModal";
import { type ActiveAgent, AgentStreamsView } from "./components/AgentStreamsView";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { InitializationStateView } from "./components/InitializationStateView";
import { InsightStream } from "./components/InsightStream";
import { NavDeck } from "./components/NavDeck";
import { NoteCard } from "./components/NoteCard";
import { Omnibar } from "./components/Omnibar";
import { type QuickAction, QuickActions, createNoteQuickActions } from "./components/QuickActions";
import { SearchResultsView } from "./components/SearchResultsView";
import { SystemDashboard } from "./components/SystemDashboard";
import { VitalsCards } from "./components/VitalsCards";
import { type MessageAction, RichChatView } from "./components/chat";
import type { SearchResultItemData } from "./components/search/SearchResultItem";
import { useApp, useKernel, useService } from "./context/KernelContext";
import { useAppEvents } from "./hooks/useAppEvents";
import { useNoteVitals } from "./hooks/useNoteVitals";
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
import { handleChatAction, handleRichChatSend, triggerAgenticAction } from "./state/appHandlers";

export function App() {
  console.log("[App] TRACE: Rendering App wrapper");
  return (
    <ErrorBoundary name="App">
      <AppContent />
    </ErrorBoundary>
  );
}

function AppContent() {
  console.log("[AppContent] TRACE: START render");
  const kernel = useKernel();
  const app = useApp();
  const { noteVitals, isLoading } = useNoteVitals();
  const taskQueue = useService<AgentTaskQueue>("taskQueue");
  const actionApplier = useService<ActionApplier>("actionApplier");
  const workflowRunner = useService<WorkflowRunner>("workflowRunner");

  // ChatService state
  const [chatService, setChatService] = useState<ChatService | null>(null);

  const createChatService = useCallback(() => {
    console.log("[AppContent:createChatService] TRACE: START");
    const llm = kernel.getService("llmProvider");
    if (llm) {
      console.log("[AppContent:createChatService] TRACE: Creating ChatService");
      const service = new ChatService(llm, undefined, {
        modelName: llm.model || "unknown",
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
      console.log("[AppContent:createChatService] TRACE: Before setChatService");
      setChatService(service);
      console.log("[AppContent:createChatService] TRACE: After setChatService");
      console.log("[AppContent:createChatService] TRACE: END (success)");
      return service;
    }
    console.log("[AppContent:createChatService] TRACE: END (no llm)");
    return null;
  }, [kernel]);

  // Initialize services
  useEffect(() => {
    console.log("[AppContent:useEffect:initServices] TRACE: START", {
      isServicesInitialized: kernel.isServicesInitialized,
      hasChatService: !!chatService,
    });
    if (kernel.isServicesInitialized && !chatService) {
      console.log("[AppContent:useEffect:initServices] TRACE: Calling createChatService");
      createChatService();
    }
    console.log("[AppContent:useEffect:initServices] TRACE: END");
  }, [kernel.isServicesInitialized, chatService, createChatService]);

  useEffect(() => {
    console.log("[AppContent:useEffect:isServicesReady] TRACE: START", {
      isServicesInitialized: kernel.isServicesInitialized,
    });
    console.log(
      "[AppContent:useEffect:isServicesReady] TRACE: Before isServicesReady.value assignment",
    );
    isServicesReady.value = kernel.isServicesInitialized;
    console.log(
      "[AppContent:useEffect:isServicesReady] TRACE: After isServicesReady.value assignment",
    );
    console.log("[AppContent:useEffect:isServicesReady] TRACE: END");
  }, [kernel.isServicesInitialized]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: signal subscription - track specific properties
  useEffect(() => {
    console.log("[AppContent:useEffect:chatContext] TRACE: START", {
      hasNoteVitals: !!noteVitals.value,
      path: noteVitals.value?.path,
    });
    if (noteVitals.value) {
      console.log("[AppContent:useEffect:chatContext] TRACE: Before chatContext.value assignment");
      chatContext.value = {
        notePath: noteVitals.value.path,
        noteTitle: noteVitals.value.title,
      };
      console.log("[AppContent:useEffect:chatContext] TRACE: After chatContext.value assignment");
    }
    console.log("[AppContent:useEffect:chatContext] TRACE: END");
  }, [noteVitals.value?.path, noteVitals.value?.title]);

  // Subscribe to all system events
  console.log("[AppContent] TRACE: Calling useAppEvents");
  useAppEvents({ chatService, createChatService });

  // Handler callbacks
  const onTriggerAgenticAction = useCallback(
    (prompt: string, agentType: "note-editor" | "classifier" | "connection") => {
      console.log("[AppContent:onTriggerAgenticAction] TRACE: START", agentType);
      triggerAgenticAction({ taskQueue, noteVitals }, prompt, agentType);
      console.log("[AppContent:onTriggerAgenticAction] TRACE: END");
    },
    [taskQueue, noteVitals],
  );

  const onRichChatSend = useCallback(
    async (message: string) => {
      console.log("[AppContent:onRichChatSend] TRACE: START");
      await handleRichChatSend({ chatService, noteVitals, obsidian: kernel.obsidian }, message);
      console.log("[AppContent:onRichChatSend] TRACE: END");
    },
    [chatService, noteVitals, kernel.obsidian],
  );

  const openFile = useCallback(
    async (path: string) => {
      console.log("[AppContent:openFile] TRACE: START", path);
      await kernel.obsidian.openFile(path);
      console.log("[AppContent:openFile] TRACE: END");
    },
    [kernel.obsidian],
  );

  // Insights
  const insightGenerator = useMemo(() => {
    console.log("[AppContent:useMemo:insightGenerator] TRACE: Creating InsightGenerator");
    return new InsightGenerator({
      triggerAgent: onTriggerAgenticAction,
      showNotice: (msg) => new Notice(msg),
    });
  }, [onTriggerAgenticAction]);

  const staticInsights = useMemo(() => {
    console.log("[AppContent:useMemo:staticInsights] TRACE: Generating insights");
    return insightGenerator.generate(noteVitals.value);
  }, [insightGenerator, noteVitals.value]);

  const insights = useMemo(() => {
    console.log("[AppContent:useMemo:insights] TRACE: Combining insights");
    return [...agentInsights.value, ...staticInsights];
  }, [staticInsights]);

  const quickActions = useMemo(() => {
    console.log("[AppContent:useMemo:quickActions] TRACE: Creating quick actions");
    const vitals = noteVitals.value;
    // Derive note state for contextual action filtering
    const noteState = vitals
      ? {
          wordCount: vitals.content.wordCount,
          linkCount: vitals.links.backlinks + vitals.links.outlinks,
          hasCheckboxes: vitals.content.hasCheckboxes,
        }
      : undefined;
    return createNoteQuickActions(
      vitals?.title || "this note",
      { triggerAgent: onTriggerAgenticAction },
      noteState,
    );
  }, [noteVitals.value, onTriggerAgenticAction]);

  // Modal handlers
  const openModelSelector = useCallback(() => {
    console.log("[AppContent:openModelSelector] TRACE: START");
    const currentModel = providerStatus.value.lmstudio.model || providerStatus.value.ollama.model;
    new ModelSelectorModal(app, kernel, currentModel).open();
    console.log("[AppContent:openModelSelector] TRACE: END");
  }, [app, kernel]);

  const openIndexDashboard = useCallback(() => {
    console.log("[AppContent:openIndexDashboard] TRACE: START");
    new IndexDashboardModal(app, kernel, indexStatus.value).open();
    console.log("[AppContent:openIndexDashboard] TRACE: END");
  }, [app, kernel]);

  const isReady = isServicesReady.value;
  const hasNote = noteVitals.value !== null;
  const currentView = activeView.value;

  console.log("[AppContent] TRACE: END render", { isReady, hasNote, currentView });

  return (
    <div class="nv2-app">
      <SystemDashboard
        providers={providerStatus}
        index={indexStatus}
        onModelClick={openModelSelector}
        onIndexClick={openIndexDashboard}
        onSettingsClick={() => {
          console.log("[AppContent:onSettingsClick] TRACE: START");
          // biome-ignore lint/suspicious/noExplicitAny: Obsidian internal API not fully typed
          const setting = (app as any).setting;
          if (setting) {
            setting.open();
            setting.openTabById("notient");
          }
          console.log("[AppContent:onSettingsClick] TRACE: END");
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

interface NoteVitalsContentProps {
  noteVitals: Signal<NoteVitals | null>;
  isLoading: Signal<boolean>;
  hasNote: boolean;
  quickActions: QuickAction[];
  insights: Insight[];
  openFile: (path: string) => Promise<void>;
}

function NoteVitalsContent({
  noteVitals,
  isLoading,
  hasNote,
  quickActions,
  insights,
  openFile,
}: NoteVitalsContentProps): JSX.Element {
  console.log("[NoteVitalsContent] TRACE: Rendering");
  return (
    <>
      <Omnibar
        placeholder="Search notes..."
        onResults={(results: SearchResult[], query: string) => {
          console.log("[NoteVitalsContent:Omnibar:onResults] TRACE: START", {
            resultCount: results.length,
            query,
          });
          queueMicrotask(() => {
            console.log("[NoteVitalsContent:Omnibar:onResults] TRACE: In microtask");
            console.log(
              "[NoteVitalsContent:Omnibar:onResults] TRACE: Before searchResults.value assignment",
            );
            searchResults.value = results;
            console.log(
              "[NoteVitalsContent:Omnibar:onResults] TRACE: After searchResults.value assignment",
            );
            console.log(
              "[NoteVitalsContent:Omnibar:onResults] TRACE: Before searchQuery.value assignment",
            );
            searchQuery.value = query;
            console.log(
              "[NoteVitalsContent:Omnibar:onResults] TRACE: After searchQuery.value assignment",
            );
          });
          console.log("[NoteVitalsContent:Omnibar:onResults] TRACE: END (microtask queued)");
        }}
        onResultSelect={(path: string) => {
          console.log("[NoteVitalsContent:Omnibar:onResultSelect] TRACE: START", path);
          openFile(path);
          queueMicrotask(() => {
            console.log("[NoteVitalsContent:Omnibar:onResultSelect] TRACE: In microtask");
            console.log(
              "[NoteVitalsContent:Omnibar:onResultSelect] TRACE: Before searchResults.value assignment",
            );
            searchResults.value = [];
            console.log(
              "[NoteVitalsContent:Omnibar:onResultSelect] TRACE: After searchResults.value assignment",
            );
            console.log(
              "[NoteVitalsContent:Omnibar:onResultSelect] TRACE: Before searchQuery.value assignment",
            );
            searchQuery.value = "";
            console.log(
              "[NoteVitalsContent:Omnibar:onResultSelect] TRACE: After searchQuery.value assignment",
            );
          });
          console.log("[NoteVitalsContent:Omnibar:onResultSelect] TRACE: END (microtask queued)");
        }}
        onDeepSearchComplete={(results: SearchResultItemData[], query: string) => {
          console.log("[NoteVitalsContent:Omnibar:onDeepSearchComplete] TRACE: START", {
            resultCount: results.length,
            query,
          });
          queueMicrotask(() => {
            console.log("[NoteVitalsContent:Omnibar:onDeepSearchComplete] TRACE: In microtask");
            const deepInsights = results.slice(0, 5).map((result) => ({
              text: `Deep search for "${query}": ${result.title}`,
              linkText: result.title,
              linkPath: result.path,
              priority: "high" as const,
            }));
            console.log(
              "[NoteVitalsContent:Omnibar:onDeepSearchComplete] TRACE: Before agentInsights.value assignment",
            );
            agentInsights.value = [...deepInsights, ...agentInsights.value.slice(0, 4)];
            console.log(
              "[NoteVitalsContent:Omnibar:onDeepSearchComplete] TRACE: After agentInsights.value assignment",
            );
            if (activeView.value !== "note") {
              console.log(
                "[NoteVitalsContent:Omnibar:onDeepSearchComplete] TRACE: Before activeView.value assignment",
              );
              activeView.value = "note";
              console.log(
                "[NoteVitalsContent:Omnibar:onDeepSearchComplete] TRACE: After activeView.value assignment",
              );
            }
          });
          console.log(
            "[NoteVitalsContent:Omnibar:onDeepSearchComplete] TRACE: END (microtask queued)",
          );
        }}
      />
      {searchResults.value.length > 0 && (
        <SearchResultsView
          results={searchResults.value}
          query={searchQuery.value}
          onOpenNote={openFile}
          onClear={() => {
            console.log("[NoteVitalsContent:SearchResultsView:onClear] TRACE: START");
            queueMicrotask(() => {
              console.log("[NoteVitalsContent:SearchResultsView:onClear] TRACE: In microtask");
              console.log(
                "[NoteVitalsContent:SearchResultsView:onClear] TRACE: Before searchResults.value assignment",
              );
              searchResults.value = [];
              console.log(
                "[NoteVitalsContent:SearchResultsView:onClear] TRACE: After searchResults.value assignment",
              );
              console.log(
                "[NoteVitalsContent:SearchResultsView:onClear] TRACE: Before searchQuery.value assignment",
              );
              searchQuery.value = "";
              console.log(
                "[NoteVitalsContent:SearchResultsView:onClear] TRACE: After searchQuery.value assignment",
              );
            });
            console.log(
              "[NoteVitalsContent:SearchResultsView:onClear] TRACE: END (microtask queued)",
            );
          }}
        />
      )}
      {searchResults.value.length === 0 &&
        (isLoading.value ? (
          <NoteVitalsSkeleton />
        ) : hasNote && noteVitals.value ? (
          <>
            <NoteCard noteVitals={noteVitals.value} />
            <VitalsCards vitals={noteVitals.value} />
            <QuickActions actions={quickActions} />
            <InsightStream insights={insights} onOpenFile={openFile} />
          </>
        ) : (
          <EmptyState />
        ))}
    </>
  );
}

interface AgentStreamsContentProps {
  workflowRunner: WorkflowRunner | null;
  kernel: Kernel;
}

function AgentStreamsContent({ workflowRunner, kernel }: AgentStreamsContentProps): JSX.Element {
  console.log("[AgentStreamsContent] TRACE: Rendering");
  return (
    <AgentStreamsView
      activeAgents={activeAgents}
      pendingActions={pendingActions}
      recentActivity={recentActivity}
      onPauseAgent={(id: string) => {
        console.log("[AgentStreamsContent:onPauseAgent] TRACE: START", id);
        queueMicrotask(() => {
          console.log("[AgentStreamsContent:onPauseAgent] TRACE: In microtask");
          console.log(
            "[AgentStreamsContent:onPauseAgent] TRACE: Before activeAgents.value assignment",
          );
          activeAgents.value = activeAgents.value.map((a) =>
            a.id === id ? { ...a, status: a.status === "paused" ? "running" : "paused" } : a,
          );
          console.log(
            "[AgentStreamsContent:onPauseAgent] TRACE: After activeAgents.value assignment",
          );
          const isPaused = activeAgents.value.find((a) => a.id === id)?.status === "paused";
          new Notice(isPaused ? "Agent paused" : "Agent resumed");
        });
        console.log("[AgentStreamsContent:onPauseAgent] TRACE: END (microtask queued)");
      }}
      onStopAgent={(id: string) => {
        console.log("[AgentStreamsContent:onStopAgent] TRACE: START", id);
        if (workflowRunner) {
          console.log("[AgentStreamsContent:onStopAgent] TRACE: Cancelling workflow");
          workflowRunner.cancel(id);
        }
        queueMicrotask(() => {
          console.log("[AgentStreamsContent:onStopAgent] TRACE: In microtask");
          batch(() => {
            console.log("[AgentStreamsContent:onStopAgent] TRACE: In batch");
            console.log(
              "[AgentStreamsContent:onStopAgent] TRACE: Before activeAgents.value assignment",
            );
            activeAgents.value = activeAgents.value.filter((a) => a.id !== id);
            console.log(
              "[AgentStreamsContent:onStopAgent] TRACE: After activeAgents.value assignment",
            );
            console.log(
              "[AgentStreamsContent:onStopAgent] TRACE: Before agentStatus.value assignment",
            );
            agentStatus.value = {
              ...agentStatus.value,
              runningCount: Math.max(0, agentStatus.value.runningCount - 1),
            };
            console.log(
              "[AgentStreamsContent:onStopAgent] TRACE: After agentStatus.value assignment",
            );
          });
          console.log("[AgentStreamsContent:onStopAgent] TRACE: After batch");
          new Notice("Agent stopped");
        });
        console.log("[AgentStreamsContent:onStopAgent] TRACE: END (microtask queued)");
      }}
      onApplyAction={(id: string) => {
        console.log("[AgentStreamsContent:onApplyAction] TRACE: START", id);
        const action = pendingActions.value.find((a) => a.id === id);
        if (!action) {
          console.log("[AgentStreamsContent:onApplyAction] TRACE: No action found");
          return;
        }
        console.log("[AgentStreamsContent:onApplyAction] TRACE: Emitting action:apply-requested");
        kernel.eventBus.emit("action:apply-requested", { actionId: id });
        queueMicrotask(() => {
          console.log("[AgentStreamsContent:onApplyAction] TRACE: In microtask");
          batch(() => {
            console.log("[AgentStreamsContent:onApplyAction] TRACE: In batch");
            console.log(
              "[AgentStreamsContent:onApplyAction] TRACE: Before recentActivity.value assignment",
            );
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
            console.log(
              "[AgentStreamsContent:onApplyAction] TRACE: After recentActivity.value assignment",
            );
            console.log(
              "[AgentStreamsContent:onApplyAction] TRACE: Before pendingActions.value assignment",
            );
            pendingActions.value = pendingActions.value.filter((a) => a.id !== id);
            console.log(
              "[AgentStreamsContent:onApplyAction] TRACE: After pendingActions.value assignment",
            );
            console.log(
              "[AgentStreamsContent:onApplyAction] TRACE: Before agentStatus.value assignment",
            );
            agentStatus.value = {
              ...agentStatus.value,
              pendingReviewCount: Math.max(0, agentStatus.value.pendingReviewCount - 1),
            };
            console.log(
              "[AgentStreamsContent:onApplyAction] TRACE: After agentStatus.value assignment",
            );
          });
          console.log("[AgentStreamsContent:onApplyAction] TRACE: After batch");
          new Notice(`Applied: ${action.summary}`);
        });
        console.log("[AgentStreamsContent:onApplyAction] TRACE: END (microtask queued)");
      }}
      onDismissAction={(id: string) => {
        console.log("[AgentStreamsContent:onDismissAction] TRACE: START", id);
        queueMicrotask(() => {
          console.log("[AgentStreamsContent:onDismissAction] TRACE: In microtask");
          batch(() => {
            console.log("[AgentStreamsContent:onDismissAction] TRACE: In batch");
            console.log(
              "[AgentStreamsContent:onDismissAction] TRACE: Before pendingActions.value assignment",
            );
            pendingActions.value = pendingActions.value.filter((a) => a.id !== id);
            console.log(
              "[AgentStreamsContent:onDismissAction] TRACE: After pendingActions.value assignment",
            );
            console.log(
              "[AgentStreamsContent:onDismissAction] TRACE: Before agentStatus.value assignment",
            );
            agentStatus.value = {
              ...agentStatus.value,
              pendingReviewCount: Math.max(0, agentStatus.value.pendingReviewCount - 1),
            };
            console.log(
              "[AgentStreamsContent:onDismissAction] TRACE: After agentStatus.value assignment",
            );
          });
          console.log("[AgentStreamsContent:onDismissAction] TRACE: After batch");
        });
        console.log("[AgentStreamsContent:onDismissAction] TRACE: END (microtask queued)");
      }}
      onUndoAction={(id: string) => {
        console.log("[AgentStreamsContent:onUndoAction] TRACE: START", id);
        const activity = recentActivity.value.find((a) => a.id === id);
        if (!activity || !activity.canUndo) {
          console.log("[AgentStreamsContent:onUndoAction] TRACE: No activity or cannot undo");
          return;
        }
        console.log("[AgentStreamsContent:onUndoAction] TRACE: Emitting action:undo-requested");
        kernel.eventBus.emit("action:undo-requested", { actionId: id });
        queueMicrotask(() => {
          console.log("[AgentStreamsContent:onUndoAction] TRACE: In microtask");
          console.log(
            "[AgentStreamsContent:onUndoAction] TRACE: Before recentActivity.value assignment",
          );
          recentActivity.value = recentActivity.value.map((a) =>
            a.id === id ? { ...a, status: "undone", canUndo: false } : a,
          );
          console.log(
            "[AgentStreamsContent:onUndoAction] TRACE: After recentActivity.value assignment",
          );
          new Notice(`Undone: ${activity.summary}`);
        });
        console.log("[AgentStreamsContent:onUndoAction] TRACE: END (microtask queued)");
      }}
      onViewResults={(agent: ActiveAgent) => {
        console.log("[AgentStreamsContent:onViewResults] TRACE: START", agent.id);
        if (agent.resultData) {
          new Notice(`${agent.type} completed. Results available.`);
        }
        console.log("[AgentStreamsContent:onViewResults] TRACE: END");
      }}
      onDismissAgent={(id: string) => {
        console.log("[AgentStreamsContent:onDismissAgent] TRACE: START", id);
        queueMicrotask(() => {
          console.log("[AgentStreamsContent:onDismissAgent] TRACE: In microtask");
          console.log(
            "[AgentStreamsContent:onDismissAgent] TRACE: Before activeAgents.value assignment",
          );
          activeAgents.value = activeAgents.value.filter((a) => a.id !== id);
          console.log(
            "[AgentStreamsContent:onDismissAgent] TRACE: After activeAgents.value assignment",
          );
        });
        console.log("[AgentStreamsContent:onDismissAgent] TRACE: END (microtask queued)");
      }}
    />
  );
}

interface ChatContentProps {
  onRichChatSend: (message: string) => Promise<void>;
  kernel: Kernel;
  actionApplier: ActionApplier | null;
}

function ChatContent({ onRichChatSend, kernel, actionApplier }: ChatContentProps): JSX.Element {
  console.log("[ChatContent] TRACE: Rendering");
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
        console.log("[ChatContent:onClearContext] TRACE: START");
        queueMicrotask(() => {
          console.log("[ChatContent:onClearContext] TRACE: In microtask");
          console.log("[ChatContent:onClearContext] TRACE: Before chatContext.value assignment");
          chatContext.value = { notePath: null, noteTitle: null };
          console.log("[ChatContent:onClearContext] TRACE: After chatContext.value assignment");
          console.log("[ChatContent:onClearContext] TRACE: Before chatMessages.value assignment");
          chatMessages.value = [];
          console.log("[ChatContent:onClearContext] TRACE: After chatMessages.value assignment");
        });
        console.log("[ChatContent:onClearContext] TRACE: END (microtask queued)");
      }}
      onOpenNote={(path: string) => {
        console.log("[ChatContent:onOpenNote] TRACE: START", path);
        kernel.obsidian.openFile(path);
        console.log("[ChatContent:onOpenNote] TRACE: END");
      }}
      onAction={async (action: MessageAction) => {
        console.log("[ChatContent:onAction] TRACE: START", action.type);
        await handleChatAction(
          { actionApplier, obsidian: kernel.obsidian },
          { type: action.type, payload: action.payload as Record<string, unknown> | undefined },
        );
        console.log("[ChatContent:onAction] TRACE: END");
      }}
      showStats={true}
    />
  );
}

function NoteVitalsSkeleton() {
  console.log("[NoteVitalsSkeleton] TRACE: Rendering");
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
          <div class="nv2-skeleton nv2-skeleton--quick-action" />
          <div class="nv2-skeleton nv2-skeleton--quick-action" />
          <div class="nv2-skeleton nv2-skeleton--quick-action" />
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  console.log("[EmptyState] TRACE: Rendering");
  const iconRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    console.log("[EmptyState:useEffect] TRACE: START");
    if (iconRef.current) {
      console.log("[EmptyState:useEffect] TRACE: Setting icon");
      setIcon(iconRef.current, "file-text");
    }
    console.log("[EmptyState:useEffect] TRACE: END");
  }, []);

  return (
    // biome-ignore lint/a11y/useSemanticElements: role="status" is correct ARIA pattern here
    <div class="nv2-empty-state" role="status">
      <div class="nv2-empty-state-icon" ref={iconRef} aria-hidden="true" />
      <div class="nv2-empty-state-title">No Note Open</div>
      <div class="nv2-empty-state-text">
        Open a markdown file to see its vitals and work with the AI assistant.
      </div>
    </div>
  );
}
