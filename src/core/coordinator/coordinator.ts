import type { VaultAdapter } from "../../adapters/vaultAdapter";
import { contentRevision, NoteReadService } from "../../api/notes";
import { type PipelineId, pipelineIdSchema, scopeSchema } from "../../api/operations";
import type {
  PipelineJob,
  PipelineReconsiderationAssessment,
} from "../../api/pipelines";
import { NoteApiError, type NoteReference } from "../../api/schema";
import { insideFolder, scopeAllows } from "../../api/scope";
import {
  changedIntelligenceDependencies,
  intelligenceRecordId,
  parseAllIntelligenceRecords,
} from "../intelligence";
import { cultivationBudgetStatus } from "../cultivation/budget";
import { CultivationService } from "../cultivation/service";
import { assessAttention, attentionPriorityMap } from "../cultivation/attention";
import type { EventBus } from "../events/eventBus";
import type { JobService } from "../pipelines/jobService";
import { stableJobId } from "../pipelines/jobStore";
import {
  hasQuestionForRecord,
  MAX_CONTEXT_RECHECK_CANDIDATES,
} from "../pipelines/reconsiderIntelligence";
import {
  reconsiderationContextMatches,
  reconsiderationContextRevision,
} from "../pipelines/reconsiderationContext";
import { insideOperatingWindow, nextOperatingTime } from "../pipelines/schedule";
import type { SentienceActivity } from "../services/sentienceActivity";
import type { SettingsService } from "../settings/settingsService";
import {
  PendingSourceAttentionStore,
  type PendingSourceAttention,
} from "./pendingSourceAttention";

interface ChangedDependentPage {
  eventId: string;
  inventory: string;
  blockedInventory?: string;
  afterPath: string | null;
  complete: boolean;
  blocked: boolean;
}

interface CoordinatorSelection {
  sources: NoteReference[];
  inventory: string;
  attention: string[];
  requiresModel: boolean;
  page: ChangedDependentPage | null;
}

function cultivationInputsMatch(recorded: PipelineJob["policy"], current: PipelineJob["policy"]): boolean {
  const inputs = (policy: PipelineJob["policy"]) => ({
    readScope: policy.readScope,
    writeScope: policy.writeScope,
    destinations: policy.destinations,
    allowedProperties: policy.allowedProperties,
    allowedSections: policy.allowedSections,
    effects: policy.effects,
    parameters: policy.parameters,
  });
  return JSON.stringify(inputs(recorded)) === JSON.stringify(inputs(current));
}

