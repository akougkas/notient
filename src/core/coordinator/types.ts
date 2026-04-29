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
  /**
   * Identifier of the `agent_run` row; agents stamp swarm:* events with it.
   * This is the `seq` integer assigned by the SurrealDB `agent_run` row at
   * CREATE time, not the SurrealDB record id (which is a string like
   * `agent_run:abc123`). The wire-shape numeric contract from the SQLite
   * era is preserved by the `seq` allocation pattern Phase 4 Task 12
   * established for `agent_event` and `agent_session`.
   */
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
