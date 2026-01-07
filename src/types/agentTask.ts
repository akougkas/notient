import type { ChatMessage } from "../services/lmstudio";

export type AgentType = 'search' | 'context' | 'chat';
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface AgentTask {
    id: string;
    agent: AgentType;
    notePath: string;
    noteTitle: string;
    status: TaskStatus;
    progress?: number;        // 0-100 for running tasks
    startedAt: Date;
    completedAt?: Date;
    result?: TaskResult;
    error?: string;
    chatHistory: ChatMessage[]; // Per-task conversation
}

export interface TaskResult {
    type: 'enrichment' | 'links' | 'classification' | 'chat';
    data: unknown;           // Varies by type
    citations: string[];     // Note paths used as RAG context
}
