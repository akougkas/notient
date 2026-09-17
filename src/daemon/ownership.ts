import { rm } from "node:fs/promises";
import {
  type LockFs,
  VaultLock,
  type VaultLockHandle,
  createNodeLockFs,
} from "../core/services/vaultLock";
import {
  type PidRecord,
  claimPidFile,
  inspectPidFile,
  isProcessAlive,
  removeOwnedPidFile,
} from "./lifecycle";

export interface AcquireDaemonOwnershipOptions {
  record: PidRecord;
  pidPath: string;
  lockPath: string;
  socketAccepts: () => Promise<boolean>;
  currentPid?: number;
  processAlive?: (pid: number) => boolean;
  lockFs?: LockFs;
}

export interface DaemonOwnership {
  lockHandle: VaultLockHandle;
}

/** Claim the boot record and vault lock before any database work begins. */
export async function acquireDaemonOwnership(
  options: AcquireDaemonOwnershipOptions,
): Promise<DaemonOwnership> {
  const processAlive = options.processAlive ?? isProcessAlive;
  const currentPid = options.currentPid ?? process.pid;
  const snapshot = await inspectPidFile(options.pidPath);
  let staleInstanceId: string | null = null;

  if (snapshot.kind === "record") {
    const owner = snapshot.record;
    if (owner.pid !== currentPid && processAlive(owner.pid)) {
      throw new Error(
        `daemon already owns vault ${owner.vault} (pid ${owner.pid}, instance ${owner.instanceId})`,
      );
    }
    staleInstanceId = owner.instanceId;
  } else if (snapshot.kind === "invalid") {
    throw new Error(`refusing startup with an invalid daemon record: ${snapshot.reason}`);
  }

  if (await options.socketAccepts()) {
    throw new Error(
      `daemon socket is already accepting connections at ${options.record.socketPath}`,
    );
  }

  if (staleInstanceId !== null) {
    await removeOwnedPidFile(options.pidPath, staleInstanceId);
  }

  if (!(await claimPidFile(options.pidPath, options.record))) {
    const winner = await inspectPidFile(options.pidPath);
    const detail =
      winner.kind === "record"
        ? `pid ${winner.record.pid}, instance ${winner.record.instanceId}`
        : winner.kind;
    throw new Error(`daemon startup ownership was claimed concurrently (${detail})`);
  }

  await rm(options.record.socketPath, { force: true });
  const lock = new VaultLock(
    options.lockFs ?? createNodeLockFs(),
    options.lockPath,
    options.record.instanceId,
  );
  try {
    return { lockHandle: await lock.acquire() };
  } catch (error) {
    await removeOwnedPidFile(options.pidPath, options.record.instanceId).catch(() => {});
    throw error;
  }
}
