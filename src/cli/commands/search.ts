import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";
import type { Emitter } from "../output";

export interface SearchCommandOptions {
  vaultPath: string;
  query: string;
  mode: "quick" | "balanced" | "deep";
  limit?: number;
  emitter: Emitter;
}

export async function runSearchCommand(options: SearchCommandOptions): Promise<void> {
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({ socketPath, vaultPath: options.vaultPath });
  const params: Record<string, unknown> = {
    query: options.query,
    mode: options.mode,
  };
  if (options.limit !== undefined) params.limit = options.limit;
  for await (const frame of client.call("search.run", params)) {
    options.emitter.emit({ ...frame, type: `rpc:${frame.type}` });
    if (frame.type === "result" || frame.type === "error") break;
  }
  await client.close();
}
