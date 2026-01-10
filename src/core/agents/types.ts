/**
 * Multi-Agent System Type Definitions
 *
 * White House Model Architecture:
 * - President = User (decision maker)
 * - Chief of Staff = Notient core (coordinator, dispatcher, router, aggregator)
 * - Department Heads = Specialized agents
 */

import type { ProposedAction } from "../agentic/types";
import type { ChatMessage } from "../llm/types";

// =============================================================================
// Agent Types & Roster
// =============================================================================

/**
 * Specialized agent types in the system
 */
export type AgentType =
  | "chat" // Dialogue with user about current note
  | "note-editor" // Edit note content/frontmatter
  | "classifier" // PARA classification, tagging
  | "link-finder" // Find semantic connections
  | "context-builder"; // Build context for other agents (internal)

/**
 * Agent output types - determines parsing strategy
 */
export type AgentOutputKind = "conversational" | "structured" | "internal";

/**
 * Agent configuration - resource-aware parameters
 */
export interface AgentConfig {
  /** Agent identifier */
  type: AgentType;
  /** Display name */
  name: string;
  /** LLM temperature (0.0-2.0) */
  temperature: number;
  /** Maximum output tokens */
  maxTokens: number;
  /** Context window budget (chars) */
  contextBudget: number;
  /** Output type for parsing */
  outputKind: AgentOutputKind;
  /** Can this agent delegate to others? */
  canDelegate: boolean;
  /** Which agents can this agent delegate to? */
  delegationTargets: AgentType[];
  /** Priority in context (higher = more important) */
  contextPriority: number;
}

/**
 * Default configurations for each agent type
 */
export const AGENT_CONFIGS: Record<AgentType, AgentConfig> = {
  chat: {
    type: "chat",
    name: "Chat Agent",
    temperature: 0.7,
    maxTokens: 2000,
    contextBudget: 12000,
    outputKind: "conversational",
    canDelegate: true,
    delegationTargets: ["note-editor", "classifier", "link-finder"],
    contextPriority: 1,
  },
  "note-editor": {
    type: "note-editor",
    name: "Note Editor",
    temperature: 0.3,
    maxTokens: 1500,
    contextBudget: 8000,
    outputKind: "structured",
    canDelegate: false,
    delegationTargets: [],
    contextPriority: 2,
  },
  classifier: {
    type: "classifier",
    name: "Classifier",
    temperature: 0.2,
    maxTokens: 800,
    contextBudget: 6000,
    outputKind: "structured",
    canDelegate: false,
    delegationTargets: [],
    contextPriority: 3,
  },
  "link-finder": {
    type: "link-finder",
    name: "Link Finder",
    temperature: 0.3,
    maxTokens: 1200,
    contextBudget: 10000,
    outputKind: "structured",
    canDelegate: false,
    delegationTargets: [],
    contextPriority: 2,
  },
  "context-builder": {
    type: "context-builder",
    name: "Context Builder",
    temperature: 0.1,
    maxTokens: 500,
    contextBudget: 4000,
    outputKind: "internal",
    canDelegate: false,
    delegationTargets: [],
    contextPriority: 10, // Highest priority - runs first
  },
};

// =============================================================================
// Agent Context
// =============================================================================

/**
 * Context about the current note being processed
 */
export interface NoteContext {
  title: string;
  path: string;
  content: string;
  frontmatter?: Record<string, unknown>;
  wordCount?: number;
  lastModified?: Date;
}

/**
 * PARA folder structure for classifier context
 */
export interface PARAContext {
  inbox: string[];
  projects: string[];
  areas: string[];
  resources: string[];
  archive: string[];
}

/**
 * Vault graph context for link-finder
 */
export interface VaultGraphContext {
  backlinks: string[];
  outlinks: string[];
  orphans: string[];
  hubs: string[];
}

/**
 * Search results for context building
 */
export interface SearchContext {
  results: Array<{
    path: string;
    title: string;
    snippet: string;
    score: number;
  }>;
  query: string;
}

/**
 * Complete context provided to agents
 */
export interface AgentContext {
  /** The current note (always present) */
  currentNote: NoteContext;
  /** User's query/message */
  query: string;
  /** Chat history for conversational context */
  chatHistory: ChatMessage[];
  /** PARA folder structure */
  para?: PARAContext;
  /** Vault graph context */
  graph?: VaultGraphContext;
  /** Search results from context-builder */
  search?: SearchContext;
  /** Related notes from search */
  relatedNotes?: Array<{
    title: string;
    path: string;
    text: string;
  }>;
  /** Context summary from context-builder */
  contextSummary?: string;
  /** Active agents in this session */
  activeAgents: AgentType[];
  /** Delegation chain (who invoked who) */
  delegationChain: AgentType[];
}

