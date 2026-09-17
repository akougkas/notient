import { briefResultFor } from "../../api/brief";
import { operationInputs, scopeSchema } from "../../api/operations";
import { notePathSchema } from "../../api/schema";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";
import type { Emitter } from "../output";
import { callApi } from "./api";

export interface BriefCommandOptions {
  vaultPath: string;
  topic?: string;
  filePath?: string;
  maxNotes?: number;
  folder?: string;
  signal?: AbortSignal;
  clientIdentity?: string;
}
export function parseBriefMaxField(value: unknown, name = "max-notes"): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "string" && /^[1-8]$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed))
    throw new Error(`INVALID_PARAMS: --${name} must be between 1 and 8`);
  return parsed;
}
export async function briefNotes(options: BriefCommandOptions) {
  if ((options.topic === undefined) === (options.filePath === undefined))
    throw new Error("INVALID_PARAMS: brief requires exactly one topic or --file");
  const scope = scopeSchema.parse(options.folder ? { folders: [options.folder] } : {});
  const path = options.filePath === undefined ? undefined : notePathSchema.parse(options.filePath);
  const limit = operationInputs["brief.run"].shape.limit.parse(options.maxNotes);
  const query = operationInputs["brief.run"].shape.query.parse(options.topic);
  const client = await connectClient({
    vaultPath: options.vaultPath,
    socketPath: resolveSocketPath(options.vaultPath, currentPlatform()),
    clientIdentity: options.clientIdentity,
    signal: options.signal,
  });
  try {
    const source = path ? (await callApi(client, "notes.read", { path })).note : undefined;
    const input = { query, source, scope, limit };
    return briefResultFor(input).parse(await callApi(client, "brief.run", input));
  } finally {
    await client.close();
  }
}
export async function runBriefCommand(
  options: BriefCommandOptions & { emitter: Emitter },
): Promise<number> {
  options.emitter.emit({ type: "brief:done", ...(await briefNotes(options)) });
  return 0;
}