export interface CoordinatorOptions {
  bus: EventBus;
  jobs: JobService;
  settings: SettingsService;
  vault: VaultAdapter;
  activity: Pick<SentienceActivity, "snapshot">;
  appliedSources?: (job: PipelineJob) => Promise<NoteReference[]>;
  pendingStatePath?: string;
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
  private workPending = false;
  private readonly saves = new Map<string, number>();
  private readonly seenChangeIds = new Map<string, true>();
  private readonly status = new Map<PipelineId, PipelineScheduleStatus>();
  private readonly now: () => number;
  private readonly cultivation: CultivationService;
  private readonly pendingSourceAttention: PendingSourceAttentionStore;
  constructor(private readonly opts: CoordinatorOptions) {
    this.now = opts.now ?? Date.now;
    this.pendingSourceAttention = new PendingSourceAttentionStore(opts.pendingStatePath);
    this.cultivation = new CultivationService({
      vault: opts.vault,
      jobs: opts.jobs,
      settings: opts.settings,
      activity: opts.activity,
      now: this.now,
      schedule: (pipeline) => this.schedule(pipeline),
    });
  }
  digest(input: Parameters<CultivationService["digest"]>[0] = {}) {
    return this.cultivation.digest(input);
  }
  async cultivationSettings() {
    await this.opts.settings.refreshBackground();
    const configuration = this.opts.settings.background();
    return {
      ok: true as const,
      revision: configuration.revision,
      paused: configuration.settings.paused,
      attention: configuration.settings.cultivation.attention,
      methodology: configuration.settings.cultivation.methodology,
    };
  }
  start(): void {
    if (this.running) return;
    this.running = true;
    this.opts.jobs.resume();
    this.subs.push(
      this.opts.bus.on("sentience:activity", (event) => {
        if (
          event.activeNotePath &&
          ["vault:add", "vault:change", "vault:rename"].includes(event.source)
        ) {
          this.markSave(event.activeNotePath);
          void this.pendingSourceAttention
            .record(event.activeNotePath, null, "changed", this.now())
            .catch((error) => this.report(error));
        }
      }),
      this.opts.bus.on("note:changed", (event) => {
        if (event.callerId === "background" || this.seenChangeIds.has(event.changeId)) return;
        this.seenChangeIds.set(event.changeId, true);
        if (this.seenChangeIds.size > 10000) {
          const oldest = this.seenChangeIds.keys().next().value;
          if (oldest !== undefined) this.seenChangeIds.delete(oldest);
        }
        this.markSave(event.path);
        void this.pendingSourceAttention
          .record(event.path, event.revision, "changed", this.now())
          .catch((error) => this.report(error));
      }),
      this.opts.bus.on("indexer:tombstoned", (event) => {
        this.markSave(event.path);
        void this.pendingSourceAttention
          .record(event.path, null, "deleted", this.now())
          .catch((error) => this.report(error));
      }),
      this.opts.bus.on("indexer:renamed", (event) => {
        const at = this.now();
        this.markSave(event.fromPath, at);
        this.markSave(event.toPath, at);
        void this.pendingSourceAttention
          .record(event.fromPath, null, "deleted", at)
          .then(() => this.pendingSourceAttention.record(event.toPath, null, "changed", at))
          .catch((error) => this.report(error));
      }),
    );
    void this.pendingSourceAttention
      .saveTriggers()
      .then((persisted) => {
        for (const { path, at } of persisted)
          if ((this.saves.get(path) ?? 0) < at) this.saves.set(path, at);
      })
      .catch((error) => this.report(error));
    this.timer = setInterval(() => {
      void this.tick().catch((error) => this.report(error));
    }, 1000);
    this.timer.unref();
    void this.tick().catch((error) => this.report(error));
  }
  private markSave(path: string, at = this.now()): void {
    this.saves.set(path, at);
    void this.pendingSourceAttention.recordSave(path, at).catch((error) => this.report(error));
  }
  hasPendingWork(): boolean {
    return this.workPending;
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
  private async reconcilePendingSources(jobs: PipelineJob[], at: number): Promise<void> {
    const pending = await this.pendingSourceAttention.list();
    for (const source of pending) {
      const inFlight = source.inFlight;
      if (!inFlight) continue;
      const job = jobs.find((candidate) => candidate.id === inFlight.jobId);
      if (!job) {
        if (at - inFlight.startedAt >= 3000)
          await this.pendingSourceAttention.finishPage(source.id, false);
      } else if (["failed", "cancelled", "partial"].includes(job.state)) {
        await this.pendingSourceAttention.finishPage(source.id, false);
      } else if (job.state === "completed") {
        const deferred = job.plan?.reconsiderationDeferred;
        if (deferred === "capacity") {
          const configuration = this.opts.settings.background();
          const inventory = await this.changedDependentInventory(configuration, jobs, at);
          await this.pendingSourceAttention.finishPage(source.id, false, inventory.blocked);
        } else {
          await this.pendingSourceAttention.finishPage(source.id, deferred !== "assessment");
        }
      }
    }
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
    await this.reconcilePendingSources(jobs, at);
    let pendingSources = await this.pendingSourceAttention.list();
    let submittedThisTick = false;
    let workPending = jobs.some(
      (job) => job.background && ["queued", "running", "waiting-inference"].includes(job.state),
    );
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
        state.reason = "Background cultivation is disabled for this pipeline.";
        continue;
      }
      if (!policy.triggers.length) {
        state.reason = "No background trigger is selected.";
        continue;
      }
      if (pipeline === "reconsider" && pendingSources.some((source) => source.blockedInventory)) {
        const inventory = await this.changedDependentInventory(configuration, jobs, at);
        await this.pendingSourceAttention.unblockChangedInventory([inventory.base, inventory.blocked]);
        pendingSources = await this.pendingSourceAttention.list();
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
      const saved = pipeline !== "reconsider" && policy.triggers.includes("save")
        ? [...this.saves]
            .filter(
              ([, savedAt]) =>
                at - savedAt >= policy.debounceMs && (last === null || savedAt > last),
            )
            .map(([path]) => path)
        : [];
      if (
        policy.triggers.includes("save") &&
        pipeline !== "reconsider" &&
        [...this.saves].some(([, savedAt]) => at - savedAt < policy.debounceMs + 1000 && (last === null || savedAt > last))
      )
        workPending = true;
      const idle =
        policy.triggers.includes("idle") &&
        at - this.opts.activity.snapshot().lastHumanActivityAt >= policy.idleMs;
      const interval =
        policy.triggers.includes("interval") && (last === null || at - last >= policy.intervalMs);
      const pendingEvent =
        pipeline === "reconsider"
          ? pendingSources
              .filter((source) => !source.inFlight && source.blockedInventory === null)
              .sort((left, right) => left.observedAt - right.observedAt || left.path.localeCompare(right.path))[0] ??
            null
          : null;
      const pendingSaveReady =
        pendingEvent !== null &&
        policy.triggers.includes("save") &&
        at - pendingEvent.observedAt >= policy.debounceMs;
      const pendingSource =
        pendingSaveReady || idle || interval ? pendingEvent : null;
      const awaitingReview =
        pipeline === "reconsider" &&
        pendingSources.some((source) => {
          const job = source.inFlight ? jobs.find((candidate) => candidate.id === source.inFlight?.jobId) : null;
          return job?.state === "awaiting-approval";
        });
      if (awaitingReview && !pendingSource) {
        state.reason = "A pending source reconsideration page is awaiting review.";
        continue;
      }
      if (
        pipeline === "reconsider" &&
        !pendingSource &&
        pendingSources.some((source) => source.blockedInventory !== null || source.inFlight !== null)
      ) {
        state.reason = "A pending source scan is waiting for a source, policy or inventory change.";
        continue;
      }
      if (!saved.length && !idle && !interval && !pendingSource) {
        state.reason = "Waiting for an enabled save, idle or interval trigger.";
        if (policy.triggers.includes("interval"))
          state.nextRun = nextOperatingTime(
            policy,
            Math.max(earliest, (last ?? at) + policy.intervalMs),
          );
        continue;
      }
      const activeJobs = jobs.filter(
        (job) => job.background && ["queued", "running", "waiting-inference"].includes(job.state),
      );
      if (submittedThisTick || activeJobs.length) {
        state.reason = "Another background run is still pending.";
        continue;
      }
      const selection =
        pipeline === "reconsider"
          ? await this.selectChangedDependents(
              pipeline,
              pendingSource ? [pendingSource.path] : [],
              pendingSource,
              prior,
              cultivationBudgetStatus(jobs, configuration.settings.cultivation.attention, at),
              at,
            )
          : await this.select(pipeline, saved, prior);
      if (pipeline === "reconsider" && selection.page?.blocked) {
        await this.pendingSourceAttention.completePage(selection.page.eventId, {
          inventory: selection.page.inventory,
          afterPath: selection.page.afterPath,
          complete: false,
          blocked: true,
          blockedInventory: selection.page.blockedInventory,
        });
        pendingSources = await this.pendingSourceAttention.list();
        state.reason = "A pending source scan needs additional in-scope dependency read capacity.";
        continue;
      }
      if (!selection.sources.length) {
        if (pipeline === "reconsider" && pendingSource && selection.page) {
          await this.pendingSourceAttention.completePage(selection.page.eventId, {
            inventory: selection.page.inventory,
            afterPath: selection.page.afterPath,
            complete: selection.page.complete,
          });
          pendingSources = await this.pendingSourceAttention.list();
        }
        state.reason =
          pipeline === "reconsider"
            ? pendingSource
              ? "The bounded source fan-out scan advanced without finding another dependent note."
              : "No retained source evidence has changed for a dependent note in scope."
            : "No eligible, scoped notes remain within the attention budget.";
        continue;
      }
      const trigger = pendingSaveReady && pendingSource ? "save" : saved.length ? "save" : idle ? "idle" : "interval";
      const budget = cultivationBudgetStatus(
        jobs,
        configuration.settings.cultivation.attention,
        at,
      );
      const modelFree =
        (pipeline === "reconsider" && !selection.requiresModel) ||
        (pipeline === "index-extract" &&
          !policy.parameters.indexExtract.extraction &&
          !policy.parameters.indexExtract.embeddings);
      const tokenBudget = modelFree ? 0 : Math.min(policy.budget.tokens, budget.tokens.remaining);
      const callBudget = modelFree
        ? 0
        : Math.min(policy.budget.modelCalls, budget.modelCalls.remaining);
      const semanticBudgetAvailable =
        callBudget > 0 && tokenBudget >= policy.budget.generationTokens;
      if (pipeline === "reconsider" && selection.requiresModel && !semanticBudgetAvailable) {
        if (pendingSource && selection.page) {
          await this.pendingSourceAttention.completePage(pendingSource.id, {
            inventory: selection.page.inventory,
            afterPath: selection.page.afterPath,
            complete: false,
            blocked: true,
            blockedInventory: selection.page.blockedInventory,
          });
          pendingSources = await this.pendingSourceAttention.list();
        }
        state.reason =
          callBudget < 1 || policy.budget.modelCalls < 1
            ? "A contextual recheck is waiting for an explicitly configured model-call budget."
            : "A contextual recheck is waiting for enough daily or per-run tokens to fit its reasoning ceiling.";
        continue;
      }
      if (pipeline !== "reconsider" && !modelFree && (tokenBudget < 1 || callBudget < 1)) {
        state.reason = "The daily cultivation token or model-call budget is exhausted.";
        continue;
      }
      const key = contentRevision(
        [
          pipeline,
          configuration.revision,
          trigger,
          trigger === "save"
            ? saved.map((path) => `${path}:${this.saves.get(path) ?? 0}`).join("\n")
            : `${this.opts.activity.snapshot().epoch}:${last ?? 0}:${Math.floor(at / Math.max(policy.intervalMs, 1))}`,
          selection.inventory,
          ...(selection.page
            ? [
                selection.page.eventId,
                selection.page.inventory,
                selection.page.afterPath ?? "",
                String(selection.page.complete),
                String(pendingSource?.attempt ?? 0),
              ]
            : []),
          ...selection.attention,
          ...selection.sources.map((source) => `${source.path}:${source.revision}`),
        ].join("\n"),
      );
      if (pipeline === "reconsider" && pendingSource && selection.page) {
        const jobId = stableJobId("background", key);
        await this.pendingSourceAttention.beginPage(pendingSource.id, {
          jobId,
          inventory: selection.page.inventory,
          afterPath: selection.page.afterPath,
          complete: selection.page.complete,
          startedAt: at,
        });
      }
      const submitted = await this.opts.jobs.run(
        { pipeline, sources: selection.sources, preview: false, idempotencyKey: key },
        { id: "background", kind: "agent", scopes: ["read", "write"] },
        {
          reason: `${trigger} trigger under configuration ${configuration.revision.slice(0, 12)}; ${selection.sources.length} scoped notes`,
          key,
          budget: { tokens: tokenBudget, modelCalls: callBudget },
        },
      );
      if (pipeline === "reconsider" && pendingSource && selection.page) {
        pendingSources = await this.pendingSourceAttention.list();
      }
      submittedThisTick = true;
      state.lastRun = submitted.createdAt;
      state.reason = `${trigger} job is ${submitted.state} for ${selection.sources.length} notes.`;
      state.nextRun = nextOperatingTime(
        policy,
        at + Math.max(policy.cooldownMs, policy.intervalMs),
      );
    }
    for (const [path, atSaved] of this.saves) if (at - atSaved > 86400000) this.saves.delete(path);
    await this.pendingSourceAttention.pruneSaves(at - 86400000);
    this.workPending = workPending;
    await this.opts.jobs.pump();
  }
  private async select(pipeline: PipelineId, saved: string[], prior: PipelineJob[]) {
    const current = this.opts.settings.background();
    const policy = current.settings.pipelines[pipeline];
    const scope = scopeSchema.parse(policy.readScope);
    const maximum = ["index-extract", "enrich"].includes(pipeline)
      ? policy.budget.notes
      : pipeline === "synthesize"
        ? 1
        : Math.max(1, Math.floor(policy.budget.notes / 2));
    const files = await this.opts.vault.listMarkdown();
    const inventory = contentRevision(JSON.stringify(files));
    const pathScope = { ...scope, tags: [], excludeTags: [] };
    const savedAt = new Map(saved.map((path) => [path, this.saves.get(path) ?? this.now()]));
    const attention = current.settings.cultivation.attention;
    const priorities = attentionPriorityMap(attention);
    const activity = this.opts.activity.snapshot();
    const selectionAt = this.now();
    const completed = new Set<string>();
    const lastCultivated = new Map<string, number>();
    const appliedOutputPaths = new Set<string>();
    const appliedJobs: PipelineJob[] = [];
    for (const job of prior) {
      if (
        !cultivationInputsMatch(job.policy, policy) ||
        !["completed", "awaiting-approval", "partial"].includes(job.state)
      )
        continue;
      for (const source of job.sourceRevisions) {
        const key = `${source.path}:${source.revision}`;
        completed.add(key);
        lastCultivated.set(
          source.path,
          Math.max(lastCultivated.get(source.path) ?? 0, job.updatedAt),
        );
      }
      if (
        job.effects?.effects.some((effect) => effect.state === "applied" && effect.historyId) &&
        this.opts.appliedSources
      )
        appliedJobs.push(job);
    }
    for (const job of appliedJobs
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
      .slice(0, policy.budget.candidates)) {
      try {
        for (const source of await this.opts.appliedSources!(job)) {
          completed.add(`${source.path}:${source.revision}`);
          appliedOutputPaths.add(source.path);
          lastCultivated.set(
            source.path,
            Math.max(lastCultivated.get(source.path) ?? 0, job.updatedAt),
          );
        }
      } catch (error) {
        this.report(error);
      }
    }
    const sorted = files
      .filter(
        (file) =>
          scopeAllows(pathScope, file.path, []) &&
          (!saved.length || saved.includes(file.path)) &&
          (pipeline !== "inbox" || insideFolder(file.path, policy.destinations.inbox)),
      )
      .sort(
        (left, right) =>
          this.preliminaryAttention(
            right.path,
            right.mtime,
            activity.activeNotePath,
            savedAt,
            priorities,
            lastCultivated,
            attention.revisitDays,
            selectionAt,
          ) -
            this.preliminaryAttention(
              left.path,
              left.mtime,
              activity.activeNotePath,
              savedAt,
              priorities,
              lastCultivated,
              attention.revisitDays,
              selectionAt,
            ) || left.path.localeCompare(right.path),
      );
    const candidatePaths = sorted.map((file) => file.path).sort((left, right) => left.localeCompare(right));
    const filesByPath = new Map(sorted.map((file) => [file.path, file]));
    const cursorInventory = contentRevision(
      JSON.stringify([
        pipeline,
        current.revision,
        scope,
        policy.budget.candidates,
        policy.budget.notes,
        attention,
        activity.activeNotePath,
        [...savedAt].sort(([left], [right]) => left.localeCompare(right)),
        candidatePaths.map((path) => {
          const file = filesByPath.get(path);
          const last = lastCultivated.get(path);
          const ownOutputUnchanged =
            appliedOutputPaths.has(path) &&
            !savedAt.has(path) &&
            last !== undefined &&
            file !== undefined &&
            file.mtime <= last;
          return [
            path,
            ownOutputUnchanged ? null : file?.mtime ?? null,
            last === undefined || selectionAt - last >= attention.revisitDays * 86400000,
          ];
        }),
      ]),
    );
    const cursorKey = `cultivation:${pipeline}`;
    const existingCursor = await this.pendingSourceAttention.scanCursor(cursorKey, cursorInventory);
    if (existingCursor?.complete) return { sources: [], inventory, attention: [], requiresModel: false, page: null };
    let afterPath = existingCursor?.afterPath ?? null;
    let remaining = existingCursor?.remaining ?? candidatePaths.length;
    let cycleFound = existingCursor?.cycleFound ?? false;
    if (!existingCursor && sorted.length) {
      const firstPath = sorted[0].path;
      const firstIndex = candidatePaths.indexOf(firstPath);
      afterPath = candidatePaths[(firstIndex + candidatePaths.length - 1) % candidatePaths.length];
    }
    if (remaining === 0 && cycleFound) {
      remaining = candidatePaths.length;
      cycleFound = false;
    }
    if (!candidatePaths.length || remaining === 0) {
      await this.pendingSourceAttention.advanceScanCursor(cursorKey, {
        inventory: cursorInventory,
        afterPath,
        remaining: 0,
        cycleFound: false,
        complete: true,
      });
      return { sources: [], inventory, attention: [], requiresModel: false, page: null };
    }
    const afterIndex = afterPath === null ? -1 : candidatePaths.indexOf(afterPath);
    const startIndex = afterIndex < 0 ? 0 : (afterIndex + 1) % candidatePaths.length;
    const pageLength = Math.min(policy.budget.candidates, remaining, candidatePaths.length);
    const scannedFiles = Array.from({ length: pageLength }, (_, offset) =>
      filesByPath.get(candidatePaths[(startIndex + offset) % candidatePaths.length])!,
    );
    const reader = new NoteReadService(this.opts.vault);
    const candidates: Array<{ source: NoteReference; score: number; attention: string[] }> = [];
    let inspected = 0;
    let lastScannedPath = afterPath;
    for (const file of scannedFiles) {
      if (!this.running) break;
      lastScannedPath = file.path;
      inspected += 1;
      let note: Awaited<ReturnType<NoteReadService["read"]>>;
      try {
        note = await reader.read({ path: file.path });
      } catch (error) {
        if (error instanceof NoteApiError && error.code === "NOT_FOUND") continue;
        throw error;
      }
      if (!scopeAllows(scope, note.note.path, note.structure.tags)) continue;
      const records = this.retainedRecords(note.body);
      const assessed = assessAttention(
        {
          path: note.note.path,
          revision: note.note.revision,
          modifiedAt: file.mtime,
          active: note.note.path === activity.activeNotePath,
          savedAt: savedAt.get(note.note.path) ?? null,
          lastCultivatedAt: lastCultivated.get(note.note.path) ?? null,
          currentRevisionCultivated: completed.has(`${note.note.path}:${note.note.revision}`),
          unresolvedQuestion:
            note.structure.headings.some((heading) => heading.text.trim().endsWith("?")) ||
            records.some((record) => record.kind === "question" && record.status === "open"),
          openTaskCount: note.structure.tasks.filter((task) => !task.checked).length,
          changedEvidence: false,
          explicitPriority: priorities.get(note.note.path) ?? 0,
        },
        selectionAt,
        attention.revisitDays,
      );
      if (!assessed.eligible) continue;
      candidates.push({ source: note.note, score: assessed.score, attention: assessed.reasons });
    }
    if (inspected > 0) {
      let nextRemaining = Math.max(0, remaining - inspected);
      let nextCycleFound = cycleFound || candidates.length > 0;
      let complete = false;
      if (nextRemaining === 0) {
        if (nextCycleFound) {
          nextRemaining = candidatePaths.length;
          nextCycleFound = false;
        } else {
          complete = true;
        }
      }
      await this.pendingSourceAttention.advanceScanCursor(cursorKey, {
        inventory: cursorInventory,
        afterPath: lastScannedPath,
        remaining: nextRemaining,
        cycleFound: nextCycleFound,
        complete,
      });
    }
    candidates.sort(
      (left, right) =>
        right.score - left.score || left.source.path.localeCompare(right.source.path),
    );
    const selected = candidates.slice(0, maximum);
    return {
      sources: selected.map((candidate) => candidate.source),
      inventory,
      requiresModel: false,
      attention: selected.map(
        (candidate) => `${candidate.source.path}:${candidate.attention.join(",")}`,
      ),
      page: null,
    };
  }

