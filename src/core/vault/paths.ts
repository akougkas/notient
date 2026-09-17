import { isAbsolute, resolve } from "node:path";

const WINDOWS_DRIVE_PATTERN = /^([a-zA-Z]):[\\/](.*)$/;

/**
 * Normalise a user-supplied vault path to an absolute POSIX path.
 *
 * Relative paths resolve against `cwd`. A Windows drive path such as
 * `C:\Users\me\vault` is translated to its WSL mount equivalent
 * (`/mnt/c/Users/me/vault`) when the process is not running on win32, so the
 * same path string typed in PowerShell and in WSL maps to one vault id, one
 * socket, and one lock file. Symlinks are deliberately left unresolved: two
 * distinct absolute paths stay distinct even when they share an inode.
 */
export function normalizeVaultPath(pathInput: string, cwd: string = process.cwd()): string {
  const trimmed = pathInput.trim();
  const drive = WINDOWS_DRIVE_PATTERN.exec(trimmed);
  if (drive !== null && process.platform !== "win32") {
    const mounted = `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, "/")}`;
    return mounted;
  }
  return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
}
