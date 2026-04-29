import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";
import type { Emitter } from "../output";

export interface ReindexCommandOptions {
  vaultPath: string;
  pattern: string;
  emitter: Emitter;
  clientIdentity?: string;
}

export async function runReindexCommand(options: ReindexCommandOptions): Promise<void> {
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({
    socketPath,
    vaultPath: options.vaultPath,
    clientIdentity: options.clientIdentity,
  });
  for await (const frame of client.call("reindex.glob", { pattern: options.pattern })) {
    options.emitter.emit({ ...frame, type: `rpc:${frame.type}` });
    if (frame.type === "result" || frame.type === "error") break;
  }
  await client.close();
}
