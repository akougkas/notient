import type { VaultAdapter } from "../../adapters/vaultAdapter";
import { cultivationDigestSchema } from "../../api/cultivation";
import type { OperationInput, PipelinePolicy } from "../../api/operations";
import type { PipelineJob } from "../../api/pipelines";
import { scopeSchema } from "../../api/operations";
import type { BackgroundSettings } from "../../api/background";
import type { SentienceActivity } from "../services/sentienceActivity";
import type { JobService } from "../pipelines/jobService";
import type { SettingsService } from "../settings/settingsService";
import { cultivationBudgetStatus } from "./budget";
import { createCultivationDigest, createQuietResults } from "./digest";
import type { CultivationCondition } from "../../api/cultivation";
import type { PipelineScheduleStatus } from "../coordinator/coordinator";

export interface CultivationServiceOptions {
  vault: VaultAdapter;
  jobs: JobService;
  settings: SettingsService;
  activity: Pick<SentienceActivity, "snapshot">;
  now: () => number;
  schedule?: (pipeline: PipelineJob["pipeline"]) => PipelineScheduleStatus;
}

export class CultivationService {
  constructor(private readonly options: CultivationServiceOptions) {}

  private conditions(
    configuration: BackgroundSettings,
    jobs: readonly PipelineJob[],
    budget: ReturnType<typeof cultivationBudgetStatus>,
    now: number,
  ) {
    return conditionsFor(configuration, jobs, budget, now, this.options.schedule);
  }

  async digest(input: Pick<OperationInput<"cultivation.digest">, "limit" | "scope"> = {}) {
    const at = this.options.now();
    const configuration = this.options.settings.background().settings;
    const jobs = await this.options.jobs.options.store.list(10000);
    const attention = configuration.cultivation.attention;
    const limit = input.limit ?? attention.digestItems;
    const items = await createCultivationDigest({
      vault: this.options.vault,
      jobs,
      currentScopes: pipelineScopes(configuration),
      requestedScope: scopeSchema.parse(input.scope ?? {}),
      activeNotePath: this.options.activity.snapshot().activeNotePath,
      now: at,
      limit,
    });
    const budget = cultivationBudgetStatus(jobs, attention, at);
    const currentScopes = pipelineScopes(configuration);
    const quiet = createQuietResults({
      jobs,
      currentScopes,
      requestedScope: scopeSchema.parse(input.scope ?? {}),
      now: at,
      limit: 5,
    });
    return cultivationDigestSchema.parse({
      ok: true,
      generatedAt: at,
      paused: configuration.paused,
      items,
      quiet,
      conditions: this.conditions(configuration, jobs, budget, at),
      budget,
      methodology: configuration.cultivation.methodology,
    });
  }
}

const WAITING_REASONS = [
  "Waiting for the configured cooldown.",
  "Outside the configured operating window.",
  "An earlier background run is still pending.",
];

function conditionsFor(
  configuration: BackgroundSettings,
  jobs: readonly PipelineJob[],
  budget: ReturnType<typeof cultivationBudgetStatus>,
  now: number,
  schedule: CultivationServiceOptions["schedule"],
): CultivationCondition[] {
  const conditions: CultivationCondition[] = [];
  const active = Object.entries(configuration.pipelines).filter(
    ([, policy]) => policy.enabled && policy.triggers.length > 0,
  ) as Array<[PipelineJob["pipeline"], PipelinePolicy]>;
  if (configuration.paused)
    conditions.push({
      id: "paused",
      level: "attention",
      label: "Cultivation is paused",
      detail: "Saved notes and clips are not being studied in the background.",
      action: "Choose a scope and resume in cultivation settings.",
    });
  else if (active.length === 0)
    conditions.push({
      id: "no-trigger",
      level: "attention",
      label: "No pipeline will react to a saved note",
      detail:
        "Every pipeline is disabled or has no trigger, so a new capture or clip creates no cultivation job.",
      action: "Enable one pipeline with a save trigger and a narrow read scope.",
    });
  else {
    const reactsToSave = active.filter(([, policy]) => policy.triggers.includes("save"));
    if (reactsToSave.length === 0)
      conditions.push({
        id: "no-save-trigger",
        level: "info",
        label: "Saved notes wait for idle or interval runs",
        detail: "No enabled pipeline has a save trigger, so a fresh capture is studied only on a later idle or interval run.",
        action: null,
      });
    for (const [pipeline, policy] of active) {
      if (pipeline === "index-extract" || pipeline === "reconsider") continue;
      const unscoped =
        !policy.readScope.paths.length &&
        !policy.readScope.folders.length &&
        !policy.readScope.tags.length;
      if (unscoped)
        conditions.push({
          id: `unscoped-${pipeline}`,
          level: "attention",
          label: `${pipeline} may read the whole vault`,
          detail: "Its read scope has no path, folder or tag limit.",
          action: "Restrict its read scope before letting it run unattended.",
        });
      if (policy.mode === "report")
        conditions.push({
          id: `report-only-${pipeline}`,
          level: "info",
          label: `${pipeline} is in report mode`,
          detail: "Its findings stay reports and produce no review or note change.",
          action: "Choose review mode to let it propose changes on notes.",
        });
      const status = schedule?.(pipeline);
      if (status && WAITING_REASONS.includes(status.reason))
        conditions.push({
          id: `waiting-${pipeline}`,
          level: "info",
          label: `${pipeline} is holding work`,
          detail: status.nextRun
            ? `${status.reason} Next opportunity ${new Date(status.nextRun).toISOString()}.`
            : status.reason,
          action: null,
        });
    }
  }
  const pending = jobs.filter((job) => job.state === "awaiting-approval").length;
  if (pending > 0)
    conditions.push({
      id: "pending-review",
      level: "attention",
      label: `${pending} proposed change${pending === 1 ? "" : "s"} awaiting review`,
      detail: "Cultivation will not write these until you approve them.",
      action: "Open the review inbox.",
    });
  const failed = jobs.filter(
    (job) => job.background && job.state === "failed" && now - job.updatedAt < 86_400_000,
  ).length;
  if (failed > 0)
    conditions.push({
      id: "failed-runs",
      level: "attention",
      label: `${failed} background run${failed === 1 ? "" : "s"} failed today`,
      detail: "Failures are listed with their reason under quiet results.",
      action: null,
    });
  if (budget.tokens.remaining === 0 || budget.modelCalls.remaining === 0)
    conditions.push({
      id: "budget",
      level: "attention",
      label: "Today's cultivation budget is used",
      detail: "No further model-assisted background work will start until the UTC day rolls over.",
      action: "Raise the daily budget in cultivation settings if this is intended.",
    });
  return conditions.slice(0, 20);
}

function pipelineScopes(settings: BackgroundSettings): Record<PipelineJob["pipeline"], PipelinePolicy["readScope"]> {
  return Object.fromEntries(
    Object.entries(settings.pipelines).map(([pipeline, policy]) => [pipeline, policy.readScope]),
  ) as Record<PipelineJob["pipeline"], PipelinePolicy["readScope"]>;
}
