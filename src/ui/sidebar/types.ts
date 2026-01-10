/**
 * Centralized types for Notient Sidebar UI
 */

export type SidebarView = "note" | "agents" | "chat";

export interface ProviderStatus {
    lmstudio: { connected: boolean; model: string | null };
    ollama: { connected: boolean; model: string | null };
}

export interface IndexStatus {
    noteCount: number;
    lastSyncedAt: Date | null;
    isIndexing: boolean;
    indexingProgress?: number;
}

export interface AgentStatus {
    runningCount: number;
    pendingReviewCount: number;
}
