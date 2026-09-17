import type { Surreal } from "surrealdb";
import type { VaultAdapter } from "../adapters/vaultAdapter";
import type { ApprovalService } from "../core/approvals/approvalService";
import { Coordinator } from "../core/coordinator/coordinator";
import type { ReasoningScheduler } from "../core/coordinator/reasoningScheduler";
import type { EventBus } from "../core/events/eventBus";
import { ChangeService } from "../core/history/changeService";
import type { DurableNoteWriter } from "../core/history/durableNoteWriter";
import type { Embedder } from "../core/indexer/embedder";
import type { Extractor } from "../core/indexer/extractor";
import type { LLMProvider } from "../core/llm/provider";
import { assertPipelinePolicy, enforceEffectPolicy } from "../core/pipelines/effectPolicy";
import { PipelineEngine } from "../core/pipelines/engine";
import { JobService } from "../core/pipelines/jobService";
import type { JobServiceOptions } from "../core/pipelines/jobService";
import { JobStore } from "../core/pipelines/jobStore";
import type { SearchPipeline } from "../core/search/searchPipeline";
import type { SentienceActivity } from "../core/services/sentienceActivity";
import type { SettingsService } from "../core/settings/settingsService";

export function makePipelineServices(options: {
  db: Surreal;
  vault: VaultAdapter;
  settings: SettingsService;
  bus: EventBus;
  writer: DurableNoteWriter;
  approvals: ApprovalService;
  embedder: Embedder;
  extractor: Extractor;
  scheduler: ReasoningScheduler;
  search: SearchPipeline;
  provider: LLMProvider;
  activity: SentienceActivity;
  authorizeCaller?: JobServiceOptions["authorizeCaller"];
}) {
  const { db, vault, settings, bus } = options;
  const changes = new ChangeService({
    db,
    vault,
    writer: options.writer,
    approvalService: options.approvals,
    authorizeCaller: options.authorizeCaller,
    authorizeRecoveredJob: async (job, preview, effect) => {
      await settings.refreshBackground();
      assertPipelinePolicy(job, settings.background().settings);
      enforceEffectPolicy(job, preview, effect);
    },
  });
  const engine = new PipelineEngine({
    db,
    bus,
    embedder: options.embedder,
    extractor: options.extractor,
    chunkSizes: settings.get().indexer.chunk,
    embeddingConfigured: () => settings.get().embedding.model !== "",
  });
  const jobs = new JobService({
    store: new JobStore(db),
    settings,
    engine,
    scheduler: options.scheduler,
    vault,
    search: options.search,
    provider: options.provider,
    authorizeCaller: options.authorizeCaller,
    stage: (job, plan, signal) => options.approvals.stagePipelinePlan(job, plan, changes, signal),
    apply: async (job, signal, authorize) => {
      const id = job.proposalIds[0];
      if (!id || !job.previewId || !job.previewRevision) return null;
      return options.approvals.applyReview(
        {
          id,
          previewId: job.previewId,
          previewRevision: job.previewRevision,
          idempotencyKey: `job-${job.id}`,
        },
        {
          id: job.caller.id,
          kind: "agent",
          scopes: job.caller.scopes.filter((scope) => scope === "read" || scope === "write"),
        },
        changes,
        signal,
        async (preview, effect) => {
          await authorize();
          enforceEffectPolicy(job, preview, effect);
        },
      );
    },
    changed: (job) =>
      bus.emit({
        type: "job:changed",
        jobId: job.id,
        pipeline: job.pipeline,
        state: job.state,
        revision: job.revision,
        stage: job.stage,
      }),
  });
  const coordinator = new Coordinator({ bus, jobs, settings, vault, activity: options.activity });
  return { changes, jobs, coordinator };
}