  private async selectChangedDependents(
    pipeline: PipelineId,
    saved: string[],
    pendingSource: PendingSourceAttention | null,
    prior: readonly PipelineJob[],
    budgetStatus: ReturnType<typeof cultivationBudgetStatus>,
    at: number,
  ): Promise<CoordinatorSelection> {
    const configuration = this.opts.settings.background();
    const policy = configuration.settings.pipelines[pipeline];
    const scope = scopeSchema.parse(policy.readScope);
    const writeScope = scopeSchema.parse(policy.writeScope);
    const files = await this.opts.vault.listMarkdown();
    const pathScope = { ...scope, tags: [], excludeTags: [] };
    const candidatePaths = files
      .filter((file) => scopeAllows(pathScope, file.path, []))
      .map((file) => file.path)
      .sort((left, right) => left.localeCompare(right));
    const filesByPath = new Map(files.map((file) => [file.path, file]));
    const inventory = contentRevision(
      JSON.stringify([
        candidatePaths.map((path) => [path, filesByPath.get(path)?.mtime ?? null]),
        configuration.revision,
        scope,
        writeScope,
        policy.budget.candidates,
        policy.budget.notes,
      ]),
    );
    const blockedInventory = this.dependentBlockInventory(configuration, inventory, budgetStatus, at);
    const revisitMs = configuration.settings.cultivation.attention.revisitDays * 86_400_000;
    const currentReconsiderationContext = {
      configurationRevision: configuration.revision,
      reconsiderationContextRevision: reconsiderationContextRevision(
        policy,
        configuration.settings.cultivation.methodology,
      ),
    };
    const completedAssessments: PipelineReconsiderationAssessment[] = prior
      .filter(
        (job) =>
          job.state === "completed" &&
          reconsiderationContextMatches(job, currentReconsiderationContext) &&
          at - job.updatedAt < revisitMs &&
          job.plan !== null,
      )
      .flatMap((job) => job.plan?.reconsiderationAssessments ?? [])
      .filter((assessment) => assessment.outcome !== "material-context-change");
    const savedPaths = pendingSource
      ? new Set([pendingSource.path])
      : saved.length
        ? new Set(saved)
        : null;
    const cursorKey = "cultivation:reconsider";
    const cursorInventory = contentRevision(JSON.stringify([
      inventory,
      saved,
      prior
        .filter((job) => job.state === "completed" &&
          reconsiderationContextMatches(job, currentReconsiderationContext) &&
          at - job.updatedAt >= revisitMs)
        .map((job) => job.id)
        .sort(),
    ]));
    const cursor = pendingSource ? null : await this.pendingSourceAttention.scanCursor(cursorKey, cursorInventory);
    if (cursor?.complete)
      return { sources: [], inventory, attention: [], requiresModel: false, page: null };
    const afterPath = pendingSource
      ? pendingSource.inventory === inventory ? pendingSource.afterPath : null
      : cursor?.afterPath ?? null;
    const remaining = cursor?.remaining ?? candidatePaths.length;
    if (pendingSource?.blockedInventory === inventory || pendingSource?.blockedInventory === blockedInventory) {
      return {
        sources: [],
        inventory,
        attention: [],
        requiresModel: false,
        page: {
          eventId: pendingSource.id,
          inventory,
          blockedInventory: pendingSource.blockedInventory ?? inventory,
          afterPath,
          complete: false,
          blocked: true,
        },
      };
    }
    const pageCandidates = pendingSource
      ? candidatePaths
          .filter((path) => afterPath === null || path.localeCompare(afterPath) > 0)
          .slice(0, policy.budget.candidates)
          .map((path) => filesByPath.get(path)!)
      : null;
    const afterIndex = afterPath === null ? -1 : candidatePaths.indexOf(afterPath);
    const attentionCandidates = pendingSource
      ? []
      : candidatePaths.length
        ? Array.from({ length: Math.min(policy.budget.candidates, remaining, candidatePaths.length) }, (_, offset) =>
            filesByPath.get(candidatePaths[(afterIndex + 1 + offset) % candidatePaths.length])!)
        : [];
    const candidates = pageCandidates ?? attentionCandidates;
    const reader = new NoteReadService(this.opts.vault);
    const selected: NoteReference[] = [];
    const dependenciesSeen = new Set<string>();
    const inspectedSources = new Map<string, Awaited<ReturnType<NoteReadService["read"]>> | null>();
    const unavailableSources = new Set<string>();
    const maximumTargets = pendingSource ? 1 : Math.max(1, Math.floor(policy.budget.notes / 2));
    const dependencyReadLimit = Math.max(0, policy.budget.notes - maximumTargets);
    const contextBudgetAvailable =
      Math.min(policy.budget.modelCalls, budgetStatus.modelCalls.remaining) > 0 &&
      Math.min(policy.budget.tokens, budgetStatus.tokens.remaining) >= policy.budget.generationTokens;
    let inspectedDependencies = 0;
    let lastScannedPath = afterPath;
    let deferredAfterPath: string | null | undefined;
    let blocked = false;
    let requiresModel = false;
    let inspectedTargets = 0;
    for (const file of candidates) {
      if (!this.running || selected.length >= maximumTargets) break;
      inspectedTargets += 1;
      const priorPath = lastScannedPath;
      let note: Awaited<ReturnType<NoteReadService["read"]>>;
      try {
        note = await reader.read({ path: file.path });
      } catch (error) {
        if (error instanceof NoteApiError && error.code === "NOT_FOUND") {
          lastScannedPath = file.path;
          continue;
        }
        if (!pendingSource) throw error;
        blocked = true;
        break;
      }
      if (!scopeAllows(scope, note.note.path, note.structure.tags) || !scopeAllows(writeScope, note.note.path, note.structure.tags)) {
        lastScannedPath = file.path;
        continue;
      }
      inspectedSources.set(note.note.path, note);
      const records = this.retainedRecords(note.body);
      let dependent = false;
      let deterministicDependent = false;
      let contextualDependent = false;
      let contextualCandidateCount = 0;
      const contextualSourcePaths = new Set<string>();
      for (const record of records) {
        if (
          record.kind === "feedback" ||
          record.kind === "question" ||
          record.status === "superseded" ||
          hasQuestionForRecord(records, intelligenceRecordId(record))
        )
          continue;
        const refs = new Map<string, string>();
        for (const dependency of record.dependencies)
          refs.set(dependency.path, dependency.revision);
        for (const evidence of record.evidence)
          refs.set(evidence.source.path, evidence.source.revision);
        for (const relationship of record.relationships)
          for (const evidence of relationship.evidence) refs.set(evidence.path, evidence.revision);
        if (!refs.size || (savedPaths && ![...refs.keys()].some((path) => savedPaths.has(path))))
          continue;
        if (refs.size > Math.max(1, policy.budget.candidates * 2)) {
          if (pendingSource) blocked = true;
          if (blocked) break;
          continue;
        }
        const currentSources: Array<{ path: string; revision: string; body: string }> = [
          { path: note.note.path, revision: note.note.revision, body: note.body },
        ];
        let complete = true;
        for (const [path] of refs) {
          if (!scopeAllows(pathScope, path, [])) {
            complete = false;
            break;
          }
          if (path === note.note.path) {
            continue;
          }
          if (unavailableSources.has(path)) {
            complete = false;
            blocked = pendingSource !== null;
            break;
          }
          if (!inspectedSources.has(path)) {
            if (inspectedDependencies >= dependencyReadLimit) {
              complete = false;
              blocked = pendingSource !== null;
              break;
            }
            inspectedDependencies += 1;
            try {
              inspectedSources.set(path, await reader.read({ path }));
            } catch (error) {
              if (error instanceof NoteApiError && error.code === "NOT_FOUND")
                inspectedSources.set(path, null);
              else {
                unavailableSources.add(path);
                complete = false;
                blocked = pendingSource !== null;
                break;
              }
            }
          }
          const source = inspectedSources.get(path);
          if (source === null) {
            dependenciesSeen.add(`${path}:missing`);
            continue;
          }
          if (!source) {
            complete = false;
            break;
          }
          if (!scopeAllows(scope, path, source.structure.tags)) {
            complete = false;
            break;
          }
          currentSources.push({ path, revision: source.note.revision, body: source.body });
          dependenciesSeen.add(`${path}:${source.note.revision}`);
        }
        if (!complete) continue;
        const changedDependencies = changedIntelligenceDependencies(record, currentSources).filter(
          (dependency) =>
            (!dependency.retainedEvidence || dependency.revisionChanged) &&
            (!savedPaths || savedPaths.has(dependency.path)),
        );
        const recordId = intelligenceRecordId(record);
        const matchingReceipts = completedAssessments.filter(
          (assessment) =>
            assessment.recordId === recordId &&
            assessment.target.path === note.note.path &&
            assessment.target.revision === note.note.revision &&
            assessment.sourceRevisions.every((reference) =>
              currentSources.some(
                (source) => source.path === reference.path && source.revision === reference.revision,
              ),
            ),
        );
        const coveredPaths = new Set(
          matchingReceipts.flatMap((assessment) => assessment.sourceRevisions.map((source) => source.path)),
        );
        const deterministicChanges = changedDependencies.filter(
          (dependency) => dependency.currentRevision === null || dependency.changedEvidence.length > 0,
        );
        const contextualChanges = changedDependencies.filter(
          (dependency) =>
            dependency.currentRevision !== null &&
            dependency.revisionChanged &&
            dependency.changedEvidence.length === 0 &&
            !coveredPaths.has(dependency.path),
        );
        const changed = deterministicChanges.length > 0 || contextualChanges.length > 0;
        if (changed) {
          dependent = true;
          const staleSupport = deterministicChanges.length > 0;
          deterministicDependent ||= staleSupport;
          if (!staleSupport && contextualChanges.length) {
            contextualDependent = true;
            contextualCandidateCount += 1;
            for (const dependency of contextualChanges) contextualSourcePaths.add(dependency.path);
          }
        }
      }
      if (blocked) break;
      lastScannedPath = file.path;
      if (dependent) {
        selected.push(note.note);
        if (contextualDependent) {
          if (contextBudgetAvailable) requiresModel = true;
          else {
            if (pendingSource) deferredAfterPath = priorPath;
            if (!deterministicDependent) requiresModel = true;
          }
          if (
            pendingSource &&
            (contextualCandidateCount > Math.min(MAX_CONTEXT_RECHECK_CANDIDATES, policy.budget.candidates) ||
              contextualSourcePaths.size > 4)
          )
            deferredAfterPath = priorPath;
        }
      }
      if (dependent && pendingSource) break;
    }
    const scanComplete =
      pendingSource !== null &&
      !blocked &&
      (pageCandidates?.length === 0 || lastScannedPath === candidatePaths.at(-1));
    const selectionInventory = contentRevision(
      JSON.stringify([
        inventory,
        pendingSource?.id ?? "",
        [...dependenciesSeen].sort(),
        selected.map((source) => `${source.path}:${source.revision}`),
      ]),
    );
    if (!pendingSource) {
      let nextRemaining = Math.max(0, remaining - inspectedTargets);
      let cycleFound = (cursor?.cycleFound ?? false) || selected.length > 0;
      let complete = false;
      if (nextRemaining === 0) {
        if (cycleFound) {
          nextRemaining = candidatePaths.length;
          cycleFound = false;
        } else complete = true;
      }
      await this.pendingSourceAttention.advanceScanCursor(cursorKey, {
        inventory: cursorInventory,
        afterPath: lastScannedPath,
        remaining: nextRemaining,
        cycleFound,
        complete,
      });
    }
    return {
      sources: selected,
      inventory: selectionInventory,
      attention: [],
      requiresModel,
      page: pendingSource
        ? {
            eventId: pendingSource.id,
            inventory,
            blockedInventory: blocked ? inventory : blockedInventory,
            afterPath: deferredAfterPath === undefined ? lastScannedPath : deferredAfterPath,
            complete: deferredAfterPath === undefined && scanComplete,
            blocked,
          }
        : null,
    };
  }

