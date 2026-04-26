import type { Database } from "../db/database";
import type { EventBus } from "../events/eventBus";
import type { ReasoningMutex } from "./reasoningMutex";
import type { Agent, AgentName, AgentRunContext, AgentTrigger } from "./types";

export interface CoordinatorAgents {
  linker: Agent;
  synthesizer: Agent;
  contradictionHunter: Agent;
  maturityAdvancer: Agent;
}

export interface CoordinatorOptions {
  bus: EventBus;
  db: Database;
  mutex: ReasoningMutex;
  agents: CoordinatorAgents;
}

export class Coordinator {
  private readonly subs: Array<() => void> = [];
  private inflight: Set<Promise<unknown>> = new Set();
  private activeNotePath: string | null = null;
  private userActive = false;
  private running = false;

  constructor(private readonly opts: CoordinatorOptions) {}

  setActiveNote(path: string | null): void {
    this.activeNotePath = path;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const { bus } = this.opts;
    this.subs.push(
      bus.on("vault:note-saved", (event) => {
        this.userActive = false;
        this.dispatch("vault-save", event.path, ["linker"]);
      }),
      bus.on("user:active", () => {
        this.userActive = true;
      }),
      bus.on("user:idle", (event) => {
        if (event.level === "30s") {
          this.dispatch("idle-30s", this.activeNotePath, ["linker"]);
        } else if (event.level === "5m") {
          this.dispatch("idle-5m", this.activeNotePath, ["synthesizer", "contradictionHunter"]);
        } else if (event.level === "30m") {
          this.dispatch("idle-30m", null, ["maturityAdvancer"]);
        }
      }),
      bus.on("user:action", (event) => {
        if (event.kind === "deepen") {
          this.dispatch("user-action", event.notePath, [
            "linker",
            "synthesizer",
            "contradictionHunter",
            "maturityAdvancer",
          ]);
        }
      }),
      bus.on("active-leaf-change", (event) => {
        this.activeNotePath = event.notePath;
      }),
    );
  }

  stop(): void {
    this.running = false;
    for (const off of this.subs) off();
    this.subs.length = 0;
  }

  /** Resolves once all dispatched agent runs complete. Used by tests. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled(Array.from(this.inflight));
    }
  }

  private dispatch(trigger: AgentTrigger, notePath: string | null, agents: AgentName[]): void {
    if (!this.running) return;
    if (this.userActive && trigger.startsWith("idle")) return;
    const promise = this.runSequential(trigger, notePath, agents).finally(() => {
      this.inflight.delete(promise);
    });
    this.inflight.add(promise);
  }

  private async runSequential(
    trigger: AgentTrigger,
    notePath: string | null,
    agents: AgentName[],
  ): Promise<void> {
    for (const name of agents) {
      const agent = this.opts.agents[name];
      await this.runOne(agent, trigger, notePath);
    }
  }

  private async runOne(
    agent: Agent,
    trigger: AgentTrigger,
    notePath: string | null,
  ): Promise<void> {
    const startedAt = Date.now();
    this.opts.db.run(
      "INSERT INTO agent_runs (agent, trigger, note_path, started_at) VALUES (?,?,?,?);",
      [agent.name, trigger, notePath, startedAt],
    );
    const idRow = this.opts.db.query<{ id: number }>("SELECT last_insert_rowid() AS id;")[0];
    const runId = idRow?.id ?? -1;
    this.opts.bus.emit({
      type: "agent:run-started",
      agent: agent.name,
      trigger,
      notePath,
      runId,
    });
    let proposals = 0;
    let ok = false;
    let errorMessage: string | undefined;
    try {
      const result = await this.executeAgent(agent, { trigger, notePath });
      proposals = result.proposals;
      ok = true;
    } catch (error) {
      errorMessage = (error as Error).message ?? String(error);
    }
    const finishedAt = Date.now();
    this.opts.db.run(
      "UPDATE agent_runs SET finished_at = ?, ok = ?, error = ?, proposals_count = ? WHERE id = ?;",
      [finishedAt, ok ? 1 : 0, errorMessage ?? null, proposals, runId],
    );
    this.opts.bus.emit({
      type: "agent:run-finished",
      agent: agent.name,
      ok,
      proposals,
      durationMs: finishedAt - startedAt,
      error: errorMessage,
      runId,
    });
  }

  private async executeAgent(agent: Agent, base: Omit<AgentRunContext, "signal">) {
    if (agent.usesReasoningModel) {
      return this.opts.mutex.run(`agent:${agent.name}`, async (signal) => {
        return agent.run({ ...base, signal });
      });
    }
    const controller = new AbortController();
    return agent.run({ ...base, signal: controller.signal });
  }
}
