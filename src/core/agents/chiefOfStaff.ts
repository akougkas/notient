/**
 * Chief of Staff - Central Agent Coordinator
 *
 * White House Model:
 * - President = User (decision maker)
 * - Chief of Staff = This class (coordinator, dispatcher, router, aggregator)
 * - Department Heads = Specialized agents
 *
 * Responsibilities:
 * 1. Route tasks to appropriate agents
 * 2. Build context before agent execution
 * 3. Handle agent-to-agent delegation
 * 4. Aggregate results from multiple agents
 * 5. Manage agent sessions for awareness
 *
 * UI vs Expert Agent Distinction:
 * Chat is the UI layer — a conversational interface that delegates to expert agents.
 * It is NOT a 13th agent that gets routed to. When a request is identified as a
 * "UI request" (no explicit command, no strong intent signals), it flows through
 * Chat for conversational handling without heavyweight context-builder preflight.
 * Expert agents (note-editor, classifier, link-finder, etc.) are the specialists
 * that handle structured, domain-specific work.
 */

import type { ObsidianFacade } from "../../adapters/obsidianFacade";
import type { UserProfile } from "../../types/profile";
import type { ProposedAction } from "../agentic/types";
import type { VaultContextBuilder } from "../context/vaultContextBuilder";
import type { LLMProvider } from "../llm/provider";
import type { SearchPipeline } from "../search/pipeline";
import { isInternalOutput, isStructuredOutput } from "./base";
import { ChatAgent } from "./chatAgent";
import { ClassifierAgent } from "./classifierAgent";
import { ContextBuilderAgent } from "./contextBuilderAgent";
import { LinkFinderAgent } from "./linkFinderAgent";
import { NoteEditorAgent } from "./noteEditorAgent";
import type {
  AgentContext,
  AgentEvent,
  AgentOutput,
  AgentSession,
  AgentType,
  AggregatedResult,
  DelegatedResult,
  DelegationRequest,
  InternalOutput,
  NoteContext,
  PARAContext,
  RoutingDecision,
  StructuredOutput,
  VaultGraphContext,
} from "./types";
import { AGENT_CONFIGS } from "./types";
import {
  WorkflowAgent,
  type WorkflowAgentType,
  getWorkflowByCommand,
  isWorkflowCommand,
} from "./workflowAgents";

/**
 * Task input for the Chief of Staff
 */
export interface ChiefOfStaffTask {
  /** User's query/message */
  query: string;
  /** Path to the current note */
  notePath: string;
  /** Title of the current note */
  noteTitle: string;
  /** Chat history for context */
  chatHistory: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  /** Optional explicit agent target (bypasses routing) */
  targetAgent?: AgentType;
  /** Optional explicit workflow target (for slash commands) */
  targetWorkflow?: WorkflowAgentType;
}

/**
 * Chief of Staff - Central agent coordinator
 */
export class ChiefOfStaff {
  // Core Agents (Department Heads)
  private chatAgent: ChatAgent;
  private noteEditorAgent: NoteEditorAgent;
  private classifierAgent: ClassifierAgent;
  private linkFinderAgent: LinkFinderAgent;
  private contextBuilderAgent: ContextBuilderAgent;

  // Workflow Agents (Intelligence 2.0) - created on demand
  private workflowAgents: Map<WorkflowAgentType, WorkflowAgent> = new Map();

  // Services
  private llm: LLMProvider;
  private obsidian: ObsidianFacade;
  private profile?: UserProfile;

  // Session management
  private currentSession: AgentSession | null = null;

