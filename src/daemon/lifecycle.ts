import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { notientStateRoot } from "../core/vault/identity";
import { assertPrivateDirectory } from "./ipcSecurity";

/**
 * Mint a fresh admin token and write it to `tokenPath` with mode 0600.
 *
 * Called once per daemon boot. Regenerating rather than reusing means a
 * token captured from an earlier run cannot authorize the current daemon,
 * and `removeAdminToken` on shutdown leaves nothing behind.
 */
export async function writeAdminToken(tokenPath: string): Promise<string> {
  const directory = dirname(tokenPath);
  await assertPrivateTokenDirectory(directory);
  const token = randomBytes(32).toString("hex");
  const stagingPath = join(directory, `.admin-token-${randomUUID()}.tmp`);
  const prior = await inspectReplaceableToken(tokenPath);
  const handle = await open(
    stagingPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let published = false;
  try {
    await handle.writeFile(token, { encoding: "utf8" });
    await handle.chmod(0o600);
    await handle.sync();
    const staged = await handle.stat();
    assertPrivateRegularFile(staged, stagingPath);
    await assertTokenTargetUnchanged(tokenPath, prior);
    await rename(stagingPath, tokenPath);
    published = true;
    try {
      const installed = await lstat(tokenPath);
      assertPrivateRegularFile(installed, tokenPath);
      if (!sameFile(staged, installed)) {
        throw new Error("published admin token inode does not match its private staging file");
      }
    } catch (error) {
      await removeMatchingFile(tokenPath, staged).catch(() => {});
      throw error;
    }
    return token;
  } finally {
    await handle.close().catch(() => {});
    if (!published) await rm(stagingPath, { force: true }).catch(() => {});
  }
}

export async function removeAdminToken(tokenPath: string): Promise<void> {
  await assertPrivateTokenDirectory(dirname(tokenPath));
  let current: Stats;
  try {
    current = await lstat(tokenPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  assertPrivateRegularFile(current, tokenPath);
  await removeMatchingFile(tokenPath, current);
}

/**
 * Read the admin token a running daemon published. Returns `null` when the
 * file is absent or unreadable, which is the normal case for a caller that
 * is not the local user who owns the daemon.
 */
export async function readAdminToken(tokenPath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await assertPrivateTokenDirectory(dirname(tokenPath));
    handle = await open(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    assertPrivateRegularFile(await handle.stat(), tokenPath);
    const raw = await handle.readFile("utf-8");
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function assertPrivateTokenDirectory(directory: string): Promise<void> {
  await assertPrivateDirectory(dirname(directory));
  await assertPrivateDirectory(directory);
}

type ExistingToken = { kind: "missing" } | { kind: "file"; stats: Stats };

async function inspectReplaceableToken(tokenPath: string): Promise<ExistingToken> {
  let stats: Stats;
  try {
    stats = await lstat(tokenPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  if (!stats.isFile()) {
    throw new Error(`refusing to replace a non-regular admin token path: ${tokenPath}`);
  }
  assertOwnedByCurrentUser(stats, `existing admin token ${tokenPath}`);
  return { kind: "file", stats };
}

async function assertTokenTargetUnchanged(tokenPath: string, prior: ExistingToken): Promise<void> {
  let current: Stats;
  try {
    current = await lstat(tokenPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && prior.kind === "missing") return;
    throw new Error(`admin token target changed before publication: ${tokenPath}`);
  }
  if (prior.kind !== "file" || !current.isFile() || !sameFile(prior.stats, current)) {
    throw new Error(`admin token target changed before publication: ${tokenPath}`);
  }
}

function assertPrivateRegularFile(stats: Stats, path: string): void {
  if (!stats.isFile()) throw new Error(`admin token is not a regular file: ${path}`);
  assertOwnedByCurrentUser(stats, `admin token ${path}`);
  if ((stats.mode & 0o7777) !== 0o600) {
    throw new Error(`admin token is not mode 0600: ${path}`);
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

async function removeMatchingFile(path: string, expected: Stats): Promise<void> {
  const current = await lstat(path);
  if (!current.isFile() || !sameFile(current, expected)) {
    throw new Error(`refusing to remove changed admin token path: ${path}`);
  }
  await rm(path);
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export interface IdleExitTimerOptions {
  /** null keeps a persistent daemon alive until explicitly stopped. */
  idleMs: number | null;
  onIdleExit: () => void;
  /**
   * Optional veto consulted when the deadline expires. Returning `true`
   * suppresses the exit and rearms the timer for another full window.
   *
   * The daemon wires this to the in-flight `awaken --background` worker
   * count. Without it, a long background awaken with no client attached
   * looked idle (the timer was refreshed only by socket data) and the
   * daemon killed itself mid-run.
   */
  isBusy?: () => boolean;
}

export class IdleExitTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: IdleExitTimerOptions) {}

  start(): void {
    this.markActive();
  }

  markActive(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.options.idleMs === null) {
      this.timer = null;
      return;
    }
    this.timer = setTimeout(() => this.fire(), this.options.idleMs);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private fire(): void {
    if (this.options.isBusy?.() === true) {
      this.markActive();
      return;
    }
    this.options.onIdleExit();
  }
}

export interface PidRecord {
  pid: number;
  socketPath: string;
  /** Absolute vault path this daemon serves. */
  vault: string;
  startedAt: number;
  instanceId: string;
  version: string;
  /** True until bootstrap, watcher startup, and socket listen all complete. */
  booting: boolean;
}

export type PidFileSnapshot =
  | { kind: "missing" }
  | { kind: "invalid"; pid: number | null; reason: string }
  | { kind: "record"; record: PidRecord };

/** Atomically claim an absent pid path for one daemon instance. */
export async function claimPidFile(path: string, record: PidRecord): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, JSON.stringify(record), {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** Publish a new lifecycle state without exposing a partially written record. */
export async function updateOwnedPidFile(path: string, record: PidRecord): Promise<void> {
  await assertPidOwnership(path, record.instanceId);
  const temporaryPath = `${path}.${record.instanceId}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(record), {
      encoding: "utf-8",
      mode: 0o600,
    });
    await assertPidOwnership(path, record.instanceId);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/**
 * Remove the pid record only if it still belongs to `instanceId`. A retiring
 * process must never erase ownership published by a successor.
 */
export async function removeOwnedPidFile(path: string, instanceId: string): Promise<void> {
  const snapshot = await inspectPidFile(path);
  if (snapshot.kind !== "record" || snapshot.record.instanceId !== instanceId) return;
  await rm(path, { force: true });
}

/** Read a pid path while preserving missing and malformed states. */
export async function inspectPidFile(path: string): Promise<PidFileSnapshot> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "invalid", pid: null, reason: "pid file is unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "invalid", pid: null, reason: "pid file is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "invalid", pid: null, reason: "pid record is not an object" };
  }
  const candidate = parsed as Record<string, unknown>;
  const candidatePid =
    typeof candidate.pid === "number" && Number.isInteger(candidate.pid) && candidate.pid > 0
      ? candidate.pid
      : null;
  const invalidReason = validatePidRecord(candidate);
  if (invalidReason !== null) {
    return { kind: "invalid", pid: candidatePid, reason: invalidReason };
  }
  return { kind: "record", record: candidate as unknown as PidRecord };
}

function validatePidRecord(candidate: Record<string, unknown>): string | null {
  if (typeof candidate.pid !== "number" || !Number.isInteger(candidate.pid) || candidate.pid <= 0) {
    return "pid must be a positive integer";
  }
  if (typeof candidate.socketPath !== "string" || candidate.socketPath.length === 0) {
    return "socketPath must be a non-empty string";
  }
  if (typeof candidate.vault !== "string" || candidate.vault.length === 0) {
    return "vault must be a non-empty string";
  }
  if (
    typeof candidate.startedAt !== "number" ||
    !Number.isFinite(candidate.startedAt) ||
    candidate.startedAt < 0
  ) {
    return "startedAt must be a non-negative number";
  }
  if (typeof candidate.instanceId !== "string" || candidate.instanceId.length === 0) {
    return "instanceId must be a non-empty string";
  }
  if (typeof candidate.version !== "string" || candidate.version.length === 0) {
    return "version must be a non-empty string";
  }
  if (typeof candidate.booting !== "boolean") return "booting must be boolean";
  return null;
}

async function assertPidOwnership(path: string, instanceId: string): Promise<void> {
  const snapshot = await inspectPidFile(path);
  if (snapshot.kind === "record" && snapshot.record.instanceId === instanceId) return;
  throw new Error(`daemon ownership lost for ${path}`);
}

/**
 * Signal-0 liveness probe. `EPERM` means the pid exists but belongs to
 * another user, which still counts as alive.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface DaemonPidEntry {
  vaultId: string;
  pidPath: string;
  record: PidRecord;
  alive: boolean;
}

/**
 * Enumerate `~/.notient/<vault-id>/daemon.pid` records. Used by
 * `notient daemon list` so it can report every known daemon without
 * opening a socket to each one.
 */
export async function listDaemonPidFiles(
  root: string = notientStateRoot(),
): Promise<DaemonPidEntry[]> {
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const found: DaemonPidEntry[] = [];
  for (const vaultId of entries.sort()) {
    const pidPath = join(root, vaultId, "daemon.pid");
    const snapshot = await inspectPidFile(pidPath);
    if (snapshot.kind !== "record") continue;
    found.push({
      vaultId,
      pidPath,
      record: snapshot.record,
      alive: isProcessAlive(snapshot.record.pid),
    });
  }
  return found;
}
