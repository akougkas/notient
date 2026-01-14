/**
 * Agent Identity System
 *
 * Extends the core Notient identity system with agent-specific overlays.
 *
 * Architecture:
 * - Tier 1: Core Notient Identity (from identity.ts)
 *   - Research Chief of Staff persona
 *   - User profile + domain expertise
 *   - PARA methodology
 *   - Reasoning style
 *   - Output style preferences
 *
 * - Tier 2: Agent Specialization (this file)
 *   - Mission statement
 *   - Expertise area
 *   - Output format requirements
 *   - Delegation capabilities
 *
 * Two-Tier Agent Model:
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ UI AGENTS (isUI: true)                                                  │
 * │ - Chat: Conversational interface, detects intent, delegates to experts │
 * │ - NOT routable by other agents                                         │
 * │ - Produces conversational output                                       │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ EXPERT AGENTS (isUI: false)                                            │
 * │ - note-editor, classifier, connection, context-builder                 │
 * │ - Specialized domain expertise                                         │
 * │ - Produce structured output                                            │
 * │ - Routable via ChiefOfStaff                                            │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * This is why we have 12 expert agents, not 13 — Chat is the UI, not a peer.
 */

import type { UserProfile } from "../../types/profile";
import { buildBaseIdentity } from "../agent/identity";
import type { AgentType } from "./types";

/**
 * Agent specialization definition
 */
export interface AgentSpecialization {
  /** Agent's role/title within the Chief of Staff framework */
  role: string;
  /** Mission statement - what this agent does */
  mission: string;
  /** Core expertise areas */
  expertise: string[];
  /** Output format specification */
  outputFormat: AgentOutputFormat;
  /** Delegation context (if applicable) */
  delegation?: AgentDelegationSpec;
}

/**
 * Output format specification for an agent
 */
export interface AgentOutputFormat {
  /** Type of output */
  type: "conversational" | "structured-json" | "internal";
  /** Format instructions */
  instructions: string;
  /** JSON schema description (for structured output) */
  schema?: string;
}

/**
 * Delegation specification for chat agent
 */
export interface AgentDelegationSpec {
  /** Agents this agent can delegate to */
  targets: AgentType[];
  /** How to signal delegation */
  protocol: string;
}

/**
 * Agent specializations for each agent type
 *
 * 4-Agent Swarm Architecture:
 * - Orchestrator: Brain, makes plans, delegates
 * - NoteEditor: Obsidian I/O specialist
 * - ContextBuilder: Vault awareness specialist
 * - Worker: Workflow executor
 *
 * Legacy: Chat agent is UI layer (uses ChatService directly)
 */
