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
import { createCultivationDigest } from "./digest";

export interface CultivationServiceOptions {
  vault: VaultAdapter;
  jobs: JobService;
  settings: SettingsService;
  activity: Pick<SentienceActivity, "snapshot">;
  now: () => number;
}

export class CultivationService {
  constructor(private readonly options: CultivationServiceOptions) {}

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
    return cultivationDigestSchema.parse({
      ok: true,
      generatedAt: at,
      paused: configuration.paused,
      items,
      budget: cultivationBudgetStatus(jobs, attention, at),
      methodology: configuration.cultivation.methodology,
    });
  }
}

function pipelineScopes(settings: BackgroundSettings): Record<PipelineJob["pipeline"], PipelinePolicy["readScope"]> {
  return Object.fromEntries(
    Object.entries(settings.pipelines).map(([pipeline, policy]) => [pipeline, policy.readScope]),
  ) as Record<PipelineJob["pipeline"], PipelinePolicy["readScope"]>;
}
