/**
 * `notient links sync` CLI verb.
 *
 * Spec: docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md §11.1.
 *
 * Replays any linker writebacks the daemon left in the pending state
 * (`approved = true AND applied = false`). Mirrors the daemon's
 * boot-time call to `ApprovalService.reconcilePendingApplications`.
 *
 * Construction strategy: short-lived SurrealDB connection plus an
 * inline `ApprovalService` instance. The CLI never wires the kernel,
 * so the constructor receives a no-op `EventBus` and a node-fs-backed
 * `AtomicFs`. The reconcile path is idempotent (Locked Decision 2 in
 * `writeback.ts`), so racing the daemon is safe.
 */

import { rename, unlink, writeFile } from "node:fs/promises";
import type { Surreal } from "surrealdb";
import { ApprovalService } from "../../core/approvals/approvalService";
import { EventBus } from "../../core/events/eventBus";
import type { AtomicFs } from "../../core/utils/atomicWrite";
import type { Emitter } from "../output";
import { connectVaultSurreal } from "./awakenSurrealClient";

export interface LinksSyncOptions {
  vaultPath: string;
  vaultRoot: string;
  emitter: Emitter;
  clientIdentity?: string;
}

const cliFs: AtomicFs = {
  writeBinary: async (path: string, data: ArrayBuffer): Promise<void> => {
    await writeFile(path, new Uint8Array(data));
  },
  rename: async (from: string, to: string): Promise<void> => {
    await rename(from, to);
  },
  remove: async (path: string): Promise<void> => {
    await unlink(path).catch(() => {
      // missing-file is not an error for cleanup
    });
  },
};

async function readFileText(path: string): Promise<string> {
  return await Bun.file(path).text();
}

export async function runLinksSyncCommand(options: LinksSyncOptions): Promise<number> {
  let connection: { db: Surreal; close: () => Promise<void> } | undefined;
  try {
    const opened = await connectVaultSurreal(options.vaultPath);
    connection = opened;
    const service = new ApprovalService({
      db: opened.db,
      bus: new EventBus(),
      vaultRoot: options.vaultRoot,
      fs: cliFs,
      readFile: readFileText,
    });
    const result = await service.reconcilePendingApplications();
    options.emitter.emit({
      type: "links:sync",
      replayed: result.replayed,
      failed: result.failed,
    });
    return 0;
  } catch (error) {
    options.emitter.emit({
      type: "error",
      code: "INTERNAL",
      message: `links sync failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  } finally {
    if (connection !== undefined) {
      await connection.close().catch(() => {});
    }
  }
}
