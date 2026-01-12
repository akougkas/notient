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
    console.log("[chiefOfStaff:constructor] TRACE: START");
    this.llm = llm;
    this.obsidian = obsidian;
    this.profile = profile;

    // Initialize expert agents (Department Heads) with profile for identity system
    console.log("[chiefOfStaff:constructor] TRACE: creating NoteEditorAgent");
    this.noteEditorAgent = new NoteEditorAgent(llm, profile);
    console.log("[chiefOfStaff:constructor] TRACE: creating ClassifierAgent");
    this.classifierAgent = new ClassifierAgent(llm, profile);
    console.log("[chiefOfStaff:constructor] TRACE: creating ConnectionAgent");
    this.connectionAgent = new ConnectionAgent(llm, profile);
    console.log("[chiefOfStaff:constructor] TRACE: creating ContextBuilderAgent");
    this.contextBuilderAgent = new ContextBuilderAgent(
      llm,
      searchPipeline,
      vaultContextBuilder,
      profile,
    );
    console.log("[chiefOfStaff:constructor] TRACE: END");
  }

  /**
   * Get or create a workflow agent
   */
  private getWorkflowAgent(workflowType: WorkflowAgentType): WorkflowAgent {
    console.log(`[chiefOfStaff:getWorkflowAgent] TRACE: START workflowType=${workflowType}`);
    let agent = this.workflowAgents.get(workflowType);
    if (!agent) {
      console.log("[chiefOfStaff:getWorkflowAgent] TRACE: creating new WorkflowAgent");
      agent = new WorkflowAgent(this.llm, workflowType, this.profile);
      this.workflowAgents.set(workflowType, agent);
    }
    console.log("[chiefOfStaff:getWorkflowAgent] TRACE: END");
    return agent;
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Execute a task with streaming events
   */
  async *execute(task: ChiefOfStaffTask, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    console.log("[ChiefOfStaff] TRACE: execute START");
    this.currentSession = this.createSession(task.notePath);

    // Phase 1: Load current note content
    console.log("[ChiefOfStaff] TRACE: Loading note context");
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
        return;
      }
    }

    // Phase 3: Determine routing and run preflight agents
    const routing = this.determineRouting(task);
    console.log(`[ChiefOfStaff] Routing: ${routing.primaryAgent} (reason: ${routing.reason})`);

    console.log("[ChiefOfStaff] TRACE: Running preflight agents");
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
    console.log("[ChiefOfStaff] TRACE: About to executePrimaryAgent");
    yield* this.executePrimaryAgent(task, noteContext, routing, contextOutput, signal);
    console.log("[ChiefOfStaff] TRACE: execute END - all done");
  }

  // Temporary event buffer for preflight phase
  private preflightEventBuffer: AgentEvent[] = [];

  /**
   * Check if task should be handled as a workflow
   */
  private shouldExecuteWorkflow(task: ChiefOfStaffTask): boolean {
    console.log("[chiefOfStaff:shouldExecuteWorkflow] TRACE: START");
    const result = Boolean(task.targetWorkflow || isWorkflowCommand(task.query.split(" ")[0]));
    console.log(`[chiefOfStaff:shouldExecuteWorkflow] TRACE: END result=${result}`);
    return result;
  }

  /**
   * Create error event for failed note load
   */
  private createNoteLoadError(): AgentEvent {
    console.log("[chiefOfStaff:createNoteLoadError] TRACE: START");
    const result = {
      type: "error" as const,
      agentType: "context-builder" as const,
      error: new Error("Failed to load note"),
    };
    console.log("[chiefOfStaff:createNoteLoadError] TRACE: END");
    return result;
  }

  /**
   * Emit event to buffer during preflight
   */
  private emitEvent(event: AgentEvent): void {
    console.log(`[chiefOfStaff:emitEvent] TRACE: START eventType=${event.type}`);
    this.preflightEventBuffer.push(event);
    console.log(
      `[chiefOfStaff:emitEvent] TRACE: END bufferSize=${this.preflightEventBuffer.length}`,
    );
  }

  /**
   * Get buffered preflight events
   */
  private async *getPreflightEvents(): AsyncIterable<AgentEvent> {
    console.log(
      `[chiefOfStaff:getPreflightEvents] TRACE: START bufferSize=${this.preflightEventBuffer.length}`,
    );
    let yieldCount = 0;
    for (const event of this.preflightEventBuffer) {
      yieldCount++;
      console.log(
        `[chiefOfStaff:getPreflightEvents] TRACE: yielding event ${yieldCount} type=${event.type}`,
      );
      yield event;
      console.log(`[chiefOfStaff:getPreflightEvents] TRACE: yielded event ${yieldCount}`);
    }
    this.preflightEventBuffer = [];
    console.log(`[chiefOfStaff:getPreflightEvents] TRACE: END yielded ${yieldCount} events`);
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
    console.log(
      `[chiefOfStaff:runPreflightAgentsWithEvents] TRACE: START preflightAgents=${routing.preflightAgents.join(",")}`,
    );
    let contextOutput: InternalOutput | null = null;

    for (const preflightAgent of routing.preflightAgents) {
      console.log(
        `[chiefOfStaff:runPreflightAgentsWithEvents] TRACE: processing preflightAgent=${preflightAgent}`,
      );
      if (signal?.aborted) {
        console.log("[chiefOfStaff:runPreflightAgentsWithEvents] TRACE: aborted");
        break;
      }
      if (preflightAgent !== "context-builder") {
        console.log(
          "[chiefOfStaff:runPreflightAgentsWithEvents] TRACE: skipping non-context-builder",
        );
        continue;
      }

      this.currentSession?.activeAgents.add(preflightAgent);
      console.log("[chiefOfStaff:runPreflightAgentsWithEvents] TRACE: building base context");
      const preflightContext = this.buildBaseContext(task, noteContext, null);

      console.log(
        "[chiefOfStaff:runPreflightAgentsWithEvents] TRACE: starting contextBuilderAgent.execute for-await loop",
      );
      for await (const event of this.contextBuilderAgent.execute(preflightContext, signal)) {
        console.log(
          `[chiefOfStaff:runPreflightAgentsWithEvents] TRACE: received event type=${event.type}`,
        );
        onEvent(event);
        if (event.type === "complete" && isInternalOutput(event.output)) {
          console.log("[chiefOfStaff:runPreflightAgentsWithEvents] TRACE: got context output");
          contextOutput = event.output;
          this.currentSession?.completedAgents.set("context-builder", event.output);
        }
      }
      console.log(
        "[chiefOfStaff:runPreflightAgentsWithEvents] TRACE: finished contextBuilderAgent.execute loop",
      );
    }

    console.log(
      `[chiefOfStaff:runPreflightAgentsWithEvents] TRACE: END hasContextOutput=${!!contextOutput}`,
    );
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
    console.log("[ChiefOfStaff] TRACE: executePrimaryAgent START");
    if (signal?.aborted) return;

    this.currentSession?.activeAgents.add(routing.primaryAgent);
    const fullContext = this.buildFullContext(task, noteContext, contextOutput);

    const agent = this.getAgent(routing.primaryAgent);
    console.log("[ChiefOfStaff] TRACE: Starting agent.execute for-await loop");
    for await (const event of agent.execute(fullContext, signal)) {
      console.log(`[ChiefOfStaff] TRACE: Yielding event type=${event.type}`);
      yield event;
      if (event.type === "complete") {
        console.log("[ChiefOfStaff] TRACE: Complete event - setting completedAgents");
        this.currentSession?.completedAgents.set(routing.primaryAgent, event.output);
      }
    }
    console.log("[ChiefOfStaff] TRACE: executePrimaryAgent END - loop finished");
  }

  /**
   * Execute and aggregate results (non-streaming)
   */
  async executeAndAggregate(
    task: ChiefOfStaffTask,
    signal?: AbortSignal,
  ): Promise<AggregatedResult> {
    console.log("[chiefOfStaff:executeAndAggregate] TRACE: START");
    const outputs: AgentOutput[] = [];
    const allCitations: string[] = [];
    const proposedActions: ProposedAction[] = [];

    console.log("[chiefOfStaff:executeAndAggregate] TRACE: starting execute for-await loop");
    for await (const event of this.execute(task, signal)) {
      console.log(`[chiefOfStaff:executeAndAggregate] TRACE: received event type=${event.type}`);
      if (event.type === "complete") {
        outputs.push(event.output);
      }

      if (event.type === "citations") {
        allCitations.push(...event.paths);
      }
    }
    console.log(
      `[chiefOfStaff:executeAndAggregate] TRACE: execute loop finished, outputs=${outputs.length}`,
    );

    // Extract actions from structured outputs
    console.log("[chiefOfStaff:executeAndAggregate] TRACE: extracting actions from outputs");
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
      console.log("[chiefOfStaff:executeAndAggregate] TRACE: ERROR no session");
      throw new Error("Session not initialized after execute()");
    }

    console.log("[chiefOfStaff:executeAndAggregate] TRACE: END");
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
    console.log(`[chiefOfStaff:setProfile] TRACE: START hasProfile=${!!profile}`);
    this.profile = profile;

    // Propagate to expert agents for identity system
    console.log("[chiefOfStaff:setProfile] TRACE: propagating to expert agents");
    this.noteEditorAgent.setProfile(profile);
    this.classifierAgent.setProfile(profile);
    this.connectionAgent.setProfile(profile);
    this.contextBuilderAgent.setProfile(profile);

    // Propagate to any existing workflow agents
    console.log(
      `[chiefOfStaff:setProfile] TRACE: propagating to ${this.workflowAgents.size} workflow agents`,
    );
    for (const agent of this.workflowAgents.values()) {
      agent.setProfile(profile);
    }
    console.log("[chiefOfStaff:setProfile] TRACE: END");
  }

  /**
   * Update LLM provider
   * Recreates all agents with new LLM while preserving profile
   */
  updateLLM(llm: LLMProvider): void {
    console.log("[chiefOfStaff:updateLLM] TRACE: START");
    this.llm = llm;

    // Recreate expert agents with new LLM and preserved profile
    console.log("[chiefOfStaff:updateLLM] TRACE: recreating expert agents");
    this.noteEditorAgent = new NoteEditorAgent(llm, this.profile);
    this.classifierAgent = new ClassifierAgent(llm, this.profile);
    this.connectionAgent = new ConnectionAgent(llm, this.profile);

    // Context builder keeps its search pipeline reference
    console.log("[chiefOfStaff:updateLLM] TRACE: recreating context builder");
    this.contextBuilderAgent = new ContextBuilderAgent(
      llm,
      null, // Will be updated separately via updateSearch
      null,
      this.profile,
    );

    // Clear workflow agents (will be recreated on demand with new LLM)
    console.log("[chiefOfStaff:updateLLM] TRACE: clearing workflow agents");
    this.workflowAgents.clear();
    console.log("[chiefOfStaff:updateLLM] TRACE: END");
  }

  /**
   * Update search pipeline
   */
  updateSearch(pipeline: SearchPipeline | null): void {
    console.log(`[chiefOfStaff:updateSearch] TRACE: START hasPipeline=${!!pipeline}`);
    this.contextBuilderAgent.updateSearchPipeline(pipeline);
    console.log("[chiefOfStaff:updateSearch] TRACE: END");
  }

  /**
   * Update vault context builder
   */
  updateContextBuilder(builder: VaultContextBuilder | null): void {
    console.log(`[chiefOfStaff:updateContextBuilder] TRACE: START hasBuilder=${!!builder}`);
    this.contextBuilderAgent.updateVaultContextBuilder(builder);
    console.log("[chiefOfStaff:updateContextBuilder] TRACE: END");
  }

  // ===========================================================================
  // Routing Logic
  // ===========================================================================

  /**
   * Determine which expert agent should handle this task.
   * Only routes to expert agents. Throws if no expert agent matches.
   */
  private determineRouting(task: ChiefOfStaffTask): RoutingDecision {
    console.log(`[chiefOfStaff:determineRouting] TRACE: START query="${task.query.slice(0, 50)}"`);
    // Explicit target takes precedence
    if (task.targetAgent) {
      console.log(`[chiefOfStaff:determineRouting] TRACE: explicit target=${task.targetAgent}`);
      const needsContext = task.targetAgent !== "classifier";
      const result: RoutingDecision = {
        primaryAgent: task.targetAgent,
        preflightAgents: needsContext ? ["context-builder"] : [],
        reason: `Explicit target: ${task.targetAgent}`,
      };
      console.log(`[chiefOfStaff:determineRouting] TRACE: END primaryAgent=${result.primaryAgent}`);
      return result;
    }

    const query = task.query.toLowerCase();

    // Check for slash commands (explicit intent)
    if (query.startsWith("/")) {
      const command = query.split(" ")[0].slice(1);
      console.log(`[chiefOfStaff:determineRouting] TRACE: slash command=${command}`);

      switch (command) {
        case "enhance":
        case "edit":
        case "improve": {
          const result: RoutingDecision = {
            primaryAgent: "note-editor",
            preflightAgents: ["context-builder"],
            reason: "Slash command: edit/enhance",
          };
          console.log(
            `[chiefOfStaff:determineRouting] TRACE: END primaryAgent=${result.primaryAgent}`,
          );
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
          console.log(
            `[chiefOfStaff:determineRouting] TRACE: END primaryAgent=${result.primaryAgent}`,
          );
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
          console.log(
            `[chiefOfStaff:determineRouting] TRACE: END primaryAgent=${result.primaryAgent}`,
          );
          return result;
        }
      }
    }

    // Intent detection from natural language
    console.log("[chiefOfStaff:determineRouting] TRACE: detecting intents");
    const intents = this.detectIntents(query);
    console.log(
      `[chiefOfStaff:determineRouting] TRACE: intents edit=${intents.edit} classify=${intents.classify} link=${intents.link}`,
    );

    // Strong edit signals
    if (intents.edit >= 0.5) {
      const result: RoutingDecision = {
        primaryAgent: "note-editor",
        preflightAgents: ["context-builder"],
        reason: "Detected edit intent",
      };
      console.log(`[chiefOfStaff:determineRouting] TRACE: END primaryAgent=${result.primaryAgent}`);
      return result;
    }

    // Strong classification signals
    if (intents.classify >= 0.5) {
      const result: RoutingDecision = {
        primaryAgent: "classifier",
        preflightAgents: [],
        reason: "Detected classification intent",
      };
      console.log(`[chiefOfStaff:determineRouting] TRACE: END primaryAgent=${result.primaryAgent}`);
      return result;
    }

    // Strong linking signals
    if (intents.link >= 0.5) {
      const result: RoutingDecision = {
        primaryAgent: "connection",
        preflightAgents: ["context-builder"],
        reason: "Detected connection intent",
      };
      console.log(`[chiefOfStaff:determineRouting] TRACE: END primaryAgent=${result.primaryAgent}`);
      return result;
    }

    // No expert agent matches - this should not be routed through ChiefOfStaff
    console.log("[chiefOfStaff:determineRouting] TRACE: END (no match - throwing)");
    throw new Error(
      `No expert agent matched for query: "${task.query.slice(0, 50)}...". Conversational requests should use ChatService directly, not ChiefOfStaff.`,
    );
  }

  /**
   * Detect intents from query
   */
  private detectIntents(query: string): { edit: number; classify: number; link: number } {
    console.log("[chiefOfStaff:detectIntents] TRACE: START");
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
    console.log(
      `[chiefOfStaff:detectIntents] TRACE: END edit=${result.edit} classify=${result.classify} link=${result.link}`,
    );
    return result;
  }

  // ===========================================================================
  // Workflow Execution (Intelligence 2.0)
  // ===========================================================================

  /**
   * Extract workflow type from slash command
   */
  private extractWorkflowType(query: string): WorkflowAgentType | null {
    console.log(`[chiefOfStaff:extractWorkflowType] TRACE: START query="${query.slice(0, 50)}"`);
    const command = query.split(" ")[0];
    const config = getWorkflowByCommand(command);
    const result = config?.type || null;
    console.log(`[chiefOfStaff:extractWorkflowType] TRACE: END result=${result}`);
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
    console.log(`[chiefOfStaff:executeWorkflow] TRACE: START workflowType=${workflowType}`);
    // Run context builder first
    let contextOutput: InternalOutput | null = null;
    console.log("[chiefOfStaff:executeWorkflow] TRACE: building base context");
    const preflightContext = this.buildBaseContext(task, noteContext, null);

    console.log(
      "[chiefOfStaff:executeWorkflow] TRACE: starting contextBuilderAgent.execute for-await loop",
    );
    for await (const event of this.contextBuilderAgent.execute(preflightContext, signal)) {
      console.log(
        `[chiefOfStaff:executeWorkflow] TRACE: yielding context builder event type=${event.type}`,
      );
      yield event;
      console.log("[chiefOfStaff:executeWorkflow] TRACE: yielded context builder event");
      if (event.type === "complete" && isInternalOutput(event.output)) {
        console.log("[chiefOfStaff:executeWorkflow] TRACE: got context output");
        contextOutput = event.output;
      }
    }
    console.log("[chiefOfStaff:executeWorkflow] TRACE: finished contextBuilderAgent.execute loop");

    // Build full context for workflow
    console.log("[chiefOfStaff:executeWorkflow] TRACE: building full context");
    const fullContext = this.buildFullContext(task, noteContext, contextOutput);

    // Get or create workflow agent
    console.log("[chiefOfStaff:executeWorkflow] TRACE: getting workflow agent");
    const workflowAgent = this.getWorkflowAgent(workflowType);

    // Execute workflow
    console.log(
      "[chiefOfStaff:executeWorkflow] TRACE: starting workflowAgent.execute for-await loop",
    );
    for await (const event of workflowAgent.execute(fullContext, signal)) {
      console.log(
        `[chiefOfStaff:executeWorkflow] TRACE: yielding workflow event type=${event.type}`,
      );
      yield event;
      console.log("[chiefOfStaff:executeWorkflow] TRACE: yielded workflow event");
    }
    console.log("[chiefOfStaff:executeWorkflow] TRACE: END");
  }

  // ===========================================================================
  // Context Building
  // ===========================================================================

  /**
   * Load note content from vault
   */
  private async loadNoteContext(notePath: string, noteTitle: string): Promise<NoteContext | null> {
    console.log(`[chiefOfStaff:loadNoteContext] TRACE: START notePath=${notePath}`);
    if (!notePath || notePath === "unknown") {
      console.log("[chiefOfStaff:loadNoteContext] TRACE: END (invalid path)");
      return null;
    }

    try {
      console.log("[chiefOfStaff:loadNoteContext] TRACE: reading file");
      const content = await this.obsidian.readFileByPath(notePath);
      if (!content) {
        console.log("[chiefOfStaff:loadNoteContext] TRACE: END (no content)");
        return null;
      }

      // Extract frontmatter if present
      let frontmatter: Record<string, unknown> | undefined;
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (frontmatterMatch) {
        console.log("[chiefOfStaff:loadNoteContext] TRACE: parsing frontmatter");
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
      console.log(`[chiefOfStaff:loadNoteContext] TRACE: END wordCount=${result.wordCount}`);
      return result;
    } catch (error) {
      console.warn(`[ChiefOfStaff] Failed to load note ${notePath}:`, error);
      console.log("[chiefOfStaff:loadNoteContext] TRACE: END (error)");
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
    console.log("[chiefOfStaff:buildBaseContext] TRACE: START");
    const result = {
      currentNote: noteContext,
      query: task.query,
      chatHistory: task.chatHistory,
      activeAgents: this.currentSession ? Array.from(this.currentSession.activeAgents) : [],
      delegationChain: [],
      para: this.getPARAContext(),
    };
    console.log("[chiefOfStaff:buildBaseContext] TRACE: END");
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
    console.log(`[chiefOfStaff:buildFullContext] TRACE: START hasContextOutput=${!!contextOutput}`);
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
    console.log("[chiefOfStaff:buildFullContext] TRACE: END");
    return result;
  }

  /**
   * Get PARA context from profile
   */
  private getPARAContext(): PARAContext | undefined {
    console.log(`[chiefOfStaff:getPARAContext] TRACE: START hasProfile=${!!this.profile}`);
    if (!this.profile?.para) {
      console.log("[chiefOfStaff:getPARAContext] TRACE: END (no para)");
      return undefined;
    }

    const result = {
      inbox: [], // UserProfile doesn't have inbox field
      projects: this.profile.para.projects || [],
      areas: this.profile.para.areas || [],
      resources: this.profile.para.resources || [],
      archive: this.profile.para.archives || [],
    };
    console.log("[chiefOfStaff:getPARAContext] TRACE: END");
    return result;
  }

  /**
   * Get vault graph context for a note
   * TODO: Integrate with actual vault graph when available
   */
  private getVaultGraphContext(notePath: string): VaultGraphContext | undefined {
    console.log(`[chiefOfStaff:getVaultGraphContext] TRACE: START notePath=${notePath}`);
    // Placeholder - would integrate with actual vault graph service
    const result = {
      backlinks: [],
      outlinks: [],
      orphans: [],
      hubs: [],
    };
    console.log("[chiefOfStaff:getVaultGraphContext] TRACE: END");
    return result;
  }

  // ===========================================================================
  // Session Management
  // ===========================================================================

  /**
   * Create a new agent session
   */
  private createSession(notePath: string): AgentSession {
    console.log(`[chiefOfStaff:createSession] TRACE: START notePath=${notePath}`);
    const result = {
      id: crypto.randomUUID(),
      activeAgents: new Set<ExpertAgentType>(),
      completedAgents: new Map(),
      startedAt: new Date(),
      notePath,
    };
    console.log(`[chiefOfStaff:createSession] TRACE: END sessionId=${result.id}`);
    return result;
  }

  /**
   * Get expert agent instance by type
   */
  private getAgent(
    type: ExpertAgentType,
  ): NoteEditorAgent | ClassifierAgent | ConnectionAgent | ContextBuilderAgent {
    console.log(`[chiefOfStaff:getAgent] TRACE: START type=${type}`);
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
        console.log("[chiefOfStaff:getAgent] TRACE: END (unknown type - throwing)");
        throw new Error(`Unknown expert agent type: ${type}`);
    }
    console.log("[chiefOfStaff:getAgent] TRACE: END");
    return result;
  }

  /**
   * Get current session info
   */
  getCurrentSession(): AgentSession | null {
    console.log("[chiefOfStaff:getCurrentSession] TRACE: START");
    console.log(`[chiefOfStaff:getCurrentSession] TRACE: END hasSession=${!!this.currentSession}`);
    return this.currentSession;
  }

  /**
   * Check if an agent is currently active
   */
  isAgentActive(type: ExpertAgentType): boolean {
    console.log(`[chiefOfStaff:isAgentActive] TRACE: START type=${type}`);
    const result = this.currentSession?.activeAgents.has(type) ?? false;
    console.log(`[chiefOfStaff:isAgentActive] TRACE: END result=${result}`);
    return result;
  }

  /**
   * Get agent configuration
   */
  getAgentConfig(type: ExpertAgentType) {
    console.log(`[chiefOfStaff:getAgentConfig] TRACE: START type=${type}`);
    const result = AGENT_CONFIGS[type];
    console.log("[chiefOfStaff:getAgentConfig] TRACE: END");
    return result;
  }
}
