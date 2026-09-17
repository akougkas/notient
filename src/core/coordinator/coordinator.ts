import type { VaultAdapter } from "../../adapters/vaultAdapter";
import { NoteCatalogService } from "../../api/catalog";
import { contentRevision } from "../../api/notes";
import { type PipelineId, pipelineIdSchema } from "../../api/operations";
import type { PipelineJob } from "../../api/pipelines";
import type { NoteReference } from "../../api/schema";
import { insideFolder } from "../../api/scope";
import type { EventBus } from "../events/eventBus";
import type { JobService } from "../pipelines/jobService";
import { insideOperatingWindow, nextOperatingTime } from "../pipelines/schedule";
import type { SentienceActivity } from "../services/sentienceActivity";
import type { SettingsService } from "../settings/settingsService";

export interface CoordinatorOptions {
  bus: EventBus;
  jobs: JobService;
  settings: SettingsService;
  vault: VaultAdapter;
  activity: Pick<SentienceActivity, "snapshot">;
  now?: () => number;
}
export interface PipelineScheduleStatus {
  lastRun: number | null;
  nextRun: number | null;
  reason: string;
}

/** Finite, explicitly enabled background scheduling over the durable job path. */
export class Coordinator {
  private readonly subs: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private pending: Promise<void> = Promise.resolve();
  private ticking = false;
  private readonly saves = new Map<string, number>();
  private readonly status = new Map<PipelineId, PipelineScheduleStatus>();
  private readonly now: () => number;
  constructor(private readonly opts: CoordinatorOptions) {
    this.now = opts.now ?? Date.now;
  }
  start(): void {
    if (this.running) return;
    this.running = true;
    this.opts.jobs.resume();
    this.subs.push(
      this.opts.bus.on("sentience:activity", (event) => {
        // The watcher has already checked the daemon mutation journal. Focus,
        // polling and Notient writes never manufacture a save trigger.
        if (
          event.activeNotePath &&
          ["vault:add", "vault:change", "vault:rename"].includes(event.source)
        )
          this.saves.set(event.activeNotePath, this.now());
      }),
    );
    this.timer = setInterval(() => {
      void this.tick().catch((error) => this.report(error));
    }, 1000);
    this.timer.unref();
    void this.tick().catch((error) => this.report(error));
  }
  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.subs.splice(0)) off();
    this.opts.jobs.suspend();
  }
  async idle(): Promise<void> {
    await this.pending;
    await this.opts.jobs.idle();
  }
  schedule(pipeline: PipelineId): PipelineScheduleStatus {
    return (
      this.status.get(pipeline) ?? {
        lastRun: null,
        nextRun: null,
        reason: "Scheduler has not inspected this policy yet.",
      }
    );
  }
  tick(): Promise<void> {
    if (this.ticking) return this.pending;
    this.ticking = true;
    const work = this.pending
      .catch(() => {})
      .then(() => this.tickSerial())
      .finally(() => {
        this.ticking = false;
      });
    this.pending = work;
    return work;
  }
  private async tickSerial(): Promise<void> {
    if (!this.running) return;
    // Invalid disk configuration closes execution until the owner corrects it.
    try {
      await this.opts.settings.refreshBackground();
    } catch (error) {
      this.opts.jobs.suspend();
      throw error;
    }
    this.opts.jobs.resume();
    const configuration = this.opts.settings.background();
    const at = this.now();
    const jobs = await this.opts.jobs.options.store.list(10000);
    for (const pipeline of pipelineIdSchema.options) {
      const policy = configuration.settings.pipelines[pipeline];
      const prior = jobs.filter((job) => job.background && job.pipeline === pipeline);
      const last = prior.reduce<number | null>(
        (value, job) => Math.max(value ?? 0, job.createdAt),
        null,
      );
      const state: PipelineScheduleStatus = { lastRun: last, nextRun: null, reason: "" };
      this.status.set(pipeline, state);
      if (configuration.settings.paused) {
        state.reason = "All background pipelines are paused.";
        continue;
      }
      if (!policy.enabled) {
        state.reason = "AI background work is disabled for this pipeline.";
        continue;
      }
      if (!policy.triggers.length) {
        state.reason = "No background trigger is selected.";
        continue;
      }
      const earliest = Math.max(at, (last ?? 0) + policy.cooldownMs);
      state.nextRun = nextOperatingTime(policy, earliest);
      if (!insideOperatingWindow(policy, at)) {
        state.reason = "Outside the configured operating window.";
        continue;
      }
      if (earliest > at) {
        state.reason = "Waiting for the configured cooldown.";
        continue;
      }
      if (
        prior.some((job) =>
          ["queued", "running", "waiting-inference", "paused"].includes(job.state),
        )
      ) {
        state.reason = "An earlier background run is still pending.";
        continue;
      }
      const saved = policy.triggers.includes("save")
        ? [...this.saves]
            .filter(
              ([, savedAt]) =>
                at - savedAt >= policy.debounceMs && (last === null || savedAt > last),
            )
            .map(([path]) => path)
        : [];
      const idle =
        policy.triggers.includes("idle") &&
        at - this.opts.activity.snapshot().lastHumanActivityAt >= policy.idleMs;
      const interval =
        policy.triggers.includes("interval") && (last === null || at - last >= policy.intervalMs);
      if (!saved.length && !idle && !interval) {
        state.reason = "Waiting for an enabled save, idle or interval trigger.";
        if (policy.triggers.includes("interval"))
          state.nextRun = nextOperatingTime(
            policy,
            Math.max(earliest, (last ?? at) + policy.intervalMs),
          );
        continue;
      }
      const selection = await this.select(pipeline, saved, prior);
      if (!selection.sources.length) {
        state.reason = "No changed, eligible inputs remain inside this policy's scope.";
        continue;
      }
      const trigger = saved.length ? "save" : idle ? "idle" : "interval";
      const key = contentRevision(
        [
          pipeline,
          configuration.revision,
          selection.inventory,
          ...selection.sources.map((source) => `${source.path}:${source.revision}`),
        ].join("\n"),
      );
      const submitted = await this.opts.jobs.run(
        { pipeline, sources: selection.sources, preview: false, idempotencyKey: key },
        { id: "background", kind: "agent", scopes: ["read", "write"] },
        {
          reason: `${trigger} trigger under configuration ${configuration.revision.slice(0, 12)}; ${selection.sources.length} scoped notes`,
          key,
        },
      );
      state.lastRun = submitted.createdAt;
      state.reason = `${trigger} job is ${submitted.state} for ${selection.sources.length} notes.`;
      state.nextRun = nextOperatingTime(
        policy,
        at + Math.max(policy.cooldownMs, policy.intervalMs),
      );
    }
    for (const [path, atSaved] of this.saves) if (at - atSaved > 86400000) this.saves.delete(path);
    await this.opts.jobs.pump();
  }
  private async select(pipeline: PipelineId, saved: string[], prior: PipelineJob[]) {
    const current = this.opts.settings.background();
    const policy = current.settings.pipelines[pipeline];
    const scope = structuredClone(policy.readScope);
    const catalog = new NoteCatalogService(this.opts.vault);
    const notes: NoteReference[] = [];
    let cursor: string | undefined;
    let inventory = "";
    do {
      const page = await catalog.list({ scope, limit: 200, ...(cursor ? { cursor } : {}) });
      inventory = page.snapshot;
      notes.push(...page.notes);
      cursor = page.nextCursor ?? undefined;
      if (notes.length >= 10000) break;
    } while (cursor);
    const completed = new Set(
      prior
        .filter(
          (job) =>
            job.configurationRevision === current.revision &&
            ["completed", "awaiting-approval", "partial"].includes(job.state),
        )
        .flatMap((job) => job.sourceRevisions.map((source) => `${source.path}:${source.revision}`)),
    );
    const maximum = ["index-extract", "enrich"].includes(pipeline)
      ? policy.budget.notes
      : Math.max(1, Math.floor(policy.budget.notes / 2));
    const sources = notes
      .filter(
        (note) =>
          (pipeline !== "inbox" || insideFolder(note.path, policy.destinations.inbox)) &&
          (!saved.length || saved.includes(note.path)) &&
          !completed.has(`${note.path}:${note.revision}`),
      )
      .slice(0, maximum);
    return { sources, inventory };
  }
  private report(error: unknown): void {
    process.stderr.write(
      `${JSON.stringify({ type: "pipeline:scheduler_error", message: error instanceof Error ? error.message : String(error) })}\n`,
    );
  }
}
