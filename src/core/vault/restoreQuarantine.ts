import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { vaultRestoreQuarantinePath } from "./identity";

const QUARANTINE_RECORD = '{"format":"notient-restore-quarantine","version":1}\n';

/** Arm durable restart protection before a restore can touch SurrealDB. */
export async function armRestoreQuarantine(vaultPath: string): Promise<void> {
  const path = vaultRestoreQuarantinePath(vaultPath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, QUARANTINE_RECORD, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        "an earlier restore remains quarantined; run 'notient nuke --yes' before starting or restoring this vault",
      );
    }
    throw error;
  }
}

/** Refuse daemon boot while an unverified restore generation may exist. */
export async function assertRestoreQuarantineClear(vaultPath: string): Promise<void> {
  const path = vaultRestoreQuarantinePath(vaultPath);
  try {
    await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(
    "notient: restore quarantine is active; run 'notient nuke --yes' before restarting this vault",
  );
}

/** Clear only after a clean restore release, safe rollback, or destructive nuke. */
export async function clearRestoreQuarantine(vaultPath: string): Promise<void> {
  await rm(vaultRestoreQuarantinePath(vaultPath), { force: true });
}
