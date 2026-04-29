/**
 * Per-vault SurrealDB client helper for the awaken CLI control plane.
 *
 * Spec: Phase 4 plan §Task 9. Reads the daemon's port file
 * (`~/.notient/<vault-id>/surreal.port`) and the matching secret
 * (`secret.key`), then opens a SurrealDB websocket session against
 * `notient/vault`. The four awaken control commands (--pause, --resume,
 * --cancel, --status) share this helper so they remain thin clients over
 * the Task 7 DAL.
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
  const port = Number(portText.trim());
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(
      `daemon is not running (no port file at ${portFile}). Run 'notient daemon start' first.`,
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
