/**
 * `notient backup` CLI verb.
 *
 * Spec: Phase 5 plan §Task 10. Spawns `surreal export` against the
 * running per-vault daemon and writes the SurrealQL dump to a file. The
 * daemon must be up; the verb is a thin wrapper over the binary and
 * propagates the spawn's exit code verbatim.
 *
 * Default `--out` path is
 * `~/.notient/<vault-id>/backups/<ISO-timestamp>.surql`. Operators who
 * pass `--out` get the literal path written.
 */

import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { join } from "node:path";
import { vaultPortPath, vaultSecretPath, vaultStateDir } from "../../core/vault/identity";
import { readOrGenerateSecret } from "../../core/vault/secret";
import type { Emitter } from "../output";

export interface BackupOptions {
  vaultPath: string;
  outPath?: string;
  emitter: Emitter;
  clientIdentity?: string;
}

/**
 * Returns an ISO-8601 timestamp safe for filesystem paths. The colons in
 * the standard form break Windows path semantics and confuse shell tab
 * completion on POSIX, so they collapse to dashes.
 */
function timestampFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function runBackupCommand(options: BackupOptions): Promise<number> {
  const portFile = vaultPortPath(options.vaultPath);
  let portText: string;
  try {
    portText = await readFile(portFile, "utf8");
  } catch {
    options.emitter.emit({
      type: "error",
      code: "DAEMON_DOWN",
      message: `daemon is not running (no port file at ${portFile}). Run 'notient daemon start' first.`,
    });
    return 1;
  }
  const port = Number(portText.trim());
  if (!Number.isFinite(port) || port <= 0) {
    options.emitter.emit({
      type: "error",
      code: "DAEMON_DOWN",
      message: `daemon is not running (no port file at ${portFile}). Run 'notient daemon start' first.`,
    });
    return 1;
  }
  const secret = await readOrGenerateSecret(vaultSecretPath(options.vaultPath));

  const outPath =
    options.outPath ??
    join(vaultStateDir(options.vaultPath), "backups", `${timestampFilename()}.surql`);
  await mkdir(dirname(outPath), { recursive: true, mode: 0o700 });

  // `surreal export` shells out to the HTTP transport, not the WebSocket
  // RPC endpoint; the same `surreal start` process accepts both on the
  // bound port. The daemon's port file records the port without scheme
  // so we reuse it verbatim.
  const child = Bun.spawn(
    [
      "surreal",
      "export",
      "--endpoint",
      `http://127.0.0.1:${port}`,
      "--username",
      "root",
      "--password",
      secret,
      "--namespace",
      "notient",
      "--database",
      "vault",
      outPath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const stderrText = await new Response(child.stderr).text();
  const exitCode = (await child.exited) ?? 0;

  if (exitCode !== 0) {
    options.emitter.emit({
      type: "error",
      code: "BACKUP_FAILED",
      message:
        stderrText.trim().length > 0 ? stderrText.trim() : `surreal export exited ${exitCode}`,
    });
    return exitCode;
  }

  options.emitter.emit({ type: "backup-success", path: outPath });
  return 0;
}
