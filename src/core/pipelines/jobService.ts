import type { VaultAdapter } from "../../adapters/vaultAdapter";
import type { ChangeResult } from "../../api/changes";
import { NoteReadService } from "../../api/notes";
import { type OperationInput, type PipelineId, operationInputs } from "../../api/operations";
import { type PipelineJob, type PipelinePlan, jobResultSchema } from "../../api/pipelines";
import { NoteApiError } from "../../api/schema";
import { scopeAllows } from "../../api/scope";
import type { ReasoningScheduler } from "../coordinator/reasoningScheduler";
import type { ChangeCaller } from "../history/changeService";
import { IncompleteCompletionError } from "../llm/completion";
import { InferenceBudget } from "../llm/executionBudget";
import { ProviderHttpError } from "../llm/httpError";
import type { LLMProvider } from "../llm/provider";
import type { SearchPipeline } from "../search/searchPipeline";
import type { SettingsService } from "../settings/settingsService";
import type { PipelineContextOptions } from "./context";
import { assertPipelinePolicy } from "./effectPolicy";
import type { PipelineEngine } from "./engine";
import { type JobStore, stableJobId } from "./jobStore";

export interface JobServiceOptions {
  store: JobStore;
  settings: SettingsService;
  engine: PipelineEngine;
  scheduler: ReasoningScheduler;
  vault: VaultAdapter;
  search: SearchPipeline;
  provider: LLMProvider;
  /** Production credential authority, re-evaluated for detached and recovered work. */
  authorizeCaller?: (caller: ChangeCaller) => void | Promise<void>;
  /** Existing proposal/approval authority; stage never changes authored files. */
  stage: (
    job: PipelineJob,
    plan: PipelinePlan,
    signal: AbortSignal,
  ) => Promise<{ proposalIds: string[]; previewId: string | null; previewRevision: string | null }>;
  apply: (
    job: PipelineJob,
    signal: AbortSignal,
    authorize: () => Promise<void>,
  ) => Promise<ChangeResult | null>;
  changed: (job: PipelineJob) => void;
}
const controlTransitions: Record<
  OperationInput<"jobs.control">["action"],
  Partial<Record<PipelineJob["state"], PipelineJob["state"]>>
> = {
  pause: { queued: "paused", running: "paused", "waiting-inference": "paused" },
  cancel: {
    queued: "cancelled",
    running: "cancelled",
    "waiting-inference": "cancelled",
    paused: "cancelled",
  },
  resume: { paused: "queued" },
  retry: { failed: "queued", partial: "queued", "waiting-inference": "queued" },
};

