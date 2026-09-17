import { z } from "zod";
import type { BriefResult } from "../../../api/brief";
import type { ComparisonResult } from "../../../api/comparison";
import { operationInputs, scopeSchema } from "../../../api/operations";
import type { NoteAnalysis } from "../../analysis/noteAnalysis";
import type { ToolDefinition, ToolJsonSchema } from "./registry";

export function makeAnalysisTools(
  analysis: Pick<NoteAnalysis, "compare" | "correlate" | "brief">,
): ToolDefinition<unknown, ComparisonResult | BriefResult>[] {
  return (["compare", "correlate", "brief"] as const).map((kind) => ({
    name: kind === "brief" ? "brief.run" : `notes.${kind}`,
    description:
      kind === "brief"
        ? "Produce a concise overview of a topic or saved source revision from at most eight current notes. Every claim, decision, question or tension has exact evidence. Reports incomplete coverage and abstention. Bounded read-only inference; no effects or permissions."
        : kind === "compare"
          ? "Compare 2–8 exact note revisions with quotations from both sides. Distinguishes contradiction from changed assumptions or time. Optional question focuses the analysis. Read-only; creates no proposals or permissions."
          : "Find substantive connections to an exact note revision within a bounded read scope. Inspects at most seven candidate notes and reports incomplete coverage, limits and abstention. Uses reasoning; read-only, with no jobs or file effects.",
    schema: z.toJSONSchema(
      operationInputs[kind === "brief" ? "brief.run" : (`notes.${kind}` as const)],
    ) as ToolJsonSchema,
    validate: (raw) =>
      operationInputs[kind === "brief" ? "brief.run" : (`notes.${kind}` as const)].parse(raw),
    invoke: (args, signal, caller) =>
      analysis[kind](
        args,
        signal,
        caller.noteScope ? scopeSchema.parse(caller.noteScope) : undefined,
      ),
    writeGated: false,
  }));
}
