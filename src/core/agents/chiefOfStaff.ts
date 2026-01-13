/**
 * Chief of Staff - Central Agent Coordinator
 *
 * White House Model:
 * - President = User (decision maker)
 * - Chief of Staff = This class (coordinator, dispatcher, router, aggregator)
 * - Department Heads = Specialized expert agents
 *
 * Responsibilities:
 * 1. Route tasks to appropriate expert agents
 * 2. Build context before agent execution
 * 3. Aggregate results from multiple agents
 * 4. Manage agent sessions for awareness
 *
 * NOTE: Chat is NOT routed through ChiefOfStaff. The Chat UI uses ChatService
 * directly. ChiefOfStaff only routes to expert agents (note-editor, classifier,
 * connection, context-builder) via explicit commands or strong intent signals.
 */

import type { ObsidianFacade } from "../../adapters/obsidianFacade";
import type { UserProfile } from "../../types/profile";
import type { ProposedAction } from "../agentic/types";
import type { VaultContextBuilder } from "../context/vaultContextBuilder";
import { generateId } from "../ids";
import type { LLMProvider } from "../llm/provider";
import type { SearchPipeline } from "../search/pipeline";
import { isInternalOutput, isStructuredOutput } from "./base";
import { ClassifierAgent } from "./classifierAgent";
import { ConnectionAgent } from "./connectionAgent";
import { ContextBuilderAgent } from "./contextBuilderAgent";
import { NoteEditorAgent } from "./noteEditorAgent";
import type {
  AgentContext,
  AgentEvent,
  AgentOutput,
  AgentSession,
  AggregatedResult,
  ExpertAgentType,
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
  /** Optional explicit expert agent target (bypasses routing) */
  targetAgent?: ExpertAgentType;
  /** Optional explicit workflow target (for slash commands) */
  targetWorkflow?: WorkflowAgentType;
}

/**
 * Chief of Staff - Central agent coordinator
 */
export class ChiefOfStaff {
  // Expert Agents (Department Heads)
  private noteEditorAgent: NoteEditorAgent;
  private classifierAgent: ClassifierAgent;
  private connectionAgent: ConnectionAgent;
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

    // Initialize expert agents (Department Heads) with profile for identity system
    this.noteEditorAgent = new NoteEditorAgent(llm, profile);
    this.classifierAgent = new ClassifierAgent(llm, profile);
    this.connectionAgent = new ConnectionAgent(llm, profile);
    this.contextBuilderAgent = new ContextBuilderAgent(
      llm,
      searchPipeline,
      vaultContextBuilder,
      profile,
    );
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
    console.log("[ChiefOfStaff] Execute START");
    this.currentSession = this.createSession(task.notePath);

    // Phase 1: Load current note content
    const noteContext = await this.loadNoteContext(task.notePath, task.noteTitle);
    if (!noteContext) {
      yield this.createNoteLoadError();
      return;
    }

    // Phase 2: Check for workflow commands first
    if (this.shouldExecuteWorkflow(task)) {
      const workflowType = task.targetWorkflow || this.extractWorkflowType(task.query);
      if (workflowType) {
        console.log(`[ChiefOfStaff] Executing workflow: ${workflowType}`);
        yield* this.executeWorkflow(workflowType, task, noteContext, signal);
        console.log("[ChiefOfStaff] Execute END");
        return;
      }
    }

    // Phase 3: Determine routing and run preflight agents
    const routing = this.determineRouting(task);
    console.log(`[ChiefOfStaff] Routing: ${routing.primaryAgent} (reason: ${routing.reason})`);

    const contextOutput = await this.runPreflightAgentsWithEvents(
      task,
      noteContext,
      routing,
      signal,
      (event) => this.emitEvent(event),
    );
    yield* this.getPreflightEvents();
    if (signal?.aborted) return;

