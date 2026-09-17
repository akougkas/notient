/**
 * Per-vault SurrealDB client for direct operator graph inspection.
 *
 * Reads the daemon's port file and matching secret, then opens a SurrealDB
 * WebSocket session against `notient/vault`. Graph audit, dump, and stats
 * commands share this helper.
 *
 * Failure model: a missing or empty port file means the daemon is not
 * running. Callers surface a stderr message and exit 1; nothing about the
 * awaken control plane should crash the process when the daemon is down.
 */

import { readFile } from "node:fs/promises";
import { connect } from "../../core/db/surreal";
import type { SurrealConnection } from "../../core/db/surreal";
import { vaultPortPath, vaultSecretPath } from "../../core/vault/identity";
import { readOrGenerateSecret } from "../../core/vault/secret";
import { parseDaemonPortFile } from "./surrealCli";

export async function connectVaultSurreal(vaultPath: string): Promise<SurrealConnection> {
  const portFile = vaultPortPath(vaultPath);
  let portText: string;
  try {
    portText = await readFile(portFile, "utf8");
  } catch {
    throw new Error(
      `daemon is not running (no port file at ${portFile}). Run 'notient daemon start' first.`,
    );
  }
  let port: number;
  try {
    port = parseDaemonPortFile(portText);
  } catch {
    throw new Error(
      `daemon is not running (invalid port file at ${portFile}). Run 'notient daemon start' first.`,
    );
  }
  const secret = await readOrGenerateSecret(vaultSecretPath(vaultPath));
  return await connect({
    url: `ws://127.0.0.1:${port}/rpc`,
    user: "root",
    pass: secret,
    namespace: "notient",
    database: "vault",
  });
}
