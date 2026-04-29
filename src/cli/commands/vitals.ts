import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";
import type { Emitter } from "../output";

export interface VitalsCommandOptions {
  vaultPath: string;
  notePath: string;
  emitter: Emitter;
  clientIdentity?: string;
}

export async function runVitalsCommand(options: VitalsCommandOptions): Promise<void> {
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({
    socketPath,
    vaultPath: options.vaultPath,
    clientIdentity: options.clientIdentity,
  });
  for await (const frame of client.call("vitals.get", { path: options.notePath })) {
    options.emitter.emit({ ...frame, type: `rpc:${frame.type}` });
    if (frame.type === "result" || frame.type === "error") break;
  }
  await client.close();
}
