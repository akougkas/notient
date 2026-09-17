import path from "node:path";
import { vaultStateDir } from "../core/vault/identity";

export type Platform = "linux" | "darwin" | "win32";

/**
 * Returns the platform-appropriate socket path for a daemon serving the given
 * absolute vault path.
 *
 * Linux, macOS, and WSL2 use a Unix socket under the per-vault state
 * directory `~/.notient/<vault-id>/notient.sock`. The socket deliberately
 * does not live inside the vault: vaults commonly sit on a WSL2 DrvFs mount
 * (`/mnt/c/...`), where unix sockets and rapid small writes are slow or
 * unsupported, and a crashed daemon would leak the socket file into a
 * synced notes folder. Native Windows is refused: the current runtime does
 * not expose a way to establish and verify a current-user-only named-pipe
 * ACL, so accepting a pipe there would weaken the local-user boundary.
 */
export function resolveSocketPath(absoluteVaultPath: string, platform: Platform): string {
  if (platform === "win32") {
    throw new Error(
      "native Windows daemon IPC is unsupported because Notient cannot verify a current-user-only named-pipe ACL; use WSL2",
    );
  }
  return path.join(vaultStateDir(absoluteVaultPath), "notient.sock");
}

/** Minimal surface `writeFrame` needs; keeps it testable with a fake. */
export interface WritableSocket {
  destroyed: boolean;
  writable: boolean;
  write(data: string): unknown;
}

/**
 * Write one newline-delimited frame to a client socket, tolerating a peer
 * that has already gone away.
 *
 * Handlers emit frames from async callbacks that can outlive the client.
 * Writing to a destroyed socket can throw `ERR_STREAM_DESTROYED`; this
 * boundary absorbs that transport failure and reports whether the frame was
 * handed to the socket.
 */
export function writeFrame(socket: WritableSocket, frame: string): boolean {
  if (socket.destroyed || !socket.writable) return false;
  try {
    socket.write(`${frame}\n`);
    return true;
  } catch {
    return false;
  }
}

export function currentPlatform(): Platform {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}
