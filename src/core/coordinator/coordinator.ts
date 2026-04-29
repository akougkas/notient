import type { Surreal } from "surrealdb";
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
  /**
   * SurrealDB connection. Phase 5 Task 3 migrated `agent_run` writes off the
   * SQLite mirror; the wire-shape numeric `runId` is preserved by the `seq`
   * pattern Phase 4 Task 12 established for `agent_event` and `agent_session`.
   */
  db: Surreal;
  mutex: ReasoningMutex;
  agents: CoordinatorAgents;
}

interface CreatedRunRow {
  seq: number;
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
    const runId = await this.createRun(agent.name, trigger, notePath, startedAt);
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
      const result = await this.executeAgent(agent, { trigger, notePath, runId });
      proposals = result.proposals;
      ok = true;
    } catch (error) {
      errorMessage = (error as Error).message ?? String(error);
    }
    const finishedAt = Date.now();
    await this.finalizeRun(runId, finishedAt, ok, errorMessage, proposals);
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

  /**
   * Allocate a fresh `seq` and CREATE the `agent_run` row inside a single
   * SurrealQL transaction. The `BEGIN; LET $next = ...; CREATE; COMMIT;`
   * pattern matches Phase 4 Task 12's `agent_event` and `agent_session`
   * producers; the post-commit SELECT reads the freshly assigned `seq` so
   * the caller sees the wire-shape integer without a second roundtrip.
   *
   * `note_path` is omitted from CONTENT when null because the SurrealDB
   * `option<string>` field rejects an explicit `null`.
   */
  private async createRun(
    agent: AgentName,
    trigger: AgentTrigger,
    notePath: string | null,
    startedAt: number,
  ): Promise<number> {
    const setClauses: string[] = [
      "seq: ($next ?? 0) + 1",
      "agent: $agent",
      "trigger: $trigger",
      "started_at: $startedAt",
    ];
    const bindings: Record<string, unknown> = {
      agent,
      trigger,
      startedAt,
    };
    if (notePath !== null) {
      setClauses.push("note_path: $notePath");
      bindings.notePath = notePath;
    }
    const sql = [
      "BEGIN;",
      "LET $next = (SELECT VALUE seq FROM agent_run ORDER BY seq DESC LIMIT 1)[0];",
      `LET $row = CREATE ONLY agent_run CONTENT { ${setClauses.join(", ")} };`,
      "COMMIT;",
      "SELECT seq FROM agent_run WHERE started_at = $startedAt AND agent = $agent AND trigger = $trigger ORDER BY seq DESC LIMIT 1;",
    ].join("\n");
    const results = await this.opts.db.query(sql, bindings).collect<unknown[]>();
    const lastSlice = results[results.length - 1];
    const rows = (Array.isArray(lastSlice) ? (lastSlice as CreatedRunRow[]) : []) as CreatedRunRow[];
    const created = rows[0];
    if (created === undefined) {
      throw new Error("Coordinator.createRun: SurrealDB returned no row");
    }
    return created.seq;
  }

  /**
   * Update the `agent_run` row identified by `seq` with the run outcome.
   * `error` is omitted from the SET clause when undefined so the
   * `option<string>` field stays NONE on success rather than being
   * written as a literal null.
   */
  private async finalizeRun(
    seq: number,
    finishedAt: number,
    ok: boolean,
    errorMessage: string | undefined,
    proposals: number,
  ): Promise<void> {
    const setClauses: string[] = [
      "finished_at = $finishedAt",
      "ok = $ok",
      "proposals_count = $proposals",
    ];
    const bindings: Record<string, unknown> = {
      seq,
      finishedAt,
      ok,
      proposals,
    };
    if (errorMessage !== undefined) {
      setClauses.push("error = $error");
      bindings.error = errorMessage;
    }
    const sql = `UPDATE agent_run SET ${setClauses.join(", ")} WHERE seq = $seq;`;
    await this.opts.db.query(sql, bindings).collect();
  }

  private async executeAgent(agent: Agent, base: Omit<AgentRunContext, "signal" | "bus">) {
    const bus = this.opts.bus;
    if (agent.usesReasoningModel) {
      return this.opts.mutex.run(`agent:${agent.name}`, async (signal) => {
        return agent.run({ ...base, signal, bus });
      });
    }
    const controller = new AbortController();
    return agent.run({ ...base, signal: controller.signal, bus });
  }
}