  private async changedDependentInventory(
    configuration: ReturnType<SettingsService["background"]>,
    jobs: readonly PipelineJob[],
    at: number,
  ): Promise<{ base: string; blocked: string }> {
    const policy = configuration.settings.pipelines.reconsider;
    const scope = scopeSchema.parse(policy.readScope);
    const writeScope = scopeSchema.parse(policy.writeScope);
    const files = await this.opts.vault.listMarkdown();
    const pathScope = { ...scope, tags: [], excludeTags: [] };
    const candidatePaths = files
      .filter((file) => scopeAllows(pathScope, file.path, []))
      .map((file) => file.path)
      .sort((left, right) => left.localeCompare(right));
    const filesByPath = new Map(files.map((file) => [file.path, file]));
    const base = contentRevision(
      JSON.stringify([
        candidatePaths.map((path) => [path, filesByPath.get(path)?.mtime ?? null]),
        configuration.revision,
        scope,
        writeScope,
        policy.budget.candidates,
        policy.budget.notes,
      ]),
    );
    return {
      base,
      blocked: this.dependentBlockInventory(
        configuration,
        base,
        cultivationBudgetStatus(jobs, configuration.settings.cultivation.attention, at),
        at,
      ),
    };
  }

  private dependentBlockInventory(
    configuration: ReturnType<SettingsService["background"]>,
    baseInventory: string,
    budget: ReturnType<typeof cultivationBudgetStatus>,
    at: number,
  ): string {
    const policy = configuration.settings.pipelines.reconsider;
    return contentRevision(
      JSON.stringify([
        baseInventory,
        policy.budget.candidates,
        policy.budget.notes,
        policy.budget.modelCalls,
        policy.budget.tokens,
        Math.floor(at / 86_400_000),
        budget.tokens.remaining,
        budget.modelCalls.remaining,
      ]),
    );
  }

