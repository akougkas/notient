/**
 * Root Preact component for Notient Sidebar v2
 *
 * Structure:
 * - Header: Tabs for Note | Agents | Chat
 * - Content: View-specific content based on active tab
 * - Footer: Three-zone status (Providers | Index | Agents)
 */

import { Notice } from "obsidian";
import { signal } from "@preact/signals";
import { useCallback, useEffect, useMemo } from "preact/hooks";
import type { AgentTaskQueue } from "../../core/agent";
import { InsightGenerator } from "../../services/insightGenerator";
import { NoteCard } from "./components/NoteCard";
import { VitalsCards } from "./components/VitalsCards";
import {
	QuickActions,
	createNoteQuickActions,
} from "./components/QuickActions";
import { InsightStream } from "./components/InsightStream";
import { Header, type SidebarView } from "./components/Header";
import {
	Footer,
	type ProviderStatus,
	type IndexStatus,
	type AgentStatus,
} from "./components/Footer";
import {
	AgentStreamsView,
	type ActiveAgent,
	type PendingAction,
	type RecentActivity,
} from "./components/AgentStreamsView";
import {
	ChatView,
	type ChatContext,
	type ChatMessage,
} from "./components/ChatView";
import { useApp, useEventBus, useKernel, useService } from "./context/KernelContext";
import { useBacklinkPreview, useNoteVitals } from "./hooks/useNoteVitals";

// Global signals for sidebar state
const isServicesReady = signal(false);
const activeView = signal<SidebarView>("note");
const providerStatus = signal<ProviderStatus>({
	lmstudio: { connected: false, model: null },
	ollama: { connected: false, model: null },
});
const indexStatus = signal<IndexStatus>({
	noteCount: 0,
	lastSyncedAt: null,
	isIndexing: false,
});
const agentStatus = signal<AgentStatus>({
	runningCount: 0,
	pendingReviewCount: 0,
});

// Agent Streams view state
const activeAgents = signal<ActiveAgent[]>([]);
const pendingActions = signal<PendingAction[]>([]);
const recentActivity = signal<RecentActivity[]>([]);

// Chat view state
const chatContext = signal<ChatContext>({ notePath: null, noteTitle: null });
const chatMessages = signal<ChatMessage[]>([]);
const isChatStreaming = signal(false);
const chatStreamingContent = signal("");

export function App() {
	const kernel = useKernel();
	const app = useApp();
	const { noteVitals, isLoading } = useNoteVitals();
	const backlinkPreview = useBacklinkPreview();
	const taskQueue = useService<AgentTaskQueue>("taskQueue");

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
			indexingProgress: progress.total > 0
				? Math.round((progress.completed / progress.total) * 100)
				: 0,
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

	// Subscribe to agent/workflow events
	useEventBus("workflow:started", () => {
		agentStatus.value = {
			...agentStatus.value,
			runningCount: agentStatus.value.runningCount + 1,
		};
	});

	useEventBus("workflow:completed", () => {
		agentStatus.value = {
			...agentStatus.value,
			runningCount: Math.max(0, agentStatus.value.runningCount - 1),
		};
	});

	// Note: action:proposed not in event types, increment pending on workflow:completed for now
	// In production, this would listen to a proper action proposal event

	useEventBus("action:applied", () => {
		agentStatus.value = {
			...agentStatus.value,
			pendingReviewCount: Math.max(0, agentStatus.value.pendingReviewCount - 1),
		};
	});

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
		() =>
			createNoteQuickActions(
				noteVitals.value?.title || "this note",
				prefillChatAndSwitch,
			),
		[noteVitals.value?.title, prefillChatAndSwitch],
	);

	const isReady = isServicesReady.value;
	const hasNote = noteVitals.value !== null;
	const currentView = activeView.value;

	return (
		<div class="nv2-app">
			{/* Header with Tabs */}
			<Header
				activeView={activeView}
				pendingReviewCount={agentStatus.value.pendingReviewCount}
				runningAgentsCount={agentStatus.value.runningCount}
			/>

			{/* Content - View Specific */}
			<div class="nv2-content" key={currentView}>
				{!isReady ? (
					<LoadingState message="Initializing services..." />
				) : currentView === "note" ? (
					// Note Vitals View - 4 sections: Identity, Vitals, Actions, Insights
					isLoading.value ? (
						<LoadingState message="Loading note..." />
					) : hasNote ? (
						<>
							{/* Section 1: Note Identity */}
							<NoteCard
								noteVitals={noteVitals.value!}
								backlinkPreview={backlinkPreview}
							/>
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
					)
				) : currentView === "agents" ? (
					// Agent Streams View
					<AgentStreamsView
						activeAgents={activeAgents}
						pendingActions={pendingActions}
						recentActivity={recentActivity}
						onPauseAgent={(id) => {
							// TODO: Implement pause via kernel
							console.log("Pause agent:", id);
						}}
						onStopAgent={(id) => {
							// TODO: Implement stop via kernel
							console.log("Stop agent:", id);
						}}
						onApplyAction={(id) => {
							// TODO: Implement apply via ActionApplier
							console.log("Apply action:", id);
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
							// TODO: Implement undo via ActionHistory
							console.log("Undo action:", id);
						}}
					/>
				) : (
					// Chat View
					<ChatView
						context={chatContext}
						messages={chatMessages}
						isStreaming={isChatStreaming}
						streamingContent={chatStreamingContent}
						onSendMessage={(message) => {
							// Add user message
							const userMsg: ChatMessage = {
								id: `user-${Date.now()}`,
								role: "user",
								content: message,
								timestamp: new Date(),
							};
							chatMessages.value = [...chatMessages.value, userMsg];

							// Send to agent queue for processing
							if (taskQueue && chatContext.value.notePath) {
								taskQueue.enqueue({
									agent: "chat",
									notePath: chatContext.value.notePath,
									noteTitle: chatContext.value.noteTitle || "Note",
									chatHistory: chatMessages.value.map((m) => ({
										role: m.role,
										content: m.content,
									})),
								});
							}

							// Simulate assistant response (actual integration would stream from agent)
							isChatStreaming.value = true;
							setTimeout(() => {
								const assistantMsg: ChatMessage = {
									id: `assistant-${Date.now()}`,
									role: "assistant",
									content: `I've received your message about "${chatContext.value.noteTitle}". The full chat integration with the agent system is coming soon!`,
									timestamp: new Date(),
								};
								chatMessages.value = [...chatMessages.value, assistantMsg];
								isChatStreaming.value = false;
							}, 1000);
						}}
						onClearContext={() => {
							chatContext.value = { notePath: null, noteTitle: null };
						}}
						onOpenNote={(path) => {
							kernel.obsidian.openFile(path);
						}}
					/>
				)}
			</div>

			{/* Footer with Three Zones */}
			<Footer
				providers={providerStatus}
				index={indexStatus}
				agents={agentStatus}
				activeView={activeView}
				isReady={isReady}
			/>
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
	return (
		<div class="nv2-empty-state" role="status">
			<div class="nv2-empty-state-icon" aria-hidden="true">📝</div>
			<div class="nv2-empty-state-title">No Note Open</div>
			<div class="nv2-empty-state-text">
				Open a markdown file to see its vitals and work with the AI assistant.
			</div>
		</div>
	);
}