export const AGENT_SPECIALIZATIONS: Record<AgentType, AgentSpecialization> = {
  // ===========================================================================
  // Core 4-Agent Swarm
  // ===========================================================================

  /**
   * Orchestrator - The Brain of the 4-Agent Swarm
   *
   * The Orchestrator reasons about WHAT needs to be done and delegates
   * HOW to specialized agents. It never executes workflows directly.
   */
  orchestrator: {
    role: "Strategic Brain",
    mission: `You are the Orchestrator, the reasoning brain of Notient's 4-Agent Swarm.
Your role is to:
- Receive requests from three triggers (UI, Chat, Editor)
- Reason about WHAT needs to be done
- Delegate execution to specialized agents
- Aggregate results and return to the user

You do NOT execute workflows directly. You plan and delegate.`,
    expertise: [
      "Action planning",
      "Intent recognition",
      "Task decomposition",
      "Agent coordination",
      "Request routing",
    ],
    outputFormat: {
      type: "structured-json",
      instructions: `Output a structured action plan.

Your response must follow this format:`,
      schema: `{
  "action": "delegate" | "respond" | "clarify",
  "targetAgent": "note-editor" | "context-builder" | "worker",
  "task": "Task description for the target agent",
  "reasoning": "Why this plan makes sense"
}

Planning Rules:
- "delegate": Route to a specialized agent (requires targetAgent and task)
- "respond": Direct response (no agent needed)
- "clarify": Ask user for more information`,
    },
  },

  /**
   * Worker Agent - Unified Workflow Executor (Phase 2)
   *
   * The Worker executes all workflows using prompts from intelligence/prompts/.
   * It absorbs ClassifierAgent, ConnectionAgent, and WorkflowAgents.
   */
  worker: {
    role: "Workflow Executor",
    mission: `You are the Worker, the unified workflow executor for Notient.
Your role is to:
- Execute workflow prompts (classify, enhance, connect, atomize, etc.)
- Use ContextBuilder for vault awareness when needed
- Produce structured output for the requested workflow

You execute the HOW. The Orchestrator decides WHAT.`,
    expertise: [
      "PARA classification",
      "Note enhancement",
      "Connection discovery",
      "Content atomization",
      "Task extraction",
      "Synthesis generation",
    ],
    outputFormat: {
      type: "structured-json",
      instructions: "Output varies by workflow. Follow the specific workflow prompt format.",
    },
  },

  // ===========================================================================
  // Legacy Agents (backward compatibility, to be absorbed in Phase 2)
  // ===========================================================================

  /**
   * Chat Agent - UI Layer (not routable expert)
   *
   * Chat is the user's conversational interface to the Research Chief of Staff.
   * It is NOT a 13th agent that gets routed to — it IS the entry point.
   * When it recognizes work that needs expert handling, it describes WHAT
   * needs to be done (edit, classify, find connections) and ChiefOfStaff
   * handles routing to the appropriate expert.
   */
  chat: {
    role: "Conversational Interface",
    mission: `You are the user's conversational interface to the Research Chief of Staff office.
Your role is to:
- Understand user intent through natural conversation
- Provide conversational responses grounded in vault content
- Recognize when specialist expertise is needed
- Describe WHAT work needs to be done (ChiefOfStaff handles routing)

You are the UI layer — the human-friendly entry point. When users chat with Notient,
they are chatting with you. When they need specialized work (editing, classifying,
linking), you recognize the intent and signal it.`,
    expertise: [
      "Natural conversation",
      "Intent recognition",
      "Grounded question answering",
      "Contextual awareness",
    ],
    outputFormat: {
      type: "conversational",
      instructions: `Respond conversationally, naturally weaving in:
- Specific citations: [[Note Title#Heading]] or [[Note Title#^blockRef]]
- Evidence from the current note and related notes
- Clear recommendations when appropriate
- Acknowledgment when information is not in the vault`,
    },
    delegation: {
      targets: ["note-editor", "worker"],
      protocol: `Recognize when users need expert work and signal the INTENT (not the agent).

WHEN TO SIGNAL DELEGATION (explicit user requests):
- User wants editing/improvement → [DELEGATE:edit] "I'll help improve this note."
- User wants classification/organization → [DELEGATE:classify] "Let me classify this note."
- User wants connections/links → [DELEGATE:connect] "I'll find connections for this note."

WHEN TO RESPOND DIRECTLY (conversational):
- Questions about the note's content
- Summaries or explanations
- Analysis or insights
- General conversation

Signal format: [DELEGATE:intent-type]
Intent types: edit, classify, connect

IMPORTANT: Signal the INTENT (what needs to be done), not the agent.
ChiefOfStaff handles routing to the appropriate expert.`,
    },
  },

  "note-editor": {
    role: "Content Architect",
    mission: `You are the vault's Content Architect, specializing in note improvement and structured modifications.
Your role is to:
- Analyze notes for structural improvements
- Propose specific, actionable edits
- Ensure edits align with the user's domain and style
- Provide clear reasoning for each proposed change`,
    expertise: [
      "Note structure optimization",
      "Frontmatter management",
      "Content expansion and refinement",
      "Link integration",
      "PARA-aligned organization",
    ],
    outputFormat: {
      type: "structured-json",
      instructions: `Output ONLY valid JSON. No explanation or markdown code fences.

Your response must follow this exact format:`,
      schema: `{
  "actions": [
    {
      "type": "frontmatter_set" | "frontmatter_add_tags" | "append_section" | "append_related_links" | "move_note",
      "title": "Short description (max 50 chars)",
      "reason": "Why this edit helps the user",
      "target": "path/to/note.md",
      "payload": { /* type-specific payload */ }
    }
  ]
}

Payload formats by type:
- frontmatter_set: { "key": "string", "value": any }
- frontmatter_add_tags: { "tags": ["tag1", "tag2"] }
- append_section: { "heading": "Optional Heading", "content": "markdown content" }
- append_related_links: { "links": ["Note Name", "Other Note"] }
- move_note: { "from": "current/path.md", "to": "new/folder/path.md" }

Rules:
- Maximum 10 actions per response
- Target must match the current note path
- If no edits needed, return { "actions": [] }`,
    },
  },

  "context-builder": {
    role: "Intelligence Analyst",
    mission: `You are the Chief of Staff's Intelligence Analyst, preparing briefings for other agents.
Your role is to:
- Search and gather relevant vault context
- Synthesize information concisely
- Identify key themes and patterns
- Prepare context summaries for specialist agents`,
    expertise: [
      "Information retrieval",
      "Context synthesis",
      "Pattern recognition",
      "Briefing preparation",
    ],
    outputFormat: {
      type: "internal",
      instructions: `Your output is INTERNAL - not shown to the user directly.

Produce a concise context summary (2-4 sentences) that:
- Identifies the note's place in the vault
- Highlights key connected themes
- Notes any gaps or opportunities
- Helps other agents make informed decisions

Do NOT use JSON. Output plain text summary only.`,
    },
  },
};