// =============================================================================
// Agent Outputs
// =============================================================================

/**
 * Conversational output from Chat agent
 */
export interface ConversationalOutput {
  kind: "conversational";
  content: string;
  citations: string[];
  /** Attached outputs from delegated agents */
  delegatedResults?: DelegatedResult[];
}

/**
 * Structured JSON output from specialist agents
 */
export interface StructuredOutput {
  kind: "structured";
  agentType: AgentType;
  data: unknown;
  /** Schema name for validation */
  schema: string;
}

/**
 * Internal output from context-builder (not shown to user)
 */
export interface InternalOutput {
  kind: "internal";
  agentType: "context-builder";
  contextSummary: string;
  relatedNotes: Array<{
    title: string;
    path: string;
    text: string;
  }>;
  searchResults: SearchContext;
}

/**
 * Union type for all agent outputs
 */
export type AgentOutput = ConversationalOutput | StructuredOutput | InternalOutput;

/**
 * Result from a delegated agent call
 */
export interface DelegatedResult {
  agentType: AgentType;
  output: StructuredOutput;
  /** Time taken in ms */
  durationMs: number;
}

// =============================================================================
// Structured Output Schemas
// =============================================================================

/**
 * Note edit output from note-editor agent
 */
export interface NoteEditOutput {
  actions: ProposedAction[];
}

/**
 * Classification output from classifier agent
 */
export interface ClassificationOutput {
  paraCategory: "project" | "area" | "resource" | "archive" | "inbox";
  confidence: number;
  reasoning: string;
  suggestedTags: string[];
  suggestedFolder?: string;
}

/**
 * Link suggestions from link-finder agent
 */
export interface LinkSuggestionsOutput {
  links: Array<{
    targetPath: string;
    targetTitle: string;
    relevanceScore: number;
    connectionType: "conceptual" | "methodological" | "problem-solution" | "hierarchical";
    reason: string;
  }>;
}

// =============================================================================
// Agent Events (Streaming)
// =============================================================================

/**
 * Events emitted during agent execution
 */
export type AgentEvent =
  | { type: "started"; agentType: AgentType }
  | { type: "progress"; agentType: AgentType; progress: number }
  | { type: "chunk"; agentType: AgentType; content: string }
  | { type: "delegation-started"; from: AgentType; to: AgentType }
  | { type: "delegation-complete"; from: AgentType; to: AgentType; result: DelegatedResult }
  | { type: "citations"; agentType: AgentType; paths: string[] }
  | { type: "complete"; agentType: AgentType; output: AgentOutput }
  | { type: "error"; agentType: AgentType; error: Error };

// =============================================================================
// Delegation Protocol
// =============================================================================

/**
 * Request to delegate work to another agent
 */
export interface DelegationRequest {
  /** Which agent to invoke */
  targetAgent: AgentType;
  /** Specific instruction for the target agent */
  instruction: string;
  /** Subset of context to pass (for efficiency) */
  contextFilter?: {
    includeNote: boolean;
    includeChatHistory: boolean;
    includeSearch: boolean;
  };
}

/**
 * Session state for agent awareness
 */
export interface AgentSession {
  /** Session ID */
  id: string;
  /** Currently active agents */
  activeAgents: Set<AgentType>;
  /** Completed agents in this session */
  completedAgents: Map<AgentType, AgentOutput>;
  /** Start time */
  startedAt: Date;
  /** Current note path */
  notePath: string;
}

// =============================================================================
// Chief of Staff Types
// =============================================================================

/**
 * Task routing decision
 */
export interface RoutingDecision {
  /** Primary agent to handle the task */
  primaryAgent: AgentType;
  /** Context agents to run first (e.g., context-builder) */
  preflightAgents: AgentType[];
  /** Reason for routing decision */
  reason: string;
}

/**
 * Aggregated result from Chief of Staff
 */
export interface AggregatedResult {
  /** Primary output (what user sees) */
  primary: AgentOutput;
  /** Supporting outputs from other agents */
  supporting: AgentOutput[];
  /** Full session info */
  session: AgentSession;
  /** Citations from all agents */
  allCitations: string[];
  /** Actions proposed by any agent */
  proposedActions: ProposedAction[];
}
