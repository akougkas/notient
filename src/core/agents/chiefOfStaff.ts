/**
 * Chief of Staff - The Orchestrator (Brain)
 *
 * 4-Agent Swarm Architecture:
 * - User = President (decision maker)
 * - Orchestrator = This class (reasoning brain, makes plans, delegates)
 * - NoteEditor = Obsidian I/O specialist
 * - ContextBuilder = Vault awareness specialist
 * - Worker = Workflow executor (Phase 2)
 *
 * Responsibilities:
 * 1. Receive requests from three triggers (UI, Chat, Editor)
 * 2. Reason about WHAT to do (action planning)
 * 3. Delegate to specialized agents
 * 4. Aggregate results and return to caller
 *
 * The Orchestrator does NOT execute workflows directly - it delegates HOW
 * to specialized agents (NoteEditor, ContextBuilder, Worker).
 */

import type { ObsidianFacade } from "../../adapters/obsidianFacade";
import type { UserProfile } from "../../types/profile";
import type { ProposedAction } from "../agentic/types";
import type { VaultContextBuilder } from "../context/vaultContextBuilder";
import { generateId } from "../ids";
import type { LLMProvider } from "../llm/provider";
import type { SearchPipeline } from "../search/pipeline";
import { SkillRegistry } from "../skills/registry";
import { isInternalOutput, isStructuredOutput } from "./base";
import { ContextBuilderAgent } from "./contextBuilderAgent";
import { NoteEditorAgent } from "./noteEditorAgent";
import type {
  AgentContext,
  AgentEvent,
  AgentOutput,
  AgentSession,
  AgentType,
  AggregatedResult,
  ExpertAgentType,
  InternalOutput,
  NoteContext,
  OrchestratorPlan,
  OrchestratorRequest,
  PARAContext,
  RoutingDecision,
  StructuredOutput,
  VaultGraphContext,
} from "./types";
import { AGENT_CONFIGS } from "./types";
import {
  WorkerAgent,
  type WorkflowAgentType,
  getWorkflowByCommand,
  isWorkflowCommand,
} from "./workerAgent";

/**
 * Task input for the Orchestrator
 * @deprecated Use OrchestratorRequest for new code
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
 * The Orchestrator - Central reasoning brain of the 4-Agent Swarm
 *
 * Key principle: Orchestrator reasons about WHAT to do. Other agents decide HOW.
 */
export class ChiefOfStaff {
  // Specialized Agents (4-Agent Swarm)
  private noteEditorAgent: NoteEditorAgent;
  private contextBuilderAgent: ContextBuilderAgent;

  // Worker Agents (Swarm) - created on demand per workflow type
  private workerAgents: Map<WorkflowAgentType, WorkerAgent> = new Map();

  // Services
  private llm: LLMProvider;
  private obsidian: ObsidianFacade;
  private profile?: UserProfile;
  private skillRegistry: SkillRegistry;

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
    this.skillRegistry = new SkillRegistry();

