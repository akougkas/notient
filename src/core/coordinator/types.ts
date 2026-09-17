import type { EventBus } from "../events/eventBus";

export type AgentName = "linker" | "synthesizer" | "contradictionHunter" | "maturityAdvancer";

export type AgentTrigger = "vault-save" | "embedding-repair" | "idle-30s" | "idle-5m" | "idle-30m";

export interface AgentRunContext {
  trigger: AgentTrigger;
  notePath: string | null;
  signal: AbortSignal;
  /** Canonical SurrealDB record id of the durable `agent_run` row. */
  runId: string;
  /** Event bus the agent emits swarm:* discovery events on. */
  bus: EventBus;
}

export interface AgentRunResult {
  proposals: number;
}

export interface Agent {
  name: AgentName;
  /** True if this agent makes a reasoning-model call. */
  usesReasoningModel: boolean;
  run(context: AgentRunContext): Promise<AgentRunResult>;
}

export interface AgentRunRequest {
  trigger: AgentTrigger;
  notePath: string | null;
  signal?: AbortSignal;
}

/**
 * Bound execution capability for one agent. Every invocation creates and
 * finalizes a durable run through the process-wide executor.
 */
export interface AgentRunCapability<Name extends AgentName = AgentName> {
  readonly agentName: Name;
  execute(request: AgentRunRequest): Promise<AgentRunResult>;
}
