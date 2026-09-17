import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { normalizeVaultPath } from "./paths";

const ID_LENGTH = 16;

/**
 * Derive a stable 16-character lowercase hex identifier for a vault from its
 * filesystem path. Uses `normalizeVaultPath` so relative paths resolve against
 * the current working directory and Windows drive paths collapse onto their WSL
 * mount, giving one id per vault regardless of how the operator spelled it.
 * Symlinks are intentionally not resolved so that different absolute paths map
 * to different ids even if they point at the same underlying inode.
 */
export function vaultId(input: string): string {
  const absolute = normalizeVaultPath(input);
  return createHash("sha256").update(absolute).digest("hex").slice(0, ID_LENGTH);
}

/**
 * Per-vault state directory: `~/.notient/<vault-id>/`.
 */
export function vaultStateDir(input: string): string {
  return path.join(homedir(), ".notient", vaultId(input));
}

/**
 * Per-vault data directory: `~/.notient/<vault-id>/data/`.
 */
export function vaultDataDir(input: string): string {
  return path.join(vaultStateDir(input), "data");
}

/**
 * Per-vault secret key file: `~/.notient/<vault-id>/secret.key`.
 */
export function vaultSecretPath(input: string): string {
  return path.join(vaultStateDir(input), "secret.key");
}

/**
 * Per-vault daemon admin token: `~/.notient/<vault-id>/admin.token`.
 *
 * The daemon regenerates the token at every boot and writes it with mode
 * 0600. The reserved `human` hello must carry this exact token. Named agents
 * instead carry an HMAC-SHA256 credential derived from the token and their
 * exact canonical id; missing or invalid credentials authenticate nobody.
 * The file lives beside the other per-vault state so the operating-system
 * account remains the local trust boundary.
 */
export function vaultAdminTokenPath(input: string): string {
  return path.join(vaultStateDir(input), "admin.token");
}

/**
 * Per-vault SurrealDB port file: `~/.notient/<vault-id>/surreal.port`.
 */
export function vaultPortPath(input: string): string {
  return path.join(vaultStateDir(input), "surreal.port");
}

/**
 * Per-vault SurrealDB pid file: `~/.notient/<vault-id>/surreal.pid`.
 */
export function vaultPidPath(input: string): string {
  return path.join(vaultStateDir(input), "surreal.pid");
}

/**
 * Durable fail-closed marker for a restore generation that has not yet been
 * verified or safely rolled back. Only `notient nuke` may clear it after
 * removing the corresponding database directory.
 */
export function vaultRestoreQuarantinePath(input: string): string {
  return path.join(vaultStateDir(input), "restore.quarantine");
}

/**
 * Per-vault daemon lock file: `~/.notient/<vault-id>/daemon.lock`.
 *
 * The lock lives outside the vault so a vault stored on a WSL2 DrvFs mount
 * (`/mnt/c/...`) never pays that filesystem's coarse timestamp granularity
 * or write latency for a four-second heartbeat, and so a crashed daemon
 * does not leak a lock file into the user's synced notes folder.
 */
export function vaultLockPath(input: string): string {
  return path.join(vaultStateDir(input), "daemon.lock");
}

/**
 * Per-vault daemon pid file: `~/.notient/<vault-id>/daemon.pid`.
 */
export function vaultDaemonPidPath(input: string): string {
  return path.join(vaultStateDir(input), "daemon.pid");
}

/**
 * Root of the per-vault state tree: `~/.notient/`. `daemon list` scans
 * `<root>/<vault-id>/daemon.pid` so it can enumerate running daemons
 * without connecting to each one.
 */
export function notientStateRoot(): string {
  return path.join(homedir(), ".notient");
}
