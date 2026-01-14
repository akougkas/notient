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
 * 4-Agent Swarm Architecture Types
 *
 * Target Architecture (4 agents):
 * 1. Orchestrator - The brain (reasoning model, makes plans, delegates)
 * 2. NoteEditor - Obsidian I/O specialist (edit, create, move, verify)
 * 3. ContextBuilder - Vault awareness specialist (search, relationships, trends)
 * 4. Worker - Workflow executor (classify, enhance, atomize, etc.)
 *
 * Legacy agents (chat, classifier, connection) are maintained for backward
 * compatibility and will be absorbed by Worker in Phase 2.
 */

/**
 * All Agent Types in the system
 *
 * Core 4-Agent Swarm:
 * - orchestrator: Brain, makes plans, delegates
 * - note-editor: Obsidian I/O specialist
 * - context-builder: Vault awareness specialist
 * - worker: Workflow executor (Phase 2)
 *
 * Legacy (maintained for backward compatibility):
 * - chat: UI layer (uses ChatService directly)
 * - classifier: Will be absorbed by Worker
 * - connection: Will be absorbed by Worker
 */
export type AgentType =
  // Core 4-Agent Swarm
  | "orchestrator" // Brain - makes plans, delegates
  | "note-editor" // Obsidian I/O specialist
  | "context-builder" // Vault awareness specialist
  | "worker" // Workflow executor (Phase 2)
  // Legacy agents (backward compatibility, to be absorbed in Phase 2)
  | "chat" // UI layer - uses ChatService directly
  | "classifier" // PARA classification -> Worker
  | "connection"; // Find connections -> Worker

/**
 * UI Agent Types - Interface layer that delegates to expert agents.
 * Chat is a UI layer, not a routable expert.
 * @deprecated Use AgentType directly. Chat UI uses ChatService.
 */
export type UIAgentType = "chat";

/**
 * Expert Agent Types - Specialized domain experts that produce structured output.
 * @deprecated Use AgentType directly. The 4-agent swarm replaces expert agents.
 */
export type ExpertAgentType =
  | "note-editor" // Edit note content/frontmatter
  | "classifier" // PARA classification, tagging -> absorbed by Worker (Phase 2)
  | "connection" // Find semantic connections -> absorbed by Worker (Phase 2)
  | "context-builder" // Build context for other agents (internal)
  | "worker"; // Unified workflow executor (Phase 2 Swarm)

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
  /**
   * Whether this is a UI agent (conversational interface) vs Expert agent (domain specialist).
   *
   * UI agents (isUI: true):
   * - Handle user conversation
   * - Detect intent and route to experts
   * - Not routable by other agents
   *
   * Expert agents (isUI: false):
   * - Specialized domain expertise
   * - Produce structured output
   * - Routable via ChiefOfStaff
   */
  isUI: boolean;
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
 * 4-Agent Swarm: orchestrator, note-editor, context-builder, worker
 * + Legacy agents for backward compatibility
 */
