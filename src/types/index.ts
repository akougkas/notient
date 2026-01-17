/**
 * Notient v0.1.0 - Phase Galaxy Foundation Types
 * Source of truth: .planning/PHASE-GALAXY.md
 */

// =============================================================================
// Settings
// =============================================================================

export interface LLMProviderConfig {
  type: "lmstudio" | "ollama" | "openai-compatible";
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface NotientSettings {
  reasoningProvider: LLMProviderConfig;
  embeddingProvider: LLMProviderConfig;
  excludedFolders: string[];
  devMode: boolean;
  version: string;
}

export const DEFAULT_SETTINGS: NotientSettings = {
  reasoningProvider: {
    type: "lmstudio",
    baseUrl: "http://192.168.86.249:1234/v1",
    model: "qwen3-8b",
  },
  embeddingProvider: {
    type: "ollama",
    baseUrl: "http://192.168.86.249:11434",
    model: "nomic-embed-text-v2-moe",
  },
  excludedFolders: [".obsidian", ".trash"],
  devMode: false,
  version: "0.1.0",
};

// =============================================================================
// Enhancement Suggestions
// =============================================================================

export type SuggestionType = "tag" | "link" | "section" | "frontmatter";

export interface EnhancementSuggestion {
  id: string;
  type: SuggestionType;
  description: string;
  preview: string;
  metadata: SuggestionMetadata;
}

export interface SuggestionMetadata {
  confidence: number;
  reasoning?: string;
  position?: {
    line: number;
    column?: number;
  };
  // Type-specific metadata
  tags?: string[];
  linkTarget?: string;
  sectionTitle?: string;
  frontmatterKey?: string;
  frontmatterValue?: unknown;
}

// =============================================================================
// Agent Context
// =============================================================================

export interface AgentContext {
  noteContent: string;
  notePath: string;
  frontmatter: Record<string, unknown>;
  metadata: NoteMetadata;
}

export interface NoteMetadata {
  hash: string;
  title: string;
  maturity: NoteMaturity;
  origin: NoteOrigin;
  vitals: NoteVitals;
  links: {
    inbound: string[];
    outbound: string[];
  };
  tags: string[];
}

export type NoteMaturity = "raw" | "adolescent" | "mature" | "synthesis-ready";
export type NoteOrigin = "user-written" | "web-clipped" | "ai-generated" | "unknown";

export interface NoteVitals {
  healthScore: number;
  connectivity: number;
  structure: number;
  freshness: number;
}

// =============================================================================
// Pipeline State
// =============================================================================

export type PipelineStage = "planner" | "context-builder" | "analyst" | "writer" | "idle";
export type PipelineStatus = "idle" | "running" | "completed" | "error" | "cancelled";

export interface PipelineState {
  status: PipelineStatus;
  currentStage: PipelineStage;
  progress: number;
  error?: string;
  noteId?: string;
  startedAt?: number;
}

// =============================================================================
// Event Payloads
// =============================================================================

// Pipeline events
export interface EnhanceStartPayload {
  noteId: string;
  timestamp: number;
}

export interface EnhanceProgressPayload {
  noteId: string;
  percent: number;
  stage: PipelineStage;
}

export interface EnhanceCompletePayload {
  noteId: string;
  suggestionCount: number;
}

export interface EnhanceErrorPayload {
  noteId: string;
  error: string;
}

// Insight events
export interface InsightCreatedPayload {
  suggestion: EnhancementSuggestion;
}

export interface InsightDismissedPayload {
  suggestionId: string;
}

// Action events
export interface ActionAppliedPayload {
  actionId: string;
  noteId: string;
}

export interface ActionUndonePayload {
  actionId: string;
}

// Index events
export interface IndexStartPayload {
  noteCount: number;
}

export interface IndexProgressPayload {
  completed: number;
  total: number;
}

export interface IndexCompletePayload {
  noteCount: number;
  duration: number;
}

export interface IndexErrorPayload {
  error: string;
}

// Event map for type-safe event bus
export interface EventPayloadMap {
  "enhance:start": EnhanceStartPayload;
  "enhance:progress": EnhanceProgressPayload;
  "enhance:complete": EnhanceCompletePayload;
  "enhance:error": EnhanceErrorPayload;
  "insight:created": InsightCreatedPayload;
  "insight:dismissed": InsightDismissedPayload;
  "action:applied": ActionAppliedPayload;
  "action:undone": ActionUndonePayload;
  "index:start": IndexStartPayload;
  "index:progress": IndexProgressPayload;
  "index:complete": IndexCompletePayload;
  "index:error": IndexErrorPayload;
}

export type EventName = keyof EventPayloadMap;

// =============================================================================
// SQLite Row Types
// =============================================================================

export interface NoteRow {
  path: string;
  title: string;
  hash: string;
  indexed_at: number;
  last_enhanced: number | null;
}

export type ChunkType = "full" | "section" | "paragraph";

export interface ChunkRow {
  id: string;
  note_path: string;
  content: string;
  chunk_type: ChunkType;
  start_line: number;
  end_line: number;
  hash: string;
}

export interface EmbeddingRow {
  chunk_id: string;
  model: string;
  vector: Uint8Array;
  created_at: number;
}

export type ActionType = "add-tag" | "add-link" | "add-section" | "modify-frontmatter";

export interface ActionRow {
  id: string;
  note_path: string;
  action_type: ActionType;
  before_state: string;
  after_state: string;
  applied_at: number;
  undone: number;
}

export interface IntelligenceRow {
  note_path: string;
  analysis: string;
  suggestions: string;
  health_score: number;
  summary: string;
  version: number;
  analyzed_at: number;
}