    // Initialize specialized agents (4-Agent Swarm)
    this.noteEditorAgent = new NoteEditorAgent(llm, profile, this.skillRegistry);
    this.contextBuilderAgent = new ContextBuilderAgent(
      llm,
      searchPipeline,
      vaultContextBuilder,
      obsidian,
      profile,
    );
  }

  /**
   * Get or create a worker agent for a specific workflow type.
   * Worker agents are cached per workflow type for reuse.
   */
  private getWorkerAgent(workflowType: WorkflowAgentType): WorkerAgent {
    let agent = this.workerAgents.get(workflowType);
    if (!agent) {
      agent = new WorkerAgent(this.llm, workflowType, this.profile);
      this.workerAgents.set(workflowType, agent);
    }
    return agent;
  }

  // ===========================================================================
  // Orchestrator Public API (4-Agent Swarm)
  // ===========================================================================

  /**
   * Handle a request from any of the three triggers (UI, Chat, Editor)
   * This is the primary entry point for the 4-Agent Swarm architecture.
   */
  async *handleRequest(
    request: OrchestratorRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    console.log(`[Orchestrator] Handling request from ${request.source}`);

    // Load note context if not provided
    const noteContext = request.noteContext;
    if (!noteContext && request.intent) {
      // Try to get note context from the request or current active note
      // For now, we require noteContext to be provided
    }

    // Create session
    const notePath = noteContext?.path || "unknown";
    this.currentSession = this.createSession(notePath);

    // Plan the action
    const plan = await this.planAction(request);
    console.log(`[Orchestrator] Plan: ${plan.action} → ${plan.targetAgent || "self"}`);

    // Execute based on plan
    if (plan.action === "delegate" && plan.targetAgent) {
      yield* this.delegate(plan.targetAgent, plan.task || request.intent, noteContext, signal);
    } else if (plan.action === "respond") {
      // Direct response (no delegation needed)
      yield {
        type: "complete",
        agentType: "orchestrator" as AgentType,
        output: {
          kind: "conversational",
          content: plan.reasoning,
          citations: [],
        },
      };
    } else if (plan.action === "clarify") {
      // Need more information from user
      yield {
        type: "complete",
        agentType: "orchestrator" as AgentType,
        output: {
          kind: "conversational",
          content: plan.reasoning,
          citations: [],
        },
      };
    }
  }

  /**
   * Plan what action to take based on the request.
   * Uses LLM reasoning to determine the best course of action.
   */
  async planAction(request: OrchestratorRequest): Promise<OrchestratorPlan> {
    // Fast-path: Check for explicit commands first (no LLM needed)
    const intent = request.intent.toLowerCase();

    // Slash commands → direct routing
    if (intent.startsWith("/")) {
      const command = intent.split(" ")[0].slice(1);

      // Edit commands → NoteEditor
      if (["enhance", "edit", "improve"].includes(command)) {
        return {
          action: "delegate",
          targetAgent: "note-editor",
          task: request.intent,
          reasoning: `Slash command /${command} routes to NoteEditor`,
        };
      }

      // Classification commands → Worker (Phase 2, for now uses legacy routing)
      if (["classify", "organize", "para"].includes(command)) {
        return {
          action: "delegate",
          targetAgent: "worker", // Will use legacy classifier in Phase 2
          task: request.intent,
          reasoning: `Slash command /${command} routes to Worker (classifier workflow)`,
        };
      }

      // Connection commands → Worker (Phase 2, for now uses legacy routing)
      if (["connect", "link", "links"].includes(command)) {
        return {
          action: "delegate",
          targetAgent: "worker", // Will use legacy connection in Phase 2
          task: request.intent,
          reasoning: `Slash command /${command} routes to Worker (connection workflow)`,
        };
      }
    }

    // Intent detection for natural language
    const intents = this.detectIntents(intent);

    if (intents.edit >= 0.5) {
      return {
        action: "delegate",
        targetAgent: "note-editor",
        task: request.intent,
        reasoning: "Detected edit intent from natural language",
      };
    }

    if (intents.classify >= 0.5 || intents.link >= 0.5) {
      return {
        action: "delegate",
        targetAgent: "worker",
        task: request.intent,
        reasoning: "Detected workflow intent (classify/connect)",
      };
    }

    // If we can't determine intent, ask for clarification
    // In Phase 2, this will use LLM reasoning for more nuanced planning
    return {
      action: "clarify",
      reasoning:
        "I'm not sure what you'd like me to do. Could you be more specific? " +
        "Try commands like /enhance, /classify, or /connect.",
    };
  }

  /**
   * Delegate a task to a specialized agent.
   * Returns a stream of events from the delegated agent.
   */
  async *delegate(
    targetAgent: "note-editor" | "context-builder" | "worker",
    task: string,
    noteContext?: NoteContext,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    console.log(`[Orchestrator] Delegating to ${targetAgent}: ${task.slice(0, 50)}...`);

    // Build context for the agent
    const agentContext: AgentContext = {
      currentNote: noteContext || {
        title: "Unknown",
        path: "unknown",
        content: "",
      },
      query: task,
      chatHistory: [],
      activeAgents: [targetAgent],
      delegationChain: ["orchestrator" as AgentType, targetAgent],
    };

    // For now, always run context-builder first to get context
    // (unless we're already calling context-builder)
    if (targetAgent !== "context-builder" && noteContext) {
      const contextOutput = await this.runContextBuilder(agentContext, signal);
      if (contextOutput) {
        agentContext.relatedNotes = contextOutput.relatedNotes;
        agentContext.contextSummary = contextOutput.contextSummary;
        agentContext.search = contextOutput.searchResults;
      }
    }

    // Dispatch to the target agent
    switch (targetAgent) {
      case "note-editor":
        yield* this.noteEditorAgent.execute(agentContext, signal);
        break;
      case "context-builder":
        yield* this.contextBuilderAgent.execute(agentContext, signal);
        break;
      case "worker":
        // Phase 2: Will route to WorkerAgent
        // For now, fall back to legacy routing based on task content
        yield* this.delegateToLegacyAgent(task, agentContext, signal);
        break;
    }
  }

  /**
   * Helper to run context builder and get output
   */
  private async runContextBuilder(
    context: AgentContext,
    signal?: AbortSignal,
  ): Promise<InternalOutput | null> {
    let output: InternalOutput | null = null;
    for await (const event of this.contextBuilderAgent.execute(context, signal)) {
      if (event.type === "complete" && isInternalOutput(event.output)) {
        output = event.output;
      }
    }
    return output;
  }

  /**
   * Temporary: Route to legacy agents based on task content
   * This will be replaced by WorkerAgent in Phase 2
   */
  private async *delegateToLegacyAgent(
    task: string,
    context: AgentContext,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    const taskLower = task.toLowerCase();

    // Route connection tasks to Worker
    if (
      taskLower.includes("connect") ||
      taskLower.includes("link") ||
      taskLower.includes("/connect") ||
      taskLower.includes("/link")
    ) {
      const worker = this.getWorkerAgent("connection");
      yield* worker.execute(context, signal);
      return;
    }

    // Check for workflow commands (includes classify via /enhance)
    const workflowType = this.extractWorkflowType(task);
    if (workflowType) {
      const workflowAgent = this.getWorkerAgent(workflowType);
      yield* workflowAgent.execute(context, signal);
      return;
    }

    // Default: error - no matching agent
    yield {
      type: "error",
      agentType: "orchestrator" as AgentType,
      error: new Error(`No agent found to handle task: ${task.slice(0, 50)}...`),
    };
  }

  // ===========================================================================
  // Legacy Public API (for backward compatibility)
  // ===========================================================================

  /**
   * Execute a task with streaming events
   * @deprecated Use handleRequest() for new code
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

    // Propagate to specialized agents for identity system
    this.noteEditorAgent.setProfile(profile);
    this.contextBuilderAgent.setProfile(profile);

    // Propagate to any existing worker agents
    for (const agent of this.workerAgents.values()) {
      agent.setProfile(profile);
    }
  }

  /**
   * Update LLM provider
   * Recreates all agents with new LLM while preserving profile
   */
  updateLLM(llm: LLMProvider): void {
    this.llm = llm;

    // Recreate specialized agents with new LLM and preserved profile
    this.noteEditorAgent = new NoteEditorAgent(llm, this.profile, this.skillRegistry);

    // Context builder keeps its search pipeline reference
    this.contextBuilderAgent = new ContextBuilderAgent(
      llm,
      null, // Will be updated separately via updateSearch
      null,
      this.obsidian,
      this.profile,
    );

    // Clear worker agents (will be recreated on demand with new LLM)
    this.workerAgents.clear();
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
      const needsContext = task.targetAgent !== "worker";
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
            primaryAgent: "worker",
            preflightAgents: [],
            reason: "Slash command: classify",
          };
          return result;
        }

        case "connect":
        case "link":
        case "links": {
          const result: RoutingDecision = {
            primaryAgent: "worker",
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
        primaryAgent: "worker",
        preflightAgents: [],
        reason: "Detected classification intent",
      };
      return result;
    }

    // Strong linking signals
    if (intents.link >= 0.5) {
      const result: RoutingDecision = {
        primaryAgent: "worker",
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
      // Canvas/Base creation intents are edit intents
      "create",
      "make",
      "canvas",
      "diagram",
      "base",
      "view",
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

    // Get or create worker agent for this workflow type
    const workerAgent = this.getWorkerAgent(workflowType);

    // Execute workflow via worker agent
    for await (const event of workerAgent.execute(fullContext, signal)) {
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
   * Get specialized agent instance by type
   */
  private getAgent(type: ExpertAgentType): NoteEditorAgent | ContextBuilderAgent {
    switch (type) {
      case "note-editor":
        return this.noteEditorAgent;
      case "context-builder":
        return this.contextBuilderAgent;
      default:
        throw new Error(`Unknown agent type: ${type}. Use getWorkerAgent() for workflows.`);
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
