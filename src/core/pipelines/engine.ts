import type { PipelineId } from "../../api/operations";
import { type PipelinePlan, pipelinePlanSchema } from "../../api/pipelines";
import { reviewArchive } from "./archive";
import { PipelineContext, type PipelineContextOptions } from "./context";
import { enrichNotes } from "./enrich";
import { processInbox } from "./inbox";
import { type IndexExtractDependencies, indexExtract, persistExtractions } from "./indexExtract";
import { relateNotes } from "./relate";
import { synthesizeNotes } from "./synthesize";

/** Finite stage implementations shared by live and scheduled execution. */
export class PipelineEngine {
  constructor(private readonly indexing: IndexExtractDependencies) {}
  async plan(pipeline: PipelineId, options: PipelineContextOptions): Promise<PipelinePlan> {
    const context = new PipelineContext(options);
    await options.stage("read");
    await context.load();
    const plan: PipelinePlan = {
      pipeline,
      summary: "",
      abstained: false,
      reason: null,
      findings: [],
      changes: [],
      relationships: [],
      sources: [],
      extractions: [],
    };
    switch (pipeline) {
      case "index-extract":
        await indexExtract(context, plan, this.indexing);
        break;
      case "enrich":
        await enrichNotes(context, plan);
        break;
      case "relate":
        await relateNotes(context, plan);
        break;
      case "contradictions":
        await relateNotes(context, plan, true);
        break;
      case "synthesize":
        await synthesizeNotes(context, plan);
        break;
      case "inbox":
        await processInbox(context, plan);
        break;
      case "archive":
        await reviewArchive(context, plan);
        break;
    }
    await options.stage("validate");
    options.signal.throwIfAborted();
    plan.sources = context.references();
    plan.abstained =
      plan.findings.length === 0 && plan.changes.length === 0 && plan.relationships.length === 0;
    plan.summary = plan.abstained
      ? (plan.reason ?? "No evidence-backed result was found within this run's bounds.")
      : `${plan.findings.length} supported findings, ${plan.changes.length} proposed note changes, ${plan.relationships.length} relationship suggestions.`;
    if (!plan.abstained) plan.reason = null;
    if (context.retrievalLimitations.size)
      plan.summary += ` Retrieval limits: ${[...context.retrievalLimitations].join(" ")}`;
    return pipelinePlanSchema.parse(plan);
  }
  async persistDerived(
    plan: PipelinePlan,
    options: PipelineContextOptions,
    authorize: () => Promise<void>,
  ): Promise<void> {
    await persistExtractions(plan, new PipelineContext(options), this.indexing, authorize);
  }
}