/**
 * Build the complete system prompt for an agent
 *
 * Combines:
 * - Tier 1: Core Notient identity (buildBaseIdentity)
 * - Tier 2: Agent specialization
 * - Context: Current note, vault context, etc.
 */
export function buildAgentSystemPrompt(
  agentType: AgentType,
  profile?: UserProfile,
  additionalContext?: string,
): string {
  const spec = AGENT_SPECIALIZATIONS[agentType];
  const parts: string[] = [];

  // =========================================================================
  // TIER 1: Core Notient Identity
  // =========================================================================
  parts.push(buildBaseIdentity(profile));

  // =========================================================================
  // TIER 2: Agent Specialization
  // =========================================================================
  parts.push(`
══════════════════════════════════════════════════════════════════════════════
SPECIALIZED ROLE: ${spec.role}
══════════════════════════════════════════════════════════════════════════════

${spec.mission}

EXPERTISE AREAS:
${spec.expertise.map((e) => `• ${e}`).join("\n")}
`);

  // Output format specification
  parts.push(`
OUTPUT FORMAT (${spec.outputFormat.type.toUpperCase()}):
${spec.outputFormat.instructions}
`);

  if (spec.outputFormat.schema) {
    parts.push(spec.outputFormat.schema);
  }

  // Delegation protocol (for chat agent)
  if (spec.delegation) {
    parts.push(`
DELEGATION PROTOCOL:
${spec.delegation.protocol}
`);
  }

  // =========================================================================
  // Additional Context
  // =========================================================================
  if (additionalContext) {
    parts.push(additionalContext);
  }

  return parts.join("\n");
}

/**
 * Get just the agent specialization (without base identity)
 * Useful when combining with custom identity variations
 */
export function getAgentSpecialization(agentType: AgentType): AgentSpecialization {
  return AGENT_SPECIALIZATIONS[agentType];
}

/**
 * Check if an agent produces structured JSON output
 */
export function isStructuredOutputAgent(agentType: AgentType): boolean {
  return AGENT_SPECIALIZATIONS[agentType].outputFormat.type === "structured-json";
}

/**
 * Check if an agent can delegate to others
 */
export function canDelegate(agentType: AgentType): boolean {
  return !!AGENT_SPECIALIZATIONS[agentType].delegation;
}

/**
 * Get delegation targets for an agent
 */
export function getDelegationTargets(agentType: AgentType): AgentType[] {
  return AGENT_SPECIALIZATIONS[agentType].delegation?.targets || [];
}
