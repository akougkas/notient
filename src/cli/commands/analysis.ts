import type { ComparisonResult } from "../../api/comparison";
import { operationInputs, scopeSchema } from "../../api/operations";
import { notePathSchema } from "../../api/schema";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";
import type { Emitter } from "../output";
import { callApi } from "./api";

export interface AnalyzePathsOptions {
  vaultPath: string;
  paths: string[];
  kind: "compare" | "correlate";
  question?: string;
  folder?: string;
  clientIdentity?: string;
  signal?: AbortSignal;
}
/** Resolve exactly the operator-selected paths to current revisions, then let
 * the shared domain authority validate those revisions through inference. */
export async function analyzePaths(options: AnalyzePathsOptions): Promise<ComparisonResult> {
  if (
    options.kind === "compare"
      ? options.paths.length < 2 || options.paths.length > 8
      : options.paths.length !== 1
  )
    throw new Error(
      options.kind === "compare"
        ? "Choose 2–8 notes to compare."
        : "Choose one note to find connections.",
    );
  const paths = options.paths.map((path) => notePathSchema.parse(path));
  if (new Set(paths).size !== paths.length) throw new Error("Choose distinct note paths.");
  if (options.kind === "compare" && options.folder)
    throw new Error("A folder scope applies to correlation, not an explicit comparison.");
  if (options.kind === "correlate" && options.question)
    throw new Error("A question applies to an explicit comparison.");
  const scope = scopeSchema.parse(options.folder ? { folders: [options.folder] } : {});
  const client = await connectClient({
    vaultPath: options.vaultPath,
    socketPath: resolveSocketPath(options.vaultPath, currentPlatform()),
    clientIdentity: options.clientIdentity,
    signal: options.signal,
  });
  try {
    const sources = [];
    for (const path of paths) sources.push((await callApi(client, "notes.read", { path })).note);
    return options.kind === "compare"
      ? await callApi(
          client,
          "notes.compare",
          operationInputs["notes.compare"].parse({ sources, question: options.question }),
        )
      : await callApi(client, "notes.correlate", { source: sources[0], scope, limit: 6 });
  } finally {
    await client.close();
  }
}
export async function runAnalysisCommand(
  options: AnalyzePathsOptions & { emitter: Emitter },
): Promise<number> {
  const result = await analyzePaths(options);
  options.emitter.emit({ type: "analysis:done", ...result });
  return 0;
}
