import type { EventBus } from "../events/eventBus";

export type AgentName = "linker" | "synthesizer" | "contradictionHunter" | "maturityAdvancer";

export type AgentTrigger =
  | "vault-save"
  | "idle-30s"
  | "idle-5m"
  | "idle-30m"
  | "user-action"
  | "new-claim";

export interface AgentRunContext {
  trigger: AgentTrigger;
  notePath: string | null;
  signal: AbortSignal;
  /** Identifier of the agent_runs row; agents stamp swarm:* events with it. */
  runId: number;
  /** Event bus the agent emits swarm:* discovery events on. */
  bus: EventBus;
}

export interface AgentRunResult {
  proposals: number;
}

export interface Agent {
  name: AgentName;
  /** True if this agent makes a reasoning-model call (counts against the mutex). */
  usesReasoningModel: boolean;
  run(context: AgentRunContext): Promise<AgentRunResult>;
}