  private retainedRecords(body: string) {
    try {
      return parseAllIntelligenceRecords(body);
    } catch {
      return [];
    }
  }

  private preliminaryAttention(
    path: string,
    modifiedAt: number,
    activePath: string | null,
    savedAt: Map<string, number>,
    priorities: Map<string, number>,
    lastCultivated: Map<string, number>,
    revisitDays: number,
    at: number,
  ): number {
    const saved = savedAt.get(path);
    const last = lastCultivated.get(path);
    return (
      (path === activePath && (last === undefined || modifiedAt > last || saved !== undefined)
        ? 1000
        : 0) +
      (priorities.get(path) ?? 0) * 10 +
      (saved === undefined ? 0 : 200 + Math.max(0, 24 - (at - saved) / 3_600_000)) +
      (last === undefined
        ? 40
        : Math.min(30, Math.max(0, (at - last) / (revisitDays * 86_400_000)) * 5)) +
      (last === undefined ? 0 : Math.min(10, Math.max(0, (at - last) / 86_400_000))) +
      Math.max(0, 7 - Math.max(0, at - modifiedAt) / 86_400_000)
    );
  }
  private report(error: unknown): void {
    process.stderr.write(
      `${JSON.stringify({ type: "pipeline:scheduler_error", message: error instanceof Error ? error.message : String(error) })}\n`,
    );
  }
}