/** One persisted execution path for explicit and background pipeline work. */
export class JobService {
  async list(input: unknown, caller: ChangeCaller) {
    this.requireRead(caller);
    const parsed = operationInputs["jobs.list"].safeParse(input);
    if (!parsed.success) throw new NoteApiError("INVALID_PARAMS", parsed.error.message);
    return this.options.store.page(parsed.data);
  }
  async get(input: unknown, caller: ChangeCaller) {
    this.requireRead(caller);
    const parsed = operationInputs["jobs.get"].safeParse(input);
    if (!parsed.success) throw new NoteApiError("INVALID_PARAMS", parsed.error.message);
    const job = await this.options.store.get(parsed.data.id);
    if (!job) throw new NoteApiError("NOT_FOUND", "job does not exist");
    return jobResultSchema.parse({ ok: true, job });
  }
  private requireRead(caller: ChangeCaller): void {
    if (!caller.scopes.includes("read"))
      throw new NoteApiError("FORBIDDEN", "job inspection requires read authority");
  }
  private readonly running = new Map<
    string,
    {
      controller: AbortController;
      work: Promise<void>;
      pipeline: PipelineId;
      callerId: string;
      policy: string;
      background: boolean;
    }
  >();
  private accepting = true;
  private pumpTail: Promise<void> = Promise.resolve();
  private readonly stopListening: () => void;
  constructor(readonly options: JobServiceOptions) {
    this.stopListening = options.settings.onBackgroundChange(() => {
      const { settings } = options.settings.background();
      for (const run of this.running.values()) {
        if (
          run.policy !== JSON.stringify(settings.pipelines[run.pipeline]) ||
          (run.background && settings.paused)
        )
          run.controller.abort(
            new NoteApiError("FORBIDDEN", "pipeline permission changed during execution"),
          );
      }
      void this.pump().catch(() => {});
    });
  }
  async recover(): Promise<void> {
    for (const job of await this.options.store.list(10000)) {
      if (job.state !== "running") continue;
      await this.options.store.update(job.id, (draft) => {
        draft.state = "queued";
        draft.stage = "recovering";
        draft.failure = {
          code: "INTERRUPTED",
          message:
            "Daemon stopped during this run; durable checkpoints and reserved usage are retained.",
          at: Date.now(),
        };
      });
    }
  }
  async run(
    input: unknown,
    caller: ChangeCaller,
    origin?: { reason: string; key: string },
    signal?: AbortSignal,
  ): Promise<PipelineJob> {
    signal?.throwIfAborted();
    if (!this.accepting) throw new NoteApiError("CANCELLED", "job admission is closed");
    await this.authorizeCaller(caller);
    const parsed = operationInputs["pipelines.run"].safeParse(input);
    if (!parsed.success) throw new NoteApiError("INVALID_PARAMS", parsed.error.message);
    const request = parsed.data;
    const id = stableJobId(caller.id, origin?.key ?? request.idempotencyKey);
    const existing = await this.options.store.get(id);
    if (existing) {
      if (
        existing.pipeline !== request.pipeline ||
        existing.preview !== request.preview ||
        existing.caller.kind !== caller.kind ||
        existing.background !== (origin !== undefined) ||
        JSON.stringify(existing.sourceRevisions) !== JSON.stringify(request.sources)
      )
        throw new NoteApiError("CONFLICT", "job idempotency key was reused with different inputs");
      return existing;
    }
    const configuration = this.options.settings.background();
    const policy = configuration.settings.pipelines[request.pipeline];
    if (origin && (configuration.settings.paused || !policy.enabled))
      throw new NoteApiError("FORBIDDEN", "background pipeline is disabled or paused");
    if (request.sources.length > policy.budget.notes)
      throw new NoteApiError("LIMIT_EXCEEDED", "selected notes exceed the pipeline note budget");
    await this.requireSources(request.sources, policy.readScope);
    signal?.throwIfAborted();
    await this.authorizeCaller(caller);
    const at = Date.now();
    const job = await this.options.store.create({
      id,
      revision: "0".repeat(64),
      pipeline: request.pipeline,
      state: "queued",
      caller: structuredClone(caller),
      background: origin !== undefined,
      preview: request.preview,
      reason: origin?.reason ?? "Explicit live invocation",
      createdAt: at,
      updatedAt: at,
      sourceRevisions: request.sources,
      configurationRevision: configuration.revision,
      policy: structuredClone(policy),
      attempts: [],
      runAttempts: 0,
      activeDurationMs: 0,
      stage: "queued",
      progress: { completed: 0, total: request.sources.length },
      plan: null,
      previewId: null,
      previewRevision: null,
      proposalIds: [],
      effects: null,
      failure: null,
      nextAttemptAt: null,
    });
    // Concurrent submissions can meet in JobStore.create. Check the winning
    // document too; a key never acknowledges another request's work.
    if (
      job.pipeline !== request.pipeline ||
      job.preview !== request.preview ||
      job.caller.kind !== caller.kind ||
      job.background !== (origin !== undefined) ||
      JSON.stringify(job.sourceRevisions) !== JSON.stringify(request.sources)
    )
      throw new NoteApiError("CONFLICT", "job idempotency key was reused with different inputs");
    this.options.changed(job);
    void this.pump().catch(() => {});
    return job;
  }
  pump(): Promise<void> {
    const work = this.pumpTail.catch(() => {}).then(() => this.pumpSerial());
    this.pumpTail = work;
    return work;
  }
  private async pumpSerial(): Promise<void> {
    if (!this.accepting) return;
    const jobs = (await this.options.store.list(10000)).filter(
      (job) =>
        (job.state === "queued" || job.state === "waiting-inference") &&
        !this.running.has(job.id) &&
        (job.nextAttemptAt === null || job.nextAttemptAt <= Date.now()),
    );
    jobs.sort(
      (a, b) =>
        Number(a.background) - Number(b.background) ||
        b.policy.budget.priority - a.policy.budget.priority ||
        a.createdAt - b.createdAt,
    );
    for (const job of jobs) {
      if (!this.accepting || this.running.size >= 8) break;
      try {
        await this.authorizeCaller(job.caller);
      } catch (error) {
        const failed = await this.options.store
          .update(
            job.id,
            (draft) => {
              draft.state = "failed";
              draft.stage = "failed";
              draft.nextAttemptAt = null;
              draft.failure = {
                code: "FORBIDDEN",
                message: error instanceof Error ? error.message : String(error),
                at: Date.now(),
              };
            },
            job.revision,
          )
          .catch((conflict) => {
            if (conflict instanceof NoteApiError && conflict.code === "CONFLICT") return null;
            throw conflict;
          });
        if (failed) this.options.changed(failed);
        continue;
      }
      if (job.background && this.options.settings.background().settings.paused) continue;
      const activeSamePipeline = [...this.running.values()].filter(
        (run) => run.pipeline === job.pipeline,
      ).length;
      if (activeSamePipeline >= job.policy.budget.concurrency) continue;
      if (
        job.plan === null &&
        !(
          job.pipeline === "index-extract" &&
          !job.policy.parameters.indexExtract.extraction &&
          !job.policy.parameters.indexExtract.embeddings
        )
      ) {
        const model = this.options.settings.get().primary.reasoningModel;
        const available =
          model !== "" &&
          (await this.options.provider.isAvailable(AbortSignal.timeout(3000)).catch(() => false));
        if (!available) {
          const waiting = await this.options.store
            .update(
              job.id,
              (draft) => {
                draft.state = "waiting-inference";
                draft.stage = "waiting-inference";
                draft.nextAttemptAt = Date.now() + 30000;
                draft.failure = {
                  code: "INFERENCE_UNAVAILABLE",
                  message: model
                    ? "Reasoning endpoint is unavailable; the job will resume when it recovers."
                    : "Configure a reasoning model to resume this job.",
                  at: Date.now(),
                };
              },
              job.revision,
            )
            .catch((error) => {
              if (error instanceof NoteApiError && error.code === "CONFLICT") return null;
              throw error;
            });
          if (waiting) this.options.changed(waiting);
          continue;
        }
      }
      const controller = new AbortController();
      const work = this.execute(job, controller.signal).finally(() => {
        this.running.delete(job.id);
        if (this.accepting) void this.pump().catch(() => {});
      });
      this.running.set(job.id, {
        controller,
        work,
        pipeline: job.pipeline,
        callerId: job.caller.id,
        policy: JSON.stringify(job.policy),
        background: job.background,
      });
      void work.catch((error) =>
        process.stderr.write(
          `${JSON.stringify({ type: "job:execution_failed", jobId: job.id, message: error instanceof Error ? error.message : String(error) })}\n`,
        ),
      );
    }
  }
  async assertAuthority(job: PipelineJob, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.authorizeCaller(job.caller);
    assertPipelinePolicy(job, this.options.settings.background().settings);
    const stored = await this.options.store.get(job.id);
    if (!stored || stored.state !== "running")
      throw new NoteApiError("CANCELLED", "job is no longer running");
  }
  private async authorizeCaller(caller: ChangeCaller): Promise<void> {
    if (!caller.scopes.includes("read") || !caller.scopes.includes("write"))
      throw new NoteApiError("FORBIDDEN", "pipeline invocation requires read and write authority");
    if (caller.id.startsWith("paired-") && !this.options.authorizeCaller)
      throw new NoteApiError("FORBIDDEN", "paired caller authority is unavailable");
    await this.options.authorizeCaller?.(caller);
  }
  revokeCaller(id: string): void {
    for (const run of this.running.values()) {
      if (run.callerId === id)
        run.controller.abort(
          new NoteApiError("FORBIDDEN", "pipeline caller credential was revoked"),
        );
    }
    void this.pump().catch(() => {});
  }
  private async execute(candidate: PipelineJob, signal: AbortSignal): Promise<void> {
    const id = candidate.id;
    const job = await this.options.store
      .update(
        id,
        (draft) => {
          if (!this.accepting || signal.aborted)
            throw new NoteApiError("CANCELLED", "job admission stopped");
          draft.state = "running";
          draft.stage = "starting";
          draft.runAttempts++;
          draft.nextAttemptAt = null;
        },
        candidate.revision,
      )
      .catch((error) => {
        if (error instanceof NoteApiError && ["CONFLICT", "CANCELLED"].includes(error.code))
          return null;
        throw error;
      });
    if (!job) return;
    this.options.changed(job);
    const started = performance.now();
    const remainingDurationMs = Math.floor(job.policy.budget.durationMs - job.activeDurationMs);
    if (remainingDurationMs <= 0) {
      await this.fail(
        job,
        new NoteApiError("LIMIT_EXCEEDED", "job duration budget is exhausted"),
        started,
        signal,
      );
      return;
    }
    const budget = new InferenceBudget(
      {
        ...job.policy.budget,
        // Active time is measured with a monotonic fractional-millisecond clock;
        // timers/budget limits require integers. Round remaining time down so a
        // retry cannot gain budget or strand the job during budget construction.
        durationMs: remainingDurationMs,
      },
      job.attempts,
      async (attempts) => {
        await this.options.store.update(id, (draft) => {
          draft.attempts = attempts;
        });
      },
      signal,
    );
    try {
      const task = async (schedulerSignal: AbortSignal) =>
        budget.run(async () => {
          const combined = AbortSignal.any([signal, budget.signal, schedulerSignal]);
          const authorize = async () => {
            await budget.flush();
            budget.assertAvailable();
            await this.assertAuthority(job, combined);
          };
          await authorize();
          const context = this.context(job, combined);
          const plan = job.plan ?? (await this.options.engine.plan(job.pipeline, context));
          await authorize();
          await this.requireSources(plan.sources, job.policy.readScope);
          await this.options.store.update(id, (draft) => {
            draft.plan = plan;
            draft.stage = "checkpointed";
          });
          await this.options.engine.persistDerived(plan, context, authorize);
          await authorize();
          const staged = await this.options.stage(job, plan, combined);
          const ready = await this.options.store.update(id, (draft) => {
            Object.assign(draft, staged);
            draft.plan = plan;
            draft.stage = "review";
          });
          await authorize();
          const effects =
            job.preview || job.policy.mode !== "apply"
              ? null
              : await this.options.apply(ready, combined, authorize);
          await budget.flush();
          await this.finish(job, plan, effects, started);
        });
      if (job.background) await this.options.scheduler.run(`pipeline-${job.id}`, task, { signal });
      else await this.options.scheduler.runPriority(`pipeline-${job.id}`, task, { signal });
    } catch (error) {
      await budget.flush().catch(() => {});
      await this.fail(job, error, started, signal);
    }
  }
  private context(job: PipelineJob, signal: AbortSignal): PipelineContextOptions {
    return {
      vault: this.options.vault,
      search: this.options.search,
      provider: this.options.provider,
      model: this.options.settings.get().primary.reasoningModel,
      modelContextTokens: this.options.settings.get().chat.modelContextTokens,
      policy: job.policy,
      sources: job.sourceRevisions,
      signal,
      stage: async (stage, completed = 0, total = job.sourceRevisions.length) => {
        await this.assertAuthority(job, signal);
        const updated = await this.options.store.update(job.id, (draft) => {
          draft.stage = stage;
          draft.progress = { completed, total };
        });
        this.options.changed(updated);
      },
    };
  }
  private async finish(
    job: PipelineJob,
    plan: PipelinePlan,
    effects: ChangeResult | null,
    started: number,
  ): Promise<void> {
    const updated = await this.options.store.update(job.id, (draft) => {
      draft.effects = effects ?? draft.effects;
      draft.activeDurationMs += performance.now() - started;
      // A stop may race with the final write receipt. Preserve effects/accounting
      // without undoing the accepted stop or implying cancellation rolled back a write.
      if (draft.state !== "running") return;
      const needsReview =
        draft.proposalIds.length > 0 && (effects === null || effects.state !== "applied");
      draft.state =
        effects?.state === "partial"
          ? "partial"
          : needsReview && !job.preview
            ? "awaiting-approval"
            : "completed";
      draft.stage = draft.state;
      draft.progress = { completed: job.sourceRevisions.length, total: job.sourceRevisions.length };
      draft.failure = null;
    });
    this.options.changed(updated);
  }
  private async fail(
    job: PipelineJob,
    error: unknown,
    started: number,
    signal: AbortSignal,
  ): Promise<void> {
    const updated = await this.options.store.update(job.id, (draft) => {
      draft.activeDurationMs += performance.now() - started;
      if (draft.state !== "running") return;
      const truncated =
        error instanceof IncompleteCompletionError && error.completion.state === "truncated";
      const message = truncated
        ? `The configured shared generation ceiling (${draft.policy.budget.generationTokens} tokens for reasoning and final output) was exhausted before a complete answer. Review the run's resources before starting another run.`
        : error instanceof Error
          ? error.message
          : String(error);
      const code = truncated
        ? "LIMIT_EXCEEDED"
        : error instanceof NoteApiError
          ? error.code
          : "EXECUTION_FAILED";
      draft.failure = { code, message, at: Date.now() };
      const constrained =
        // Repeating an incomplete structured generation at the same ceiling
        // cannot constitute recovery. Retain its measured usage and outcome.
        error instanceof IncompleteCompletionError ||
        (error instanceof NoteApiError &&
          ["FORBIDDEN", "CONFLICT", "LIMIT_EXCEEDED", "INVALID_PARAMS"].includes(error.code)) ||
        (error instanceof ProviderHttpError && !error.retryable);
      const resources =
        draft.attempts.length < draft.policy.budget.modelCalls &&
        draft.attempts.reduce((sum, item) => sum + item.chargedTokens, 0) <
          draft.policy.budget.tokens &&
        draft.activeDurationMs < draft.policy.budget.durationMs;
      const retry =
        !signal.aborted &&
        !constrained &&
        resources &&
        draft.runAttempts <= draft.policy.budget.retries;
      draft.state = !this.accepting
        ? "queued"
        : retry
          ? "waiting-inference"
          : signal.aborted
            ? "cancelled"
            : "failed";
      draft.stage = draft.state;
      draft.nextAttemptAt = retry
        ? Date.now() + Math.min(60000, 2000 * 2 ** draft.runAttempts)
        : null;
    });
    this.options.changed(updated);
  }
  async control(input: unknown, caller: ChangeCaller, signal?: AbortSignal): Promise<PipelineJob> {
    signal?.throwIfAborted();
    const parsed = operationInputs["jobs.control"].safeParse(input);
    if (!parsed.success) throw new NoteApiError("INVALID_PARAMS", parsed.error.message);
    const request = parsed.data;
    const prior = await this.options.store.get(request.id);
    if (!prior) throw new NoteApiError("NOT_FOUND", "job does not exist");
    if (caller.kind !== "human" && (prior.background || prior.caller.id !== caller.id))
      throw new NoteApiError("FORBIDDEN", "caller cannot control this job");
    if (!caller.scopes.includes("read") || !caller.scopes.includes("write"))
      throw new NoteApiError("FORBIDDEN", "job control requires read and write scopes");
    const { job, replayed } = await this.options.store.control(caller, request, (draft) => {
      signal?.throwIfAborted();
      if (["resume", "retry"].includes(request.action) && this.running.has(request.id))
        throw new NoteApiError("CONFLICT", "job is still stopping; wait before resuming");
      const next = controlTransitions[request.action][draft.state];
      if (!next)
        throw new NoteApiError("CONFLICT", `cannot ${request.action} a ${draft.state} job`);
      draft.state = next;
      draft.stage = draft.state;
      draft.nextAttemptAt = null;
    });
    if (replayed) return job;
    if (request.action === "pause" || request.action === "cancel")
      this.running.get(request.id)?.controller.abort();
    this.options.changed(job);
    void this.pump().catch(() => {});
    return job;
  }
  private async requireSources(
    sources: PipelineJob["sourceRevisions"],
    scope: PipelineJob["policy"]["readScope"],
  ): Promise<void> {
    const reader = new NoteReadService(this.options.vault);
    for (const source of sources) {
      const note = await reader.read(source);
      if (!scopeAllows(scope, note.note.path, note.structure.tags))
        throw new NoteApiError("FORBIDDEN", "source is excluded by pipeline read scope");
    }
  }
  async stop(): Promise<void> {
    this.suspend();
    this.stopListening();
    await this.idle();
  }
  suspend(): void {
    this.accepting = false;
    for (const run of this.running.values()) run.controller.abort();
  }
  resume(): void {
    if (this.accepting) return;
    this.accepting = true;
    void this.pump().catch(() => {});
  }
  async idle(): Promise<void> {
    await this.pumpTail;
    await Promise.allSettled([...this.running.values()].map((run) => run.work));
  }
}
