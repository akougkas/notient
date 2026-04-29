import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";
import type { Emitter } from "../output";

export interface AwakenCommandOptions {
  vaultPath: string;
  batch?: number;
  since?: number;
  emitter: Emitter;
  clientIdentity?: string;
}

export async function runAwakenCommand(options: AwakenCommandOptions): Promise<void> {
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({
    socketPath,
    vaultPath: options.vaultPath,
    clientIdentity: options.clientIdentity,
  });
  const params: Record<string, unknown> = {};
  if (options.batch !== undefined) params.batch = options.batch;
  if (options.since !== undefined) params.since = options.since;
  for await (const frame of client.call("awaken.run", params)) {
    options.emitter.emit({ ...frame, type: `rpc:${frame.type}` });
    if (frame.type === "result" || frame.type === "error") break;
  }
  await client.close();
}
