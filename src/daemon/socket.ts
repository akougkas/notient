import { createHash } from "node:crypto";

export type Platform = "linux" | "darwin" | "win32";

/**
 * Returns the platform-appropriate socket path for a daemon serving the given
 * absolute vault path. Linux, macOS, and WSL2 use a Unix socket inside the
 * vault's .notient/ folder. Windows native uses a named pipe whose suffix is
 * the first eight hex chars of sha256(absoluteVaultPath).
 */
export function resolveSocketPath(absoluteVaultPath: string, platform: Platform): string {
  if (platform === "win32") {
    const hash = createHash("sha256").update(absoluteVaultPath).digest("hex").slice(0, 8);
    return `\\\\.\\pipe\\notient-${hash}`;
  }
  return `${absoluteVaultPath}/.notient/notient.sock`;
}

export function currentPlatform(): Platform {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}