    // Phase 4: Execute primary agent
    yield* this.executePrimaryAgent(task, noteContext, routing, contextOutput, signal);
    console.log("[ChiefOfStaff] Execute END");
  }

  // Temporary event buffer for preflight phase
  private preflightEventBuffer: AgentEvent[] = [];

  /**
   * Check if task should be handled as a workflow
   */
  private shouldExecuteWorkflow(task: ChiefOfStaffTask): boolean {
    const result = Boolean(task.targetWorkflow || isWorkflowCommand(task.query.split(" ")[0]));
    return result;
  }

  /**
   * Create error event for failed note load
   */
  private createNoteLoadError(): AgentEvent {
    const result = {
      type: "error" as const,
      agentType: "context-builder" as const,
      error: new Error("Failed to load note"),
    };
    return result;
  }

  /**
   * Emit event to buffer during preflight
   */
  private emitEvent(event: AgentEvent): void {
    this.preflightEventBuffer.push(event);
  }

  /**
   * Get buffered preflight events
   */
  private async *getPreflightEvents(): AsyncIterable<AgentEvent> {
    let yieldCount = 0;
    for (const event of this.preflightEventBuffer) {
      yieldCount++;
      yield event;
    }
    this.preflightEventBuffer = [];
  }

  /**
   * Run preflight agents and collect context output
   */
  private async runPreflightAgentsWithEvents(
    task: ChiefOfStaffTask,
    noteContext: NoteContext,
    routing: RoutingDecision,
    signal: AbortSignal | undefined,
    onEvent: (event: AgentEvent) => void,
  ): Promise<InternalOutput | null> {
    let contextOutput: InternalOutput | null = null;

    for (const preflightAgent of routing.preflightAgents) {
      if (signal?.aborted) {
        break;
      }
      if (preflightAgent !== "context-builder") {
        continue;
      }

      this.currentSession?.activeAgents.add(preflightAgent);
      const preflightContext = this.buildBaseContext(task, noteContext, null);

      for await (const event of this.contextBuilderAgent.execute(preflightContext, signal)) {
        onEvent(event);
        if (event.type === "complete" && isInternalOutput(event.output)) {
          contextOutput = event.output;
          this.currentSession?.completedAgents.set("context-builder", event.output);
        }
      }
    }

    return contextOutput;
  }

  /**
   * Execute the primary agent with full context
   */
  private async *executePrimaryAgent(
    task: ChiefOfStaffTask,
    noteContext: NoteContext,
    routing: RoutingDecision,
    contextOutput: InternalOutput | null,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    if (signal?.aborted) return;

    this.currentSession?.activeAgents.add(routing.primaryAgent);
    const fullContext = this.buildFullContext(task, noteContext, contextOutput);

    const agent = this.getAgent(routing.primaryAgent);
    for await (const event of agent.execute(fullContext, signal)) {
      yield event;
      if (event.type === "complete") {
        console.log(`[ChiefOfStaff] Agent completed: ${routing.primaryAgent}`);
        this.currentSession?.completedAgents.set(routing.primaryAgent, event.output);
      }
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

    // Session should always exist after execute() completes
    if (!this.currentSession) {
      throw new Error("Session not initialized after execute()");
    }

    return {
      primary: primaryOutput,
      supporting: supportingOutputs,
      session: this.currentSession,
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

    // Propagate to expert agents for identity system
    this.noteEditorAgent.setProfile(profile);
    this.classifierAgent.setProfile(profile);
    this.connectionAgent.setProfile(profile);
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

    // Recreate expert agents with new LLM and preserved profile
    this.noteEditorAgent = new NoteEditorAgent(llm, this.profile);
    this.classifierAgent = new ClassifierAgent(llm, this.profile);
    this.connectionAgent = new ConnectionAgent(llm, this.profile);

    // Context builder keeps its search pipeline reference
    this.contextBuilderAgent = new ContextBuilderAgent(
      llm,
      null, // Will be updated separately via updateSearch
      null,
      this.profile,
    );

    // Clear workflow agents (will be recreated on demand with new LLM)
    this.workflowAgents.clear();
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
   * Determine which expert agent should handle this task.
   * Only routes to expert agents. Throws if no expert agent matches.
   */
  private determineRouting(task: ChiefOfStaffTask): RoutingDecision {
    // Explicit target takes precedence
    if (task.targetAgent) {
      const needsContext = task.targetAgent !== "classifier";
      const result: RoutingDecision = {
        primaryAgent: task.targetAgent,
        preflightAgents: needsContext ? ["context-builder"] : [],
        reason: `Explicit target: ${task.targetAgent}`,
      };
      return result;
    }

    const query = task.query.toLowerCase();

    // Check for slash commands (explicit intent)
    if (query.startsWith("/")) {
      const command = query.split(" ")[0].slice(1);

      switch (command) {
        case "enhance":
        case "edit":
        case "improve": {
          const result: RoutingDecision = {
            primaryAgent: "note-editor",
            preflightAgents: ["context-builder"],
            reason: "Slash command: edit/enhance",
          };
          return result;
        }

        case "classify":
        case "organize":
        case "para": {
          const result: RoutingDecision = {
            primaryAgent: "classifier",
            preflightAgents: [],
            reason: "Slash command: classify",
          };
          return result;
        }

        case "connect":
        case "link":
        case "links": {
          const result: RoutingDecision = {
            primaryAgent: "connection",
            preflightAgents: ["context-builder"],
            reason: "Slash command: find connections",
          };
          return result;
        }
      }
    }

    // Intent detection from natural language
    const intents = this.detectIntents(query);

    // Strong edit signals
    if (intents.edit >= 0.5) {
      const result: RoutingDecision = {
        primaryAgent: "note-editor",
        preflightAgents: ["context-builder"],
        reason: "Detected edit intent",
      };
      return result;
    }

    // Strong classification signals
    if (intents.classify >= 0.5) {
      const result: RoutingDecision = {
        primaryAgent: "classifier",
        preflightAgents: [],
        reason: "Detected classification intent",
      };
      return result;
    }

    // Strong linking signals
    if (intents.link >= 0.5) {
      const result: RoutingDecision = {
        primaryAgent: "connection",
        preflightAgents: ["context-builder"],
        reason: "Detected connection intent",
      };
      return result;
    }

    // No expert agent matches - this should not be routed through ChiefOfStaff
    throw new Error(
      `No expert agent matched for query: "${task.query.slice(0, 50)}...". Conversational requests should use ChatService directly, not ChiefOfStaff.`,
    );
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

    const result = {
      edit: countMatches(editKeywords),
      classify: countMatches(classifyKeywords),
      link: countMatches(linkKeywords),
    };
    return result;
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
    const result = config?.type || null;
    return result;
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
      if (!content) {
        return null;
      }

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

      const result = {
        title: noteTitle,
        path: notePath,
        content,
        frontmatter,
        wordCount: content.split(/\s+/).length,
      };
      return result;
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
    const result = {
      currentNote: noteContext,
      query: task.query,
      chatHistory: task.chatHistory,
      activeAgents: this.currentSession ? Array.from(this.currentSession.activeAgents) : [],
      delegationChain: [],
      para: this.getPARAContext(),
    };
    return result;
  }

  /**
   * Build full context with preflight results
   */
  private buildFullContext(
    task: ChiefOfStaffTask,
    noteContext: NoteContext,
    contextOutput: InternalOutput | null,
  ): AgentContext {
    const result = {
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
    return result;
  }

  /**
   * Get PARA context from profile
   */
  private getPARAContext(): PARAContext | undefined {
    if (!this.profile?.para) {
      return undefined;
    }

    const result = {
      inbox: [], // UserProfile doesn't have inbox field
      projects: this.profile.para.projects || [],
      areas: this.profile.para.areas || [],
      resources: this.profile.para.resources || [],
      archive: this.profile.para.archives || [],
    };
    return result;
  }

  /**
   * Get vault graph context for a note
   * TODO: Integrate with actual vault graph when available
   */
  private getVaultGraphContext(notePath: string): VaultGraphContext | undefined {
    // Placeholder - would integrate with actual vault graph service
    const result = {
      backlinks: [],
      outlinks: [],
      orphans: [],
      hubs: [],
    };
    return result;
  }

  // ===========================================================================
  // Session Management
  // ===========================================================================

  /**
   * Create a new agent session
   */
  private createSession(notePath: string): AgentSession {
    const result = {
      id: generateId("ses"),
      activeAgents: new Set<ExpertAgentType>(),
      completedAgents: new Map(),
      startedAt: new Date(),
      notePath,
    };
    return result;
  }

  /**
   * Get expert agent instance by type
   */
  private getAgent(
    type: ExpertAgentType,
  ): NoteEditorAgent | ClassifierAgent | ConnectionAgent | ContextBuilderAgent {
    let result: NoteEditorAgent | ClassifierAgent | ConnectionAgent | ContextBuilderAgent;
    switch (type) {
      case "note-editor":
        result = this.noteEditorAgent;
        break;
      case "classifier":
        result = this.classifierAgent;
        break;
      case "connection":
        result = this.connectionAgent;
        break;
      case "context-builder":
        result = this.contextBuilderAgent;
        break;
      default:
        throw new Error(`Unknown expert agent type: ${type}`);
    }
    return result;
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
  isAgentActive(type: ExpertAgentType): boolean {
    const result = this.currentSession?.activeAgents.has(type) ?? false;
    return result;
  }

  /**
   * Get agent configuration
   */
  getAgentConfig(type: ExpertAgentType) {
    const result = AGENT_CONFIGS[type];
    return result;
  }
}
