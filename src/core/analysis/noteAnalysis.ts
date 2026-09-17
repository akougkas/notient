import type { VaultAdapter } from "../../adapters/vaultAdapter";
import { defaultPipelinePolicy } from "../../api/background";
import { briefResultSchema } from "../../api/brief";
import { comparisonResultSchema } from "../../api/comparison";
import { type IndexingReadiness, searchCoverage } from "../../api/indexing";
import { NoteReadService } from "../../api/notes";
import {
  type OperationInput,
  type PipelinePolicy,
  operationInputs,
  scopeSchema,
} from "../../api/operations";
import { NoteApiError, type NoteReference } from "../../api/schema";
import { type NoteScope, scopeAllows } from "../../api/scope";
import type { ReasoningScheduler } from "../coordinator/reasoningScheduler";
import { InferenceBudget } from "../llm/executionBudget";
import type { LLMProvider } from "../llm/provider";
import { PipelineContext } from "../pipelines/context";
import { analyzeRelationships } from "../pipelines/relate";
import type { SearchPipeline } from "../search/searchPipeline";
import { composeBrief } from "./brief";

export interface NoteAnalysisOptions {
  vault: VaultAdapter;
  search: SearchPipeline;
  provider: LLMProvider;
  scheduler: ReasoningScheduler;
  settings: () => { model: string; contextTokens: number };
  indexing: () => IndexingReadiness;
}

/** Explicit read-only analysis reuses pipeline evidence, prompts and judgments.
 * It does not create jobs, approve relationships or mutate a note. */
export class NoteAnalysis {
  constructor(private readonly options: NoteAnalysisOptions) {}
  compare(input: unknown, signal?: AbortSignal, trustedScope?: NoteScope) {
    const args = parse("notes.compare", input);
    if (new Set(args.sources.map((source) => source.path)).size !== args.sources.length)
      throw new NoteApiError("INVALID_PARAMS", "choose different notes for a comparison");
    return this.run(args.sources, null, args.question, signal, trustedScope);
  }
  correlate(input: unknown, signal?: AbortSignal, trustedScope?: NoteScope) {
    const args = parse("notes.correlate", input);
    return this.run([args.source], args, undefined, signal, trustedScope);
  }
  async brief(input: unknown, signal?: AbortSignal, trustedScope?: NoteScope) {
    const parsed = operationInputs["brief.run"].safeParse(input);
    if (!parsed.success) throw new NoteApiError("INVALID_PARAMS", parsed.error.message);
    const args = parsed.data;
    let topic = args.query ?? args.source?.path ?? "";
    const { value, ...execution } = await this.execute(
      args.source ? [args.source] : [],
      args.scope,
      args.limit,
      signal,
      trustedScope,
      async (context) => {
        if (args.source) {
          topic = context.selected[0].structure.headings[0]?.text ?? args.source.path;
          const focus = args.focus ? context.anchor(args.source.path, args.focus) : undefined;
          if (focus) topic = `${topic}: ${focus.replace(/\s+/g, " ").trim().slice(0, 300)}`;
          await context.retrieve(context.selected, args.limit - 1, focus);
        } else await context.collect(topic);
        return composeBrief(context, topic);
      },
    );
    return briefResultSchema.parse({ ok: true, topic, ...value, ...execution });
  }
  private async run(
    sources: NoteReference[],
    correlation: OperationInput<"notes.correlate"> | null,
    question: string | undefined,
    signal?: AbortSignal,
    trustedScope?: NoteScope,
  ) {
    const { value: report, ...execution } = await this.execute(
      sources,
      scopeSchema.parse(correlation?.scope ?? { paths: sources.map((source) => source.path) }),
      correlation ? Math.min(8, correlation.limit + 1) : sources.length,
      signal,
      trustedScope,
      async (context) => {
        if (question) await context.focus(question);
        // A host selection is the question. Its text comes from the saved bytes.
        const focus = correlation?.focus
          ? context.anchor(correlation.source.path, correlation.focus)
          : undefined;
        if (correlation)
          await context.retrieve(context.selected, Math.min(7, correlation.limit), focus);
        return analyzeRelationships(context, {
          question: question ?? focus?.replace(/\s+/g, " ").trim().slice(0, 2000),
        });
      },
    );
    const abstained = !report.comparisons.some(
      (item) => !["unrelated", "insufficient"].includes(item.judgment),
    );
    return comparisonResultSchema.parse({
      ok: true,
      ...execution,
      comparisons: report.comparisons,
      abstained,
      reason: abstained ? report.reason : null,
      coverage: correlation ? execution.coverage : null,
    });
  }
  private async execute<T>(
    sources: NoteReference[],
    readScope: NoteScope,
    notes: number,
    signal: AbortSignal | undefined,
    trustedScope: NoteScope | undefined,
    task: (context: PipelineContext) => Promise<T>,
  ) {
    const started = performance.now();
    const budget = new InferenceBudget(
      { modelCalls: 2, tokens: 120000, durationMs: 180000, generationTokens: 16384 },
      [],
      undefined,
      signal,
    );
    const before = this.options.indexing();
    return this.options.scheduler.run(
      "notes.analysis",
      (scheduledSignal) =>
        budget.run(async () => {
          const linked = AbortSignal.any([budget.signal, scheduledSignal]);
          linked.throwIfAborted();
          const runtime = this.options.settings();
          const policy: PipelinePolicy = defaultPipelinePolicy("relate");
          policy.mode = "report";
          policy.effects = [];
          policy.budget = {
            ...policy.budget,
            notes,
            candidates: 40,
            modelCalls: 2,
            tokens: 120000,
            durationMs: 180000,
            generationTokens: 16384,
            retries: 1,
          };
          policy.readScope = readScope;
          const context = new PipelineContext({
            vault: this.options.vault,
            search: this.options.search,
            provider: this.options.provider,
            model: runtime.model,
            modelContextTokens: runtime.contextTokens,
            policy,
            sources,
            signal: linked,
            authorizeRead: (note) => {
              if (trustedScope && !scopeAllows(trustedScope, note.note.path, note.structure.tags))
                throw new NoteApiError("FORBIDDEN", "note lies outside the caller’s read scope");
            },
            stage: async () => {
              linked.throwIfAborted();
              budget.assertAvailable();
            },
          });
          await context.load();
          const value = await task(context);
          budget.assertAvailable();
          // Cached index receipts do not prove that evidence stayed current while
          // the model reasoned. Re-read every inspected source before returning.
          const reader = new NoteReadService(this.options.vault);
          for (const source of context.references()) {
            linked.throwIfAborted();
            await reader.read(source);
          }
          await budget.flush();
          budget.assertAvailable();
          return {
            value,
            sources: context.references(),
            coverage: searchCoverage(before, this.options.indexing()),
            limitations: context.contextLimitations(),
            attempts: budget.attempts,
            durationMs: Math.round(performance.now() - started),
          };
        }),
      { signal: budget.signal },
    );
  }
}
function parse<M extends "notes.compare" | "notes.correlate">(
  method: M,
  input: unknown,
): OperationInput<M> {
  const result = operationInputs[method].safeParse(input);
  if (!result.success) throw new NoteApiError("INVALID_PARAMS", result.error.message);
  return result.data as OperationInput<M>;
}
