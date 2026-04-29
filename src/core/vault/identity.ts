import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

const ID_LENGTH = 16;

/**
 * Derive a stable 16-character lowercase hex identifier for a vault from its
 * filesystem path. Uses `path.resolve` to normalise relative paths against the
 * current working directory. Symlinks are intentionally not resolved so that
 * different absolute paths map to different ids even if they point at the same
 * underlying inode.
 */
export function vaultId(input: string): string {
  const absolute = path.resolve(input);
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