export const AGENT_CONFIGS: Record<AgentType, AgentConfig> = {
  // ===========================================================================
  // Core 4-Agent Swarm
  // ===========================================================================
  orchestrator: {
    type: "orchestrator",
    name: "Orchestrator",
    isUI: false, // Brain - makes plans, delegates to other agents
    temperature: 0.3, // Low for deterministic planning
    maxTokens: 1500,
    contextBudget: 8000,
    outputKind: "structured", // Outputs action plans
    canDelegate: true,
    delegationTargets: ["note-editor", "context-builder", "worker"],
    contextPriority: 10, // Highest - orchestrates everything
  },
  "note-editor": {
    type: "note-editor",
    name: "Note Editor",
    isUI: false, // Obsidian I/O specialist
    temperature: 0.3,
    maxTokens: 1500,
    contextBudget: 8000,
    outputKind: "structured",
    canDelegate: false,
    delegationTargets: [],
    contextPriority: 2,
  },
  "context-builder": {
    type: "context-builder",
    name: "Context Builder",
    isUI: false, // Vault awareness specialist
    temperature: 0.1,
    maxTokens: 500,
    contextBudget: 4000,
    outputKind: "internal",
    canDelegate: false,
    delegationTargets: [],
    contextPriority: 5, // High priority - provides context for others
  },
  worker: {
    type: "worker",
    name: "Worker",
    isUI: false, // Workflow executor (Phase 2)
    temperature: 0.3,
    maxTokens: 1500,
    contextBudget: 8000,
    outputKind: "structured",
    canDelegate: false,
    delegationTargets: [],
    contextPriority: 3,
  },
  // ===========================================================================
  // Legacy agents (backward compatibility, to be absorbed in Phase 2)
  // ===========================================================================
  chat: {
    type: "chat",
    name: "Chat Agent",
    isUI: true, // UI layer - conversational interface
    temperature: 0.7,
    maxTokens: 2000,
    contextBudget: 12000,
    outputKind: "conversational",
    canDelegate: true,
    delegationTargets: ["note-editor", "classifier", "connection"],
    contextPriority: 1,
  },
  classifier: {
    type: "classifier",
    name: "Classifier",
    isUI: false, // Will be absorbed by Worker
    temperature: 0.2,
    maxTokens: 800,
    contextBudget: 6000,
    outputKind: "structured",
    canDelegate: false,
    delegationTargets: [],
    contextPriority: 3,
  },
  connection: {
    type: "connection",
    name: "Connection Agent",
    isUI: false, // Will be absorbed by Worker
    temperature: 0.3,
    maxTokens: 1200,
    contextBudget: 10000,
    outputKind: "structured",
    canDelegate: false,
    delegationTargets: [],
    contextPriority: 2,
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
 * Vault graph context for connection agent
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
 * Link suggestions from connection agent
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
// JSON Schemas for Structured Output (LM Studio API)
// =============================================================================

import type { JsonSchemaFormat } from "../llm/types";

/**
 * JSON Schema for ClassificationOutput
 * Used with LM Studio structured output API
 */
export const CLASSIFICATION_SCHEMA: JsonSchemaFormat = {
  type: "json_schema",
  json_schema: {
    name: "classification_output",
    strict: true,
    schema: {
      type: "object",
      properties: {
        paraCategory: {
          type: "string",
          enum: ["project", "area", "resource", "archive", "inbox"],
        },
        confidence: { type: "number" },
        reasoning: { type: "string" },
        suggestedTags: {
          type: "array",
          items: { type: "string" },
        },
        suggestedFolder: { type: "string" },
      },
      required: ["paraCategory", "confidence", "reasoning", "suggestedTags"],
      additionalProperties: false,
    },
  },
};

/**
 * JSON Schema for LinkSuggestionsOutput
 * Used with LM Studio structured output API
 */
export const LINK_SUGGESTIONS_SCHEMA: JsonSchemaFormat = {
  type: "json_schema",
  json_schema: {
    name: "link_suggestions_output",
    strict: true,
    schema: {
      type: "object",
      properties: {
        links: {
          type: "array",
          items: {
            type: "object",
            properties: {
              targetPath: { type: "string" },
              targetTitle: { type: "string" },
              relevanceScore: { type: "number" },
              connectionType: {
                type: "string",
                enum: ["conceptual", "methodological", "problem-solution", "hierarchical"],
              },
              reason: { type: "string" },
            },
            required: ["targetPath", "targetTitle", "relevanceScore", "connectionType", "reason"],
          },
        },
      },
      required: ["links"],
      additionalProperties: false,
    },
  },
};

/**
 * JSON Schema for NoteEditOutput
 * Used with LM Studio structured output API
 */
export const NOTE_EDIT_SCHEMA: JsonSchemaFormat = {
  type: "json_schema",
  json_schema: {
    name: "note_edit_output",
    strict: true,
    schema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: [
                  "frontmatter_set",
                  "frontmatter_add_tags",
                  "append_section",
                  "append_related_links",
                  "move_note",
                ],
              },
              title: { type: "string" },
              reason: { type: "string" },
              target: { type: "string" },
              payload: { type: "object" },
            },
            required: ["type", "title", "reason", "target", "payload"],
          },
        },
      },
      required: ["actions"],
      additionalProperties: false,
    },
  },
};

/**
 * Get the JSON schema for a structured output agent
 */
export function getAgentSchema(agentType: ExpertAgentType): JsonSchemaFormat | null {
  switch (agentType) {
    case "classifier":
      return CLASSIFICATION_SCHEMA;
    case "connection":
      return LINK_SUGGESTIONS_SCHEMA;
    case "note-editor":
      return NOTE_EDIT_SCHEMA;
    case "context-builder":
      return null; // Internal agent, no structured output
    default:
      return null;
  }
}

// =============================================================================
// Agent Events (Streaming)
// =============================================================================

/**
 * Events emitted during agent execution
 */
export type AgentEvent =
  | { type: "started"; agentType: AgentType; activeSkill?: string }
  | { type: "progress"; agentType: AgentType; progress: number; activeSkill?: string }
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
// Orchestrator Types (4-Agent Swarm)
// =============================================================================

/**
 * Request source for the Orchestrator (one of three triggers)
 */
export type OrchestratorSource = "ui" | "chat" | "editor";

/**
 * Request to the Orchestrator from any of the three triggers
 */
export interface OrchestratorRequest {
  /** Which trigger initiated this request */
  source: OrchestratorSource;
  /** User's intent (natural language or structured) */
  intent: string;
  /** Current note context */
  noteContext?: NoteContext;
  /** Selected text if any */
  selection?: string;
  /** Chat history for context (from ChatService) */
  chatHistory?: ChatMessage[];
}

/**
 * The Orchestrator's action plan after reasoning
 */
export interface OrchestratorPlan {
  /** What action to take */
  action: "delegate" | "respond" | "clarify";
  /** Target agent for delegation */
  targetAgent?: "note-editor" | "context-builder" | "worker";
  /** Task description for the target agent */
  task?: string;
  /** The reasoning behind this plan */
  reasoning: string;
}

// =============================================================================
// Legacy Chief of Staff Types (for backward compatibility)
// =============================================================================

/**
 * Task routing decision
 * @deprecated Use OrchestratorPlan instead
 */
export interface RoutingDecision {
  /** Primary expert agent to handle the task */
  primaryAgent: ExpertAgentType;
  /** Context agents to run first (e.g., context-builder) */
  preflightAgents: ExpertAgentType[];
  /** Reason for routing decision */
  reason: string;
}

/**
 * Aggregated result from Orchestrator
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
