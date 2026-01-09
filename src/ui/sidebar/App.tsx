/**
 * Root Preact component for Notient Sidebar v2
 *
 * Structure:
 * - Header: Title and view toggle
 * - Content: NoteCard + QuickActions + InsightStream
 * - Footer: Service status
 */

import { Notice } from "obsidian";
import { useCallback, useMemo, useState } from "preact/hooks";
import type { AgentTaskQueue } from "../../core/agent";
import { InsightGenerator } from "../../services/insightGenerator";
import { InsightStream } from "./components/InsightStream";
import { NoteCard } from "./components/NoteCard";
import { QuickActions, createNoteQuickActions } from "./components/QuickActions";
import { useApp, useEventBus, useKernel, useService } from "./context/KernelContext";
import { useBacklinkPreview, useNoteVitals } from "./hooks/useNoteVitals";

export function App() {
  const kernel = useKernel();
  const app = useApp();
  const { noteVitals, isLoading } = useNoteVitals();
  const backlinkPreview = useBacklinkPreview();
  const taskQueue = useService<AgentTaskQueue>("taskQueue");

  // Callback for quick actions - sends to agent queue
  const prefillChatAndSwitch = useCallback(
    (prompt: string) => {
      if (taskQueue && noteVitals.value) {
        taskQueue.enqueue({
          agent: "chat",
          notePath: noteVitals.value.path,
          noteTitle: noteVitals.value.title,
          chatHistory: [{ role: "user", content: prompt }],
        });
        new Notice("Task sent to chat agent");
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

  const insights = useMemo(
    () => insightGenerator.generate(noteVitals.value),
    [insightGenerator, noteVitals.value],
  );

  // Quick actions for current note
  const quickActions = useMemo(
    () => createNoteQuickActions(noteVitals.value?.title || "this note", prefillChatAndSwitch),
    [noteVitals.value?.title, prefillChatAndSwitch],
  );

  // Subscribe to services:initialized event (fixes stuck "Initializing services..." bug)
  const [isReady, setIsReady] = useState(kernel.isServicesInitialized);
  useEventBus("services:initialized", () => setIsReady(true));

  const hasNote = noteVitals.value !== null;

  return (
    <div class="nv2-app">
      {/* Header */}
      <Header />

      {/* Content */}
      <div class="nv2-content">
        {!isReady ? (
          <LoadingState message="Initializing services..." />
        ) : isLoading.value ? (
          <LoadingState message="Loading note..." />
        ) : hasNote ? (
          <>
            <NoteCard noteVitals={noteVitals.value!} backlinkPreview={backlinkPreview} />
            <QuickActions actions={quickActions} />
            <InsightStream insights={insights} onOpenFile={openFile} />
          </>
        ) : (
          <EmptyState />
        )}
      </div>

      {/* Footer */}
      <Footer isReady={isReady} />
    </div>
  );
}

function Header() {
  return (
    <div class="nv2-header">
      <div class="nv2-header-title">
        <span class="nv2-accent">Notient</span>
        <span> Vitals</span>
      </div>
      <div class="nv2-header-subtitle">Note Dashboard</div>
    </div>
  );
}

function LoadingState({ message }: { message: string }) {
  return (
    <div class="nv2-section">
      <div class="nv2-insight-stream">
        <div class="nv2-insight">
          <div class="nv2-insight-dot nv2-insight-dot--secondary" />
          <div class="nv2-insight-content">
            <div class="nv2-insight-text">{message}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div class="nv2-section">
      <div class="nv2-empty-state">
        <div class="nv2-empty-state-text">Open a markdown note to see its vitals.</div>
      </div>
    </div>
  );
}

interface FooterProps {
  isReady: boolean;
}

function Footer({ isReady }: FooterProps) {
  // Provider health status
  const [lmStudioHealthy, setLmStudioHealthy] = useState(true);
  const [ollamaHealthy, setOllamaHealthy] = useState(true);

  // Index status
  const [indexedCount, setIndexedCount] = useState(0);
  const [indexProgress, setIndexProgress] = useState<number | null>(null);

  // Agent status
  const [activeWorkflows, setActiveWorkflows] = useState(0);

  // Subscribe to health events
  useEventBus("health:changed", (payload) => {
    const isHealthy = payload.health.status === "healthy";
    if (payload.service === "lmstudio") {
      setLmStudioHealthy(isHealthy);
    } else if (payload.service === "ollama") {
      setOllamaHealthy(isHealthy);
    }
  });

  // Subscribe to index events
  useEventBus("index:complete", (payload) => {
    setIndexedCount(payload.totalIndexed || 0);
    setIndexProgress(null);
  });

  useEventBus("index:progress", (payload) => {
    const percent =
      payload.progress.total > 0 ? (payload.progress.completed / payload.progress.total) * 100 : 0;
    setIndexProgress(percent);
  });

  // Subscribe to workflow events
  useEventBus("workflow:started", () => {
    setActiveWorkflows((prev) => prev + 1);
  });

  useEventBus("workflow:completed", () => {
    setActiveWorkflows((prev) => Math.max(0, prev - 1));
  });

  const providerStatus = lmStudioHealthy && ollamaHealthy ? "healthy" : "warning";

  return (
    <div class="nv2-footer">
      <div class="nv2-footer-content">
        {/* Providers Status */}
        <span class={`nv2-footer-zone nv2-status-${providerStatus}`}>
          <span class="nv2-footer-label">Providers</span>
          <span class="nv2-footer-value">{lmStudioHealthy && ollamaHealthy ? "✓" : "⚠"}</span>
        </span>

        <span class="nv2-footer-separator">|</span>

        {/* Index Status */}
        <span class="nv2-footer-zone">
          <span class="nv2-footer-label">Index</span>
          <span class="nv2-footer-value">
            {indexProgress !== null ? `${Math.round(indexProgress)}%` : `${indexedCount} notes`}
          </span>
        </span>

        <span class="nv2-footer-separator">|</span>

        {/* Agents Status */}
        <span class="nv2-footer-zone">
          <span class="nv2-footer-label">Agents</span>
          <span class="nv2-footer-value">
            {activeWorkflows > 0 ? `${activeWorkflows} active` : "idle"}
          </span>
        </span>
      </div>
    </div>
  );
}
