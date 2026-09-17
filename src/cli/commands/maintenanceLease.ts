import type { MaintenanceOperation } from "../../daemon/maintenance";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import type { ClientHandle, ClientOptions, RpcResponseFrame } from "../client";
import { connectClient } from "../client";

export interface GraphMaintenanceLease {
  readonly client: ClientHandle;
  release(options?: MaintenanceReleaseOptions): Promise<{ vaultChanged: boolean }>;
  poison(): Promise<void>;
}

export interface MaintenanceReleaseOptions {
  /** Rebuild the graph from canonical Markdown after rolling back a restore. */
  rebuildAllMarkdown?: boolean;
}

export interface AcquireGraphMaintenanceOptions {
  vaultPath: string;
  operation: MaintenanceOperation;
  clientIdentity?: string;
  connect?: (options: ClientOptions) => Promise<ClientHandle>;
}

export async function acquireGraphMaintenanceLease(
  options: AcquireGraphMaintenanceOptions,
): Promise<GraphMaintenanceLease> {
  const connector = options.connect ?? connectClient;
  const client = await connector({
    socketPath: resolveSocketPath(options.vaultPath, currentPlatform()),
    vaultPath: options.vaultPath,
    ...(options.clientIdentity === undefined ? {} : { clientIdentity: options.clientIdentity }),
  });
  try {
    await expectMaintenanceResult(client, "maintenance.begin", {
      operation: options.operation,
    });
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }

  let released = false;
  return {
    client,
    release: async (releaseOptions = {}) => {
      if (released) return { vaultChanged: false };
      released = true;
      try {
        const params =
          releaseOptions.rebuildAllMarkdown === true ? { rebuildAllMarkdown: true } : {};
        const result = await expectMaintenanceResult(client, "maintenance.end", params);
        if (typeof result.vaultChanged !== "boolean") {
          throw new Error("maintenance.end returned an invalid vault-change result");
        }
        return { vaultChanged: result.vaultChanged };
      } finally {
        await client.close().catch(() => {});
      }
    },
    poison: async () => {
      if (released) return;
      released = true;
      try {
        await expectMaintenanceResult(client, "maintenance.poison", {});
      } catch (poisonError) {
        try {
          await expectMaintenanceResult(client, "daemon.shutdown", {});
        } catch (shutdownError) {
          throw new Error(
            `maintenance poison failed: ${formatError(poisonError)}; emergency daemon shutdown also failed: ${formatError(shutdownError)}`,
          );
        }
        throw new Error(
          `maintenance poison failed and the daemon was shut down fail-closed: ${formatError(poisonError)}`,
        );
      } finally {
        await client.close().catch(() => {});
      }
    },
  };
}

async function expectMaintenanceResult(
  client: ClientHandle,
  method: "daemon.shutdown" | "maintenance.begin" | "maintenance.end" | "maintenance.poison",
  params: Record<string, unknown>,
): Promise<RpcResponseFrame> {
  for await (const frame of client.call(method, params)) {
    if (frame.type === "ack") continue;
    if (frame.type === "error") throw maintenanceError(frame);
    if (frame.type === "event") throw new Error(`${method} returned an unexpected event`);
    if (frame.ok !== true) throw new Error(`${method} returned an invalid result`);
    return frame;
  }
  throw new Error(`${method} returned no result`);
}

function maintenanceError(frame: RpcResponseFrame): Error {
  const code = typeof frame.code === "string" ? frame.code : "INTERNAL";
  const message = typeof frame.message === "string" ? frame.message : "unknown daemon error";
  return new Error(`${code}: ${message}`);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
