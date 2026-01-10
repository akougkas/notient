/**
 * Sidebar State Management
 *
 * Centralized state using @preact/signals for the sidebar UI.
 * All state is scoped to this module and exported for use by components.
 */

import { signal } from "@preact/signals";
import type { Insight } from "../../services/insightGenerator";
import type { SearchResult } from "../../types/search";
import type { InitializationContext, InitializationState } from "../../types/services";
import type { ActiveAgent, PendingAction, RecentActivity } from "./components/AgentStreamsView";
import type { ActivityItem, ChatContext, RichChatMessage } from "./components/chat";
import type { AgentStatus, IndexStatus, ProviderStatus, SidebarView } from "./types";

/**
 * Reset all sidebar state to initial values.
 * Useful for cleanup or testing.
 */
export function resetSidebarState(): void {
  // Initialization state
  isServicesReady.value = false;
  initState.value = "UNINITIALIZED";
  initContext.value = null;

  // View state
  activeView.value = "note";

  // Provider/Index/Agent status
  providerStatus.value = {
    lmstudio: { connected: false, model: null },
    ollama: { connected: false, model: null },
  };
  indexStatus.value = {
    noteCount: 0,
    lastSyncedAt: null,
    isIndexing: false,
  };
  agentStatus.value = {
    runningCount: 0,
    pendingReviewCount: 0,
  };

  // Agent Streams view state
  activeAgents.value = [];
  pendingActions.value = [];
  recentActivity.value = [];
  agentInsights.value = [];

  // Chat view state
  chatContext.value = { notePath: null, noteTitle: null };
  chatMessages.value = [];
  isChatStreaming.value = false;
  chatStreamingContent.value = "";
  chatStreamingThinking.value = "";
  isChatThinking.value = false;
  chatActivities.value = [];

  // Search state
  searchResults.value = [];
  searchQuery.value = "";
}

// -----------------------------------------------------------------------------
// Initialization State
// -----------------------------------------------------------------------------
export const isServicesReady = signal(false);
export const initState = signal<InitializationState>("UNINITIALIZED");
export const initContext = signal<InitializationContext | null>(null);

// -----------------------------------------------------------------------------
// View Navigation State
// -----------------------------------------------------------------------------
export const activeView = signal<SidebarView>("note");

// -----------------------------------------------------------------------------
// System Status State
// -----------------------------------------------------------------------------
export const providerStatus = signal<ProviderStatus>({
  lmstudio: { connected: false, model: null },
  ollama: { connected: false, model: null },
});

export const indexStatus = signal<IndexStatus>({
  noteCount: 0,
  lastSyncedAt: null,
  isIndexing: false,
});

export const agentStatus = signal<AgentStatus>({
  runningCount: 0,
  pendingReviewCount: 0,
});

// -----------------------------------------------------------------------------
// Agent Streams View State
// -----------------------------------------------------------------------------
export const activeAgents = signal<ActiveAgent[]>([]);
export const pendingActions = signal<PendingAction[]>([]);
export const recentActivity = signal<RecentActivity[]>([]);
/** Dynamic insights from completed agents (displayed in Vitals InsightStream) */
export const agentInsights = signal<Insight[]>([]);

// -----------------------------------------------------------------------------
// Chat View State
// -----------------------------------------------------------------------------
export const chatContext = signal<ChatContext>({ notePath: null, noteTitle: null });
export const chatMessages = signal<RichChatMessage[]>([]);
export const isChatStreaming = signal(false);
export const chatStreamingContent = signal("");
export const chatStreamingThinking = signal("");
export const isChatThinking = signal(false);
export const chatActivities = signal<ActivityItem[]>([]);

// -----------------------------------------------------------------------------
// Search State
// -----------------------------------------------------------------------------
export const searchResults = signal<SearchResult[]>([]);
export const searchQuery = signal<string>("");
