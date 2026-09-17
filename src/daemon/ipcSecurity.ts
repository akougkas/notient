import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_SOCKET_MODE = 0o600;

/**
 * Establish the per-vault filesystem boundary before any daemon state is
 * read, minted, or trusted. Both `~/.notient` and its vault-specific child
 * must be real directories owned by this uid; permissive legacy modes are
 * tightened through an already-open, no-follow directory handle.
 */
export async function secureDaemonStateTree(stateDir: string): Promise<void> {
  const stateRoot = dirname(stateDir);
  if (stateRoot === stateDir || dirname(stateRoot) === stateRoot) {
    throw new Error(`refusing to secure an unsafe daemon state path: ${stateDir}`);
  }
  await createDirectoryIfMissing(stateRoot);
  await securePrivateDirectory(stateRoot);
  await createDirectoryIfMissing(stateDir);
  await securePrivateDirectory(stateDir);
}

/** Verify an already-confined directory without changing it. */
export async function assertPrivateDirectory(path: string): Promise<void> {
  const handle = await openDirectoryNoFollow(path);
  try {
    assertOwnedDirectory(await handle.stat(), path, PRIVATE_DIRECTORY_MODE);
    await assertPathStillReferences(path, await handle.stat());
  } finally {
    await handle.close();
  }
}

/**
 * Tighten the bound Unix-domain socket before daemon readiness is published.
 * The containing state directory is already mode 0700, so no untrusted uid
 * can reach the brief bind-to-chmod interval.
 */
export async function secureDaemonSocket(socketPath: string): Promise<void> {
  await assertPrivateDirectory(dirname(socketPath));
  const before = await lstat(socketPath);
  assertOwnedSocket(before, socketPath);
  await chmod(socketPath, PRIVATE_SOCKET_MODE);
  const after = await lstat(socketPath);
  assertOwnedSocket(after, socketPath, PRIVATE_SOCKET_MODE);
  if (!sameFile(before, after)) {
    throw new Error(`daemon socket changed while its permissions were established: ${socketPath}`);
  }
}

async function createDirectoryIfMissing(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function securePrivateDirectory(path: string): Promise<void> {
  const handle = await openDirectoryNoFollow(path);
  try {
    const existing = await handle.stat();
    assertOwnedDirectory(existing, path);
    if ((permissionBits(existing) & 0o022) !== 0) {
      throw new Error(
        `daemon state directory was group/world-writable and may contain hostile preplants: ${path}`,
      );
    }
    await handle.chmod(PRIVATE_DIRECTORY_MODE);
    const secured = await handle.stat();
    assertOwnedDirectory(secured, path, PRIVATE_DIRECTORY_MODE);
    await assertPathStillReferences(path, secured);
  } finally {
    await handle.close();
  }
}

function openDirectoryNoFollow(path: string) {
  return open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

async function assertPathStillReferences(path: string, opened: Stats): Promise<void> {
  const linked = await lstat(path);
  if (!sameFile(opened, linked) || !linked.isDirectory()) {
    throw new Error(`daemon state directory changed while it was being secured: ${path}`);
  }
}

function assertOwnedDirectory(stats: Stats, path: string, mode?: number): void {
  if (!stats.isDirectory()) throw new Error(`daemon state path is not a directory: ${path}`);
  assertOwnedByCurrentUser(stats, `daemon state directory ${path}`);
  if (mode !== undefined && permissionBits(stats) !== mode) {
    throw new Error(`daemon state directory is not mode 0700: ${path}`);
  }
}

function assertOwnedSocket(stats: Stats, path: string, mode?: number): void {
  if (!stats.isSocket()) throw new Error(`daemon IPC path is not a Unix socket: ${path}`);
  assertOwnedByCurrentUser(stats, `daemon socket ${path}`);
  if (mode !== undefined && permissionBits(stats) !== mode) {
    throw new Error(`daemon socket is not mode 0600: ${path}`);
  }
}

function assertOwnedByCurrentUser(stats: Stats, label: string): void {
  if (typeof process.getuid !== "function") {
    throw new Error(`${label} ownership cannot be verified on this platform`);
  }
  if (stats.uid !== process.getuid()) {
    throw new Error(`${label} is owned by uid ${stats.uid}, expected ${process.getuid()}`);
  }
}

function permissionBits(stats: Stats): number {
  return stats.mode & 0o7777;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Read private daemon metadata without following a planted symlink. */
export async function readPrivateJson(path: string): Promise<unknown> {
  await assertPrivateDirectory(dirname(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    assertOwnedByCurrentUser(stat, "private daemon metadata");
    if (!stat.isFile() || permissionBits(stat) !== 0o600 || stat.size > 1048576) {
      throw new Error("private daemon metadata must be a bounded mode-0600 regular file");
    }
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

/** Atomic, fsynced private metadata replacement inside the daemon boundary. */
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await assertPrivateDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    const directory = await openDirectoryNoFollow(dirname(path));
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
