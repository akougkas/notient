/** Human CLI for replaying approved link writebacks through the vault daemon. */

import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import type { LinksSyncResult } from "../../daemon/wire";
import type { ClientHandle, ClientOptions, RpcResponseFrame } from "../client";
import { connectClient } from "../client";
import type { Emitter } from "../output";

export interface LinksSyncOptions {
  vaultPath: string;
  emitter: Emitter;
  clientIdentity?: string;
  connect?: (options: ClientOptions) => Promise<ClientHandle>;
}

class LinksSyncCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LinksSyncCommandError";
  }
}

async function requestSync(client: ClientHandle): Promise<LinksSyncResult> {
  for await (const frame of client.call("links.sync", {})) {
    if (frame.type === "error") throw commandErrorFromFrame(frame);
    if (frame.type === "result") return parseResult(frame);
  }
  throw new Error("links.sync returned no result");
}

function commandErrorFromFrame(frame: RpcResponseFrame): LinksSyncCommandError {
  const code = typeof frame.code === "string" ? frame.code : "INTERNAL";
  const message = typeof frame.message === "string" ? frame.message : "unknown daemon error";
  return new LinksSyncCommandError(code, message);
}

function parseResult(frame: RpcResponseFrame): LinksSyncResult {
  if (
    ![frame.replayed, frame.abandoned, frame.failed].every(
      (value) => typeof value === "number" && Number.isInteger(value) && value >= 0,
    )
  ) {
    throw new Error("links.sync returned invalid replay counters");
  }
  return {
    ok: true,
    replayed: frame.replayed as number,
    abandoned: frame.abandoned as number,
    failed: frame.failed as number,
  };
}

function failure(error: unknown): { code: string; message: string; exitCode: number } {
  if (error instanceof LinksSyncCommandError) {
    return {
      code: error.code,
      message: error.message,
      exitCode: error.code === "INVALID_PARAMS" ? 2 : 1,
    };
  }
  return {
    code: "INTERNAL",
    message: error instanceof Error ? error.message : String(error),
    exitCode: 1,
  };
}

export async function runLinksSyncCommand(options: LinksSyncOptions): Promise<number> {
  let client: ClientHandle | undefined;
  try {
    const connector = options.connect ?? connectClient;
    client = await connector({
      socketPath: resolveSocketPath(options.vaultPath, currentPlatform()),
      vaultPath: options.vaultPath,
      ...(options.clientIdentity !== undefined ? { clientIdentity: options.clientIdentity } : {}),
    });
    const result = await requestSync(client);
    options.emitter.emit({
      type: "links:sync",
      replayed: result.replayed,
      abandoned: result.abandoned,
      failed: result.failed,
    });
    return result.failed === 0 ? 0 : 1;
  } catch (error) {
    const detail = failure(error);
    options.emitter.emit({
      type: "error",
      code: detail.code,
      message: `links sync failed: ${detail.message}`,
    });
    return detail.exitCode;
  } finally {
    await client?.close().catch(() => {});
  }
}