  constructor(
    llm: LLMProvider,
    searchPipeline: SearchPipeline | null,
    vaultContextBuilder: VaultContextBuilder | null,
    obsidian: ObsidianFacade,
    profile?: UserProfile,
  ) {
    this.llm = llm;
    this.obsidian = obsidian;
    this.profile = profile;

    // Initialize core agents (Department Heads) with profile for identity system
    this.chatAgent = new ChatAgent(llm, profile);
    this.noteEditorAgent = new NoteEditorAgent(llm, profile);
    this.classifierAgent = new ClassifierAgent(llm, profile);
    this.linkFinderAgent = new LinkFinderAgent(llm, profile);
    this.contextBuilderAgent = new ContextBuilderAgent(
      llm,
      searchPipeline,
      vaultContextBuilder,
      profile,
    );

    // Wire up delegation handler
    this.chatAgent.setDelegationHandler(this.handleDelegation.bind(this));
  }

  /**
   * Get or create a workflow agent
   */
  private getWorkflowAgent(workflowType: WorkflowAgentType): WorkflowAgent {
    let agent = this.workflowAgents.get(workflowType);
    if (!agent) {
      agent = new WorkflowAgent(this.llm, workflowType, this.profile);
      this.workflowAgents.set(workflowType, agent);
    }
    return agent;
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Execute a task with streaming events
   */
  async *execute(task: ChiefOfStaffTask, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    // Create session
    this.currentSession = this.createSession(task.notePath);

    try {
      // Phase 1: Load current note content
      const noteContext = await this.loadNoteContext(task.notePath, task.noteTitle);
      if (!noteContext) {
        yield {
          type: "error",
          agentType: "context-builder",
          error: new Error("Failed to load note"),
        };
        return;
      }

      // Phase 2: Check for workflow commands first
      if (task.targetWorkflow || isWorkflowCommand(task.query.split(" ")[0])) {
        const workflowType = task.targetWorkflow || this.extractWorkflowType(task.query);
        if (workflowType) {
          console.log(`[ChiefOfStaff] Executing workflow: ${workflowType}`);
          yield* this.executeWorkflow(workflowType, task, noteContext, signal);
          return;
        }
      }

      // Phase 3: Determine routing for core agents
      const routing = this.determineRouting(task);
      console.log(`[ChiefOfStaff] Routing: ${routing.primaryAgent} (reason: ${routing.reason})`);

      // Phase 3: Run preflight agents (context-builder)
      let contextOutput: InternalOutput | null = null;

      for (const preflightAgent of routing.preflightAgents) {
        if (signal?.aborted) return;

        this.currentSession.activeAgents.add(preflightAgent);

        if (preflightAgent === "context-builder") {
          const preflightContext = this.buildBaseContext(task, noteContext, null);

          for await (const event of this.contextBuilderAgent.execute(preflightContext, signal)) {
            yield event;

            if (event.type === "complete" && isInternalOutput(event.output)) {
              contextOutput = event.output;
              this.currentSession.completedAgents.set("context-builder", event.output);
            }
          }
        }
      }

      // Phase 4: Build full context with preflight results
      const fullContext = this.buildFullContext(task, noteContext, contextOutput);

      // Phase 5: Execute primary agent
      if (signal?.aborted) return;

      this.currentSession.activeAgents.add(routing.primaryAgent);

      const agent = this.getAgent(routing.primaryAgent);
      for await (const event of agent.execute(fullContext, signal)) {
        yield event;

        if (event.type === "complete") {
          this.currentSession.completedAgents.set(routing.primaryAgent, event.output);
        }
      }
    } finally {
      // Session cleanup happens naturally, no explicit cleanup needed
    }
  }

  /**
   * Execute and aggregate results (non-streaming)
   */
  async executeAndAggregate(
    task: ChiefOfStaffTask,
    signal?: AbortSignal,
  ): Promise<AggregatedResult> {
    const outputs: AgentOutput[] = [];
    const allCitations: string[] = [];
    const proposedActions: ProposedAction[] = [];

    for await (const event of this.execute(task, signal)) {
      if (event.type === "complete") {
        outputs.push(event.output);
      }

      if (event.type === "citations") {
        allCitations.push(...event.paths);
      }
    }

    // Extract actions from structured outputs
    for (const output of outputs) {
      if (isStructuredOutput(output)) {
        const data = output.data as { actions?: ProposedAction[] };
        if (data.actions) {
          proposedActions.push(...data.actions);
        }
      }
    }

    // Find primary output (conversational takes precedence)
    const primaryOutput = outputs.find((o) => o.kind === "conversational") || outputs[0];
    const supportingOutputs = outputs.filter((o) => o !== primaryOutput && o.kind !== "internal");

    return {
      primary: primaryOutput,
      supporting: supportingOutputs,
      session: this.currentSession!,
      allCitations: [...new Set(allCitations)],
      proposedActions,
    };
  }

  /**
   * Update user profile for all agents
   * Propagates profile to enable domain-adapted identity
   */
  setProfile(profile: UserProfile | undefined): void {
    this.profile = profile;

    // Propagate to core agents for identity system
    this.chatAgent.setProfile(profile);
    this.noteEditorAgent.setProfile(profile);
    this.classifierAgent.setProfile(profile);
    this.linkFinderAgent.setProfile(profile);
    this.contextBuilderAgent.setProfile(profile);

    // Propagate to any existing workflow agents
    for (const agent of this.workflowAgents.values()) {
      agent.setProfile(profile);
    }
  }

  /**
   * Update LLM provider
   * Recreates all agents with new LLM while preserving profile
   */
  updateLLM(llm: LLMProvider): void {
    this.llm = llm;

    // Recreate core agents with new LLM and preserved profile
    this.chatAgent = new ChatAgent(llm, this.profile);
    this.noteEditorAgent = new NoteEditorAgent(llm, this.profile);
    this.classifierAgent = new ClassifierAgent(llm, this.profile);
    this.linkFinderAgent = new LinkFinderAgent(llm, this.profile);

    // Context builder keeps its search pipeline reference
    this.contextBuilderAgent = new ContextBuilderAgent(
      llm,
      null, // Will be updated separately via updateSearch
      null,
      this.profile,
    );

    // Clear workflow agents (will be recreated on demand with new LLM)
    this.workflowAgents.clear();

    // Re-wire delegation
    this.chatAgent.setDelegationHandler(this.handleDelegation.bind(this));
  }

  /**
   * Update search pipeline
   */
  updateSearch(pipeline: SearchPipeline | null): void {
    this.contextBuilderAgent.updateSearchPipeline(pipeline);
  }

  /**
   * Update vault context builder
   */
  updateContextBuilder(builder: VaultContextBuilder | null): void {
    this.contextBuilderAgent.updateVaultContextBuilder(builder);
  }

  // ===========================================================================
  // Routing Logic
  // ===========================================================================

  /**
   * Check if this is a simple UI request that doesn't need expert routing.
   *
   * UI requests are handled efficiently by Chat without heavyweight preflight:
   * - No explicit /command
   * - No strong intent signals (edit < 0.5, classify < 0.5, link < 0.5)
   * - Target is "chat" or undefined
   *
   * @returns true if this should be handled as a UI request (simple conversational)
   */
  private isUIRequest(task: ChiefOfStaffTask): boolean {
    // Explicit expert target means NOT a UI request
    if (task.targetAgent && task.targetAgent !== "chat") {
      return false;
    }

    // Explicit workflow target means NOT a UI request
    if (task.targetWorkflow) {
      return false;
    }

    const query = task.query.toLowerCase();

    // Slash commands target specific agents, not UI
    if (query.startsWith("/")) {
      return false;
    }

    // Check intent signals
    const intents = this.detectIntents(query);
    const hasStrongIntent = intents.edit >= 0.5 || intents.classify >= 0.5 || intents.link >= 0.5;

    return !hasStrongIntent;
  }

  /**
   * Check if a UI request is simple enough to skip context-builder preflight.
   *
   * Simple queries that can be answered conversationally without vault search:
   * - Short queries (< 20 words)
   * - No question marks (not a factual question needing vault lookup)
   * - No request keywords (not asking for specific information)
   */
  private isSimpleUIRequest(task: ChiefOfStaffTask): boolean {
    const query = task.query;
    const wordCount = query.split(/\s+/).length;

    // Long queries likely need context
    if (wordCount >= 20) {
      return false;
    }

    // Questions likely need vault search
    if (query.includes("?")) {
      return false;
    }

    // Request keywords suggest needing context
    const requestKeywords = [
      "find",
      "search",
      "show",
      "what",
      "where",
      "when",
      "how",
      "why",
      "tell",
    ];
    const queryLower = query.toLowerCase();
    const hasRequestKeyword = requestKeywords.some((keyword) => queryLower.includes(keyword));

    return !hasRequestKeyword;
  }

  /**
   * Determine which agent should handle this task
   */
  private determineRouting(task: ChiefOfStaffTask): RoutingDecision {
    // Explicit target takes precedence
    if (task.targetAgent) {
      return {
        primaryAgent: task.targetAgent,
        preflightAgents: task.targetAgent === "chat" ? ["context-builder"] : [],
        reason: `Explicit target: ${task.targetAgent}`,
      };
    }

    const query = task.query.toLowerCase();

    // Check for slash commands (explicit intent)
    if (query.startsWith("/")) {
      const command = query.split(" ")[0].slice(1);

      switch (command) {
        case "enhance":
        case "edit":
        case "improve":
          return {
            primaryAgent: "note-editor",
            preflightAgents: ["context-builder"],
            reason: "Slash command: edit/enhance",
          };

        case "classify":
        case "organize":
        case "para":
          return {
            primaryAgent: "classifier",
            preflightAgents: [],
            reason: "Slash command: classify",
          };

        case "connect":
        case "link":
        case "links":
          return {
            primaryAgent: "link-finder",
            preflightAgents: ["context-builder"],
            reason: "Slash command: find links",
          };
      }
    }

    // Check if this is a UI request (conversational, no strong intent)
    if (this.isUIRequest(task)) {
      // For simple UI requests, skip context-builder for efficiency
      const skipPreflight = this.isSimpleUIRequest(task);

      return {
        primaryAgent: "chat",
        preflightAgents: skipPreflight ? [] : ["context-builder"],
        reason: skipPreflight
          ? "UI handling - simple conversational (no preflight)"
          : "UI handling - conversational with context",
      };
    }

    // Intent detection from natural language
    const intents = this.detectIntents(query);

    // Strong edit signals
    if (intents.edit > 0.7) {
      return {
        primaryAgent: "note-editor",
        preflightAgents: ["context-builder"],
        reason: "Detected edit intent",
      };
    }

    // Strong classification signals
    if (intents.classify > 0.7) {
      return {
        primaryAgent: "classifier",
        preflightAgents: [],
        reason: "Detected classification intent",
      };
    }

    // Strong linking signals
    if (intents.link > 0.7) {
      return {
        primaryAgent: "link-finder",
        preflightAgents: ["context-builder"],
        reason: "Detected linking intent",
      };
    }

    // Default: chat with context (has some intent but not strong enough for expert)
    return {
      primaryAgent: "chat",
      preflightAgents: ["context-builder"],
      reason: "Default conversational routing with context",
    };
  }

  /**
   * Detect intents from query
   */
  private detectIntents(query: string): { edit: number; classify: number; link: number } {
    const q = query.toLowerCase();

    const editKeywords = [
      "edit",
      "improve",
      "enhance",
      "fix",
      "restructure",
      "rewrite",
      "add",
      "append",
      "update",
    ];
    const classifyKeywords = [
      "classify",
      "categorize",
      "organize",
      "para",
      "move",
      "tag",
      "folder",
    ];
    const linkKeywords = ["link", "connect", "related", "similar", "connections", "references"];

    const countMatches = (keywords: string[]) =>
      keywords.filter((k) => q.includes(k)).length / keywords.length;

    return {
      edit: countMatches(editKeywords),
      classify: countMatches(classifyKeywords),
      link: countMatches(linkKeywords),
    };
  }

  // ===========================================================================
  // Workflow Execution (Intelligence 2.0)
  // ===========================================================================

  /**
   * Extract workflow type from slash command
   */
  private extractWorkflowType(query: string): WorkflowAgentType | null {
    const command = query.split(" ")[0];
    const config = getWorkflowByCommand(command);
    return config?.type || null;
  }

  /**
   * Execute a workflow agent
   */
  private async *executeWorkflow(
    workflowType: WorkflowAgentType,
    task: ChiefOfStaffTask,
    noteContext: NoteContext,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    // Run context builder first
    let contextOutput: InternalOutput | null = null;
    const preflightContext = this.buildBaseContext(task, noteContext, null);

    for await (const event of this.contextBuilderAgent.execute(preflightContext, signal)) {
      yield event;
      if (event.type === "complete" && isInternalOutput(event.output)) {
        contextOutput = event.output;
      }
    }

    // Build full context for workflow
    const fullContext = this.buildFullContext(task, noteContext, contextOutput);

    // Get or create workflow agent
    const workflowAgent = this.getWorkflowAgent(workflowType);

    // Execute workflow
    for await (const event of workflowAgent.execute(fullContext, signal)) {
      yield event;
    }
  }

  // ===========================================================================
  // Delegation Protocol
  // ===========================================================================

  /**
   * Handle delegation requests from agents
   */
  private async handleDelegation(request: DelegationRequest): Promise<DelegatedResult> {
    const startTime = Date.now();

    if (!this.currentSession) {
      throw new Error("No active session for delegation");
    }

    console.log(`[ChiefOfStaff] Delegation: chat -> ${request.targetAgent}`);

    // Get the target agent
    const targetAgent = this.getAgent(request.targetAgent);
    if (!targetAgent) {
      throw new Error(`Unknown agent: ${request.targetAgent}`);
    }

    // Build context for delegated agent
    const lastContext = this.currentSession.completedAgents.get("context-builder") as
      | InternalOutput
      | undefined;

    // Get note context from previous execution or load fresh
    const noteContext = await this.loadNoteContext(
      this.currentSession.notePath,
      this.currentSession.notePath.split("/").pop()?.replace(".md", "") || "Note",
    );

    if (!noteContext) {
      throw new Error("Failed to load note context for delegation");
    }

    const delegatedContext: AgentContext = {
      currentNote: noteContext,
      query: request.instruction,
      chatHistory: [],
      relatedNotes: lastContext?.relatedNotes,
      contextSummary: lastContext?.contextSummary,
      activeAgents: Array.from(this.currentSession.activeAgents),
      delegationChain: ["chat"],
      para: this.getPARAContext(),
    };

    // Execute delegated agent
    let output: StructuredOutput | null = null;

    for await (const event of targetAgent.execute(delegatedContext)) {
      if (event.type === "complete" && isStructuredOutput(event.output)) {
        output = event.output;
      }
    }

    if (!output) {
      throw new Error(`Delegation to ${request.targetAgent} produced no output`);
    }

    const durationMs = Date.now() - startTime;

    return {
      agentType: request.targetAgent,
      output,
      durationMs,
    };
  }

  // ===========================================================================
  // Context Building
  // ===========================================================================

  /**
   * Load note content from vault
   */
  private async loadNoteContext(notePath: string, noteTitle: string): Promise<NoteContext | null> {
    if (!notePath || notePath === "unknown") {
      return null;
    }

    try {
      const content = await this.obsidian.readFileByPath(notePath);
      if (!content) return null;

      // Extract frontmatter if present
      let frontmatter: Record<string, unknown> | undefined;
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (frontmatterMatch) {
        try {
          // Simple YAML parsing (key: value)
          frontmatter = {};
          const lines = frontmatterMatch[1].split("\n");
          for (const line of lines) {
            const colonIndex = line.indexOf(":");
            if (colonIndex > 0) {
              const key = line.slice(0, colonIndex).trim();
              const value = line.slice(colonIndex + 1).trim();
              frontmatter[key] = value;
            }
          }
        } catch {
          // Ignore frontmatter parse errors
        }
      }

      return {
        title: noteTitle,
        path: notePath,
        content,
        frontmatter,
        wordCount: content.split(/\s+/).length,
      };
    } catch (error) {
      console.warn(`[ChiefOfStaff] Failed to load note ${notePath}:`, error);
      return null;
    }
  }

  /**
   * Build base context (before preflight agents)
   */
  private buildBaseContext(
    task: ChiefOfStaffTask,
    noteContext: NoteContext,
    _contextOutput: InternalOutput | null,
  ): AgentContext {
    return {
      currentNote: noteContext,
      query: task.query,
      chatHistory: task.chatHistory,
      activeAgents: this.currentSession ? Array.from(this.currentSession.activeAgents) : [],
      delegationChain: [],
      para: this.getPARAContext(),
    };
  }

  /**
   * Build full context with preflight results
   */
  private buildFullContext(
    task: ChiefOfStaffTask,
    noteContext: NoteContext,
    contextOutput: InternalOutput | null,
  ): AgentContext {
    return {
      currentNote: noteContext,
      query: task.query,
      chatHistory: task.chatHistory,
      relatedNotes: contextOutput?.relatedNotes,
      contextSummary: contextOutput?.contextSummary,
      search: contextOutput?.searchResults,
      activeAgents: this.currentSession ? Array.from(this.currentSession.activeAgents) : [],
      delegationChain: [],
      para: this.getPARAContext(),
      graph: this.getVaultGraphContext(noteContext.path),
    };
  }

  /**
   * Get PARA context from profile
   */
  private getPARAContext(): PARAContext | undefined {
    if (!this.profile?.para) return undefined;

    return {
      inbox: [], // UserProfile doesn't have inbox field
      projects: this.profile.para.projects || [],
      areas: this.profile.para.areas || [],
      resources: this.profile.para.resources || [],
      archive: this.profile.para.archives || [],
    };
  }

  /**
   * Get vault graph context for a note
   * TODO: Integrate with actual vault graph when available
   */
  private getVaultGraphContext(notePath: string): VaultGraphContext | undefined {
    // Placeholder - would integrate with actual vault graph service
    return {
      backlinks: [],
      outlinks: [],
      orphans: [],
      hubs: [],
    };
  }

  // ===========================================================================
  // Session Management
  // ===========================================================================

  /**
   * Create a new agent session
   */
  private createSession(notePath: string): AgentSession {
    return {
      id: crypto.randomUUID(),
      activeAgents: new Set(),
      completedAgents: new Map(),
      startedAt: new Date(),
      notePath,
    };
  }

  /**
   * Get agent instance by type
   */
  private getAgent(
    type: AgentType,
  ): ChatAgent | NoteEditorAgent | ClassifierAgent | LinkFinderAgent | ContextBuilderAgent {
    switch (type) {
      case "chat":
        return this.chatAgent;
      case "note-editor":
        return this.noteEditorAgent;
      case "classifier":
        return this.classifierAgent;
      case "link-finder":
        return this.linkFinderAgent;
      case "context-builder":
        return this.contextBuilderAgent;
      default:
        throw new Error(`Unknown agent type: ${type}`);
    }
  }

  /**
   * Get current session info
   */
  getCurrentSession(): AgentSession | null {
    return this.currentSession;
  }

  /**
   * Check if an agent is currently active
   */
  isAgentActive(type: AgentType): boolean {
    return this.currentSession?.activeAgents.has(type) ?? false;
  }

  /**
   * Get agent configuration
   */
  getAgentConfig(type: AgentType) {
    return AGENT_CONFIGS[type];
  }
}
