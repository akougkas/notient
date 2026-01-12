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
import {
  handleChatAction,
  handleChatSlashCommand,
  handleRichChatSend,
  parseChatSlashCommand,
  triggerAgenticAction,
} from "./state/appHandlers";

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
  const taskQueue = useService<AgentTaskQueue>("taskQueue");
  const actionApplier = useService<ActionApplier>("actionApplier");
  const workflowRunner = useService<WorkflowRunner>("workflowRunner");

  // ChatService state
  const [chatService, setChatService] = useState<ChatService | null>(null);

  const createChatService = useCallback(() => {
    const llm = kernel.getService("llmProvider");
    if (llm) {
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: signal subscription - track specific properties
  useEffect(() => {
    if (noteVitals.value) {
      chatContext.value = {
        notePath: noteVitals.value.path,
        noteTitle: noteVitals.value.title,
      };
    }
  }, [noteVitals.value?.path, noteVitals.value?.title]);

  // Subscribe to all system events
  useAppEvents({ chatService, createChatService });

  // Handler callbacks
  const onTriggerAgenticAction = useCallback(
    (prompt: string, agentType: "note-editor" | "classifier" | "connection") => {
      triggerAgenticAction({ taskQueue, noteVitals }, prompt, agentType);
    },
    [taskQueue, noteVitals],
  );

  const onRichChatSend = useCallback(
    async (message: string) => {
      // Check for slash commands first
      const slashResult = parseChatSlashCommand(message);
      if (slashResult.isSlashCommand) {
        handleChatSlashCommand({ taskQueue, noteVitals }, message);
        return;
      }
      // Otherwise handle as regular chat message
      await handleRichChatSend({ chatService, noteVitals, obsidian: kernel.obsidian }, message);
    },
    [chatService, noteVitals, kernel.obsidian, taskQueue],
  );

  const openFile = useCallback(
    async (path: string) => {
      await kernel.obsidian.openFile(path);
    },
    [kernel.obsidian],
  );

  // Insights
  const insightGenerator = useMemo(() => {
    return new InsightGenerator({
      triggerAgent: onTriggerAgenticAction,
      showNotice: (msg) => new Notice(msg),
    });
  }, [onTriggerAgenticAction]);

  const staticInsights = useMemo(() => {
    return insightGenerator.generate(noteVitals.value);
  }, [insightGenerator, noteVitals.value]);

  const insights = useMemo(() => {
    return [...agentInsights.value, ...staticInsights];
  }, [staticInsights]);

  const quickActions = useMemo(() => {
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
          // biome-ignore lint/suspicious/noExplicitAny: Obsidian internal API not fully typed
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
  return (
    <>
      <Omnibar
        placeholder="Search notes..."
        onResults={(results: SearchResult[], query: string) => {
          queueMicrotask(() => {
            searchResults.value = results;
            searchQuery.value = query;
          });
        }}
        onResultSelect={(path: string) => {
          openFile(path);
          queueMicrotask(() => {
            searchResults.value = [];
            searchQuery.value = "";
          });
        }}
        onDeepSearchComplete={(results: SearchResultItemData[], query: string) => {
          queueMicrotask(() => {
            const deepInsights = results.slice(0, 5).map((result) => ({
              text: `Deep search for "${query}": ${result.title}`,
              linkText: result.title,
              linkPath: result.path,
              priority: "high" as const,
            }));
            agentInsights.value = [...deepInsights, ...agentInsights.value.slice(0, 4)];
            if (activeView.value !== "note") {
              activeView.value = "note";
            }
          });
        }}
      />
      {searchResults.value.length > 0 && (
        <SearchResultsView
          results={searchResults.value}
          query={searchQuery.value}
          onOpenNote={openFile}
          onClear={() => {
            queueMicrotask(() => {
              searchResults.value = [];
              searchQuery.value = "";
            });
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
  return (
    <AgentStreamsView
      activeAgents={activeAgents}
      pendingActions={pendingActions}
      recentActivity={recentActivity}
      onPauseAgent={(id: string) => {
        queueMicrotask(() => {
          activeAgents.value = activeAgents.value.map((a) =>
            a.id === id ? { ...a, status: a.status === "paused" ? "running" : "paused" } : a,
          );
          const isPaused = activeAgents.value.find((a) => a.id === id)?.status === "paused";
          new Notice(isPaused ? "Agent paused" : "Agent resumed");
        });
      }}
      onStopAgent={(id: string) => {
        if (workflowRunner) {
          workflowRunner.cancel(id);
        }
        queueMicrotask(() => {
          batch(() => {
            activeAgents.value = activeAgents.value.filter((a) => a.id !== id);
            agentStatus.value = {
              ...agentStatus.value,
              runningCount: Math.max(0, agentStatus.value.runningCount - 1),
            };
          });
          new Notice("Agent stopped");
        });
      }}
      onApplyAction={(id: string) => {
        const action = pendingActions.value.find((a) => a.id === id);
        if (!action) {
          return;
        }
        kernel.eventBus.emit("action:apply-requested", { actionId: id });
        queueMicrotask(() => {
          batch(() => {
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
          });
          new Notice(`Applied: ${action.summary}`);
        });
      }}
      onDismissAction={(id: string) => {
        queueMicrotask(() => {
          batch(() => {
            pendingActions.value = pendingActions.value.filter((a) => a.id !== id);
            agentStatus.value = {
              ...agentStatus.value,
              pendingReviewCount: Math.max(0, agentStatus.value.pendingReviewCount - 1),
            };
          });
        });
      }}
      onUndoAction={(id: string) => {
        const activity = recentActivity.value.find((a) => a.id === id);
        if (!activity || !activity.canUndo) {
          return;
        }
        kernel.eventBus.emit("action:undo-requested", { actionId: id });
        queueMicrotask(() => {
          recentActivity.value = recentActivity.value.map((a) =>
            a.id === id ? { ...a, status: "undone", canUndo: false } : a,
          );
          new Notice(`Undone: ${activity.summary}`);
        });
      }}
      onViewResults={(agent: ActiveAgent) => {
        if (agent.resultData) {
          new Notice(`${agent.type} completed. Results available.`);
        }
      }}
      onDismissAgent={(id: string) => {
        queueMicrotask(() => {
          activeAgents.value = activeAgents.value.filter((a) => a.id !== id);
        });
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
        queueMicrotask(() => {
          chatContext.value = { notePath: null, noteTitle: null };
          chatMessages.value = [];
        });
      }}
      onOpenNote={(path: string) => {
        kernel.obsidian.openFile(path);
      }}
      onAction={async (action: MessageAction) => {
        await handleChatAction(
          { actionApplier, obsidian: kernel.obsidian },
          { type: action.type, payload: action.payload as Record<string, unknown> | undefined },
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
          <div class="nv2-skeleton nv2-skeleton--quick-action" />
          <div class="nv2-skeleton nv2-skeleton--quick-action" />
          <div class="nv2-skeleton nv2-skeleton--quick-action" />
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
