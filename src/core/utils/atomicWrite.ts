import { createHash, randomUUID } from "node:crypto";
import { chmod as chmodPath, stat as statPath } from "node:fs/promises";
import { isAbsolute } from "node:path";

export interface AtomicFs {
  /** Create a brand-new file. Implementations must fail when `path` exists. */
  writeBinary(path: string, data: ArrayBuffer, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  statMode?(path: string): Promise<number | null>;
  chmod?(path: string, mode: number): Promise<void>;
  beginRecovery(record: AtomicRecoveryRecord): Promise<void>;
  finishRecovery(id: string): Promise<void>;
}

export interface AtomicRecoveryRecord {
  version: 1;
  id: string;
  operation: "write" | "create" | "replace" | "remove" | "move";
  destination?: string;
  target: string;
  prepared: string | null;
  claim: string | null;
  rollback: string | null;
  expectedSha256: string | null;
  replacementSha256: string | null;
}

/** Filesystem operations required by the non-overwriting guarded protocol. */
export interface GuardedAtomicFs extends AtomicFs {
  sameEntry?(from: string, to: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  /** Create `to` as a hard link to `from`, failing with EEXIST when occupied. */
  link(from: string, to: string): Promise<void>;
}

/** Claim the exact source inode, then publish it exclusively at the destination.
 * Recovery distinguishes our publication by inode identity, not equal text. */
export async function atomicMoveIfUnchanged(
  fs: GuardedAtomicFs,
  from: string,
  to: string,
  expected: string,
): Promise<boolean> {
  if (!fs.sameEntry) throw new Error("guarded move requires filesystem identity checks");
  if (from === to) throw new Error("move source and destination must differ");
  const id = randomUUID();
  const claim = claimPath(from, id);
  await fs.beginRecovery({
    ...recoveryRecord({ id, operation: "remove", target: from, claim, expected }),
    operation: "move",
    destination: to,
  });
  if (!(await claimTarget(fs, from, claim, {}))) {
    await fs.finishRecovery(id);
    return false;
  }
  if ((await fs.readText(claim)) !== expected) {
    if (await restoreClaim(fs, claim, from, {})) await fs.finishRecovery(id);
    return false;
  }
  if (!(await linkWithRetry(fs, claim, to, {}))) {
    if (await restoreClaim(fs, claim, from, {})) await fs.finishRecovery(id);
    return false;
  }
  if (!(await fs.sameEntry(claim, to)))
    throw new Error("move destination changed during publication");
  // A descriptor writer's latest bytes stay at the destination. Do not
  // restore an old snapshot over them; the caller reports the revision conflict.
  const unchanged = (await fs.readText(claim)) === expected;
  await fs.remove(claim);
  await fs.finishRecovery(id);
  if (!unchanged)
    throw new Error("move completed but source bytes changed through an open descriptor");
  return true;
}

export interface AtomicWriteOptions {
  retries?: number;
  retryDelayMs?: number;
  /** Mode for a new target. Existing targets always retain their current mode. */
  createMode?: number;
}

const UUID_FRAGMENT = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ATOMIC_TEMP_NAME = new RegExp(`\\.notient-tmp-\\d+-${UUID_FRAGMENT}$`, "i");
const ATOMIC_CLAIM_NAME = new RegExp(`^(.*)\\.notient-claim-\\d+-${UUID_FRAGMENT}$`, "i");
const ATOMIC_ROLLBACK_NAME = new RegExp(`^(.*)\\.notient-rollback-\\d+-${UUID_FRAGMENT}$`, "i");

/** Exact filename marker used to identify a prepared Notient write after process death. */
export function isAtomicWriteTempName(name: string): boolean {
  return ATOMIC_TEMP_NAME.test(name);
}

/**
 * Return the original basename encoded by an interrupted guarded claim.
 * `null` means the filename is ordinary user data.
 */
export function interruptedClaimTargetName(name: string): string | null {
  return ATOMIC_CLAIM_NAME.exec(name)?.[1] ?? null;
}

/** Return the target basename encoded by an authenticated rollback artifact. */
export function interruptedRollbackTargetName(name: string): string | null {
  return ATOMIC_ROLLBACK_NAME.exec(name)?.[1] ?? null;
}

/**
 * Unconditional atomic replacement for daemon-owned files.
 *
 * Public-note read/modify/write paths must use {@link atomicReplaceIfUnchanged}
 * instead. The target's mode is applied to the prepared file before rename,
 * so a failed chmod or process death can never publish broader permissions
 * than an existing 0600 target.
 */
export async function atomicWrite(
  fs: AtomicFs,
  path: string,
  contents: string,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const id = randomUUID();
  const prepared = tempPath(path, id);
  const recovery = recoveryRecord({ id, operation: "write", target: path, prepared, contents });
  await fs.beginRecovery(recovery);
  try {
    const existingMode = await readExistingMode(fs, path);
    const mode = existingMode ?? normalizeMode(opts.createMode ?? defaultCreateMode());
    await prepare(fs, prepared, contents, mode);
    await renameWithRetry(fs, prepared, path, opts);
    await fs.finishRecovery(id);
  } catch (error) {
    if (await safeRemove(fs, prepared)) await fs.finishRecovery(id);
    throw error;
  }
}

/** Atomically publish a new file only while the target pathname is absent. */
export async function atomicCreateIfAbsent(
  fs: GuardedAtomicFs,
  path: string,
  contents: string,
  opts: AtomicWriteOptions = {},
): Promise<boolean> {
  const id = randomUUID();
  const prepared = tempPath(path, id);
  const recovery = recoveryRecord({ id, operation: "create", target: path, prepared, contents });
  await fs.beginRecovery(recovery);
  try {
    const mode = normalizeMode(opts.createMode ?? defaultCreateMode());
    await prepare(fs, prepared, contents, mode);
    const published = await linkWithRetry(fs, prepared, path, opts);
    if (await safeRemove(fs, prepared)) await fs.finishRecovery(id);
    return published;
  } catch (error) {
    if (await safeRemove(fs, prepared)) await fs.finishRecovery(id);
    throw error;
  }
}

/**
 * Replace exact expected bytes without ever renaming over an occupied target.
 *
 * The current pathname is first atomically moved to a unique claim. Its bytes
 * are then compared. Publication uses an exclusive hard-link create, so an
 * editor that recreates the pathname anywhere in the claim-to-publish window
 * wins and is left untouched. An interrupted claim is recoverable by
 * `FsVault.cleanupInterruptedWrites()`.
 */
export async function atomicReplaceIfUnchanged(
  fs: GuardedAtomicFs,
  path: string,
  expected: string,
  contents: string,
  opts: AtomicWriteOptions = {},
): Promise<boolean> {
  const transaction = replaceTransaction(path, expected, contents);
  await fs.beginRecovery(transaction.recovery);
  return await executeReplacement(fs, transaction, opts);
}

interface ReplaceTransaction {
  id: string;
  path: string;
  expected: string;
  contents: string;
  prepared: string;
  claim: string;
  rollback: string;
  recovery: AtomicRecoveryRecord;
}

function replaceTransaction(path: string, expected: string, contents: string): ReplaceTransaction {
  const id = randomUUID();
  const prepared = tempPath(path, id);
  const claim = claimPath(path, id);
  const rollback = rollbackPath(path, id);
  return {
    id,
    path,
    expected,
    contents,
    prepared,
    claim,
    rollback,
    recovery: recoveryRecord({
      id,
      operation: "replace",
      target: path,
      prepared,
      claim,
      rollback,
      expected,
      contents,
    }),
  };
}

async function executeReplacement(
  fs: GuardedAtomicFs,
  transaction: ReplaceTransaction,
  opts: AtomicWriteOptions,
): Promise<boolean> {
  await prepareReplacement(fs, transaction);
  if (!(await claimReplacement(fs, transaction, opts))) return false;
  if (!(await publishReplacement(fs, transaction, opts))) return false;
  return await settlePublishedReplacement(fs, transaction, opts);
}

async function prepareReplacement(
  fs: GuardedAtomicFs,
  transaction: ReplaceTransaction,
): Promise<void> {
  try {
    await prepare(fs, transaction.prepared, transaction.contents, 0o600);
  } catch (error) {
    if (await safeRemove(fs, transaction.prepared)) await fs.finishRecovery(transaction.id);
    throw error;
  }
}

async function claimReplacement(
  fs: GuardedAtomicFs,
  transaction: ReplaceTransaction,
  opts: AtomicWriteOptions,
): Promise<boolean> {
  let claimed: boolean;
  try {
    claimed = await claimTarget(fs, transaction.path, transaction.claim, opts);
  } catch (error) {
    if (await safeRemove(fs, transaction.prepared)) await fs.finishRecovery(transaction.id);
    throw error;
  }
  if (claimed) return true;
  if (await safeRemove(fs, transaction.prepared)) await fs.finishRecovery(transaction.id);
  return false;
}

async function publishReplacement(
  fs: GuardedAtomicFs,
  transaction: ReplaceTransaction,
  opts: AtomicWriteOptions,
): Promise<boolean> {
  let claimMatches: boolean;
  try {
    claimMatches = (await fs.readText(transaction.claim)) === transaction.expected;
  } catch (error) {
    await restorePreparedConflict(fs, transaction, opts);
    throw error;
  }
  if (!claimMatches) {
    await restorePreparedConflict(fs, transaction, opts);
    return false;
  }
  try {
    await applyMode(fs, transaction.prepared, await readRequiredMode(fs, transaction.claim));
    if (await linkWithRetry(fs, transaction.prepared, transaction.path, opts)) return true;
    await discardSupersededReplacement(fs, transaction);
    return false;
  } catch (error) {
    await restorePreparedConflict(fs, transaction, opts);
    throw error;
  }
}

async function settlePublishedReplacement(
  fs: GuardedAtomicFs,
  transaction: ReplaceTransaction,
  opts: AtomicWriteOptions,
): Promise<boolean> {
  // POSIX permits an editor that opened the original inode before our claim
  // to keep writing through that descriptor. Re-read the claimed inode after
  // publication; if it changed, withdraw only our exact candidate and put
  // the editor's bytes back at the canonical pathname.
  let predecessorStillExpected: boolean;
  try {
    predecessorStillExpected = (await fs.readText(transaction.claim)) === transaction.expected;
  } catch (error) {
    await rollbackAndFinish(fs, transaction, opts);
    throw error;
  }
  if (!predecessorStillExpected) {
    await rollbackAndFinish(fs, transaction, opts);
    return false;
  }
  await discardCommittedReplacement(fs, transaction);
  return true;
}

async function restorePreparedConflict(
  fs: GuardedAtomicFs,
  transaction: ReplaceTransaction,
  opts: AtomicWriteOptions,
): Promise<void> {
  const restored = await restoreClaim(fs, transaction.claim, transaction.path, opts);
  const preparedRemoved = await safeRemove(fs, transaction.prepared);
  if (restored && preparedRemoved) await fs.finishRecovery(transaction.id);
}

async function discardSupersededReplacement(
  fs: GuardedAtomicFs,
  transaction: ReplaceTransaction,
): Promise<void> {
  const claimRemoved = await safeRemove(fs, transaction.claim);
  const preparedRemoved = await safeRemove(fs, transaction.prepared);
  if (claimRemoved && preparedRemoved) await fs.finishRecovery(transaction.id);
}

async function rollbackAndFinish(
  fs: GuardedAtomicFs,
  transaction: ReplaceTransaction,
  opts: AtomicWriteOptions,
): Promise<void> {
  const rolledBack = await rollbackPublishedReplacement(
    fs,
    transaction.path,
    transaction.claim,
    transaction.rollback,
    transaction.contents,
    opts,
  );
  const preparedRemoved = await safeRemove(fs, transaction.prepared);
  if (rolledBack && preparedRemoved) await fs.finishRecovery(transaction.id);
}

async function discardCommittedReplacement(
  fs: GuardedAtomicFs,
  transaction: ReplaceTransaction,
): Promise<void> {
  const preparedRemoved = await safeRemove(fs, transaction.prepared);
  const claimRemoved = await safeRemove(fs, transaction.claim);
  if (preparedRemoved && claimRemoved) await fs.finishRecovery(transaction.id);
}

async function rollbackPublishedReplacement(
  fs: GuardedAtomicFs,
  path: string,
  predecessor: string,
  withdrawn: string,
  publishedContents: string,
  opts: AtomicWriteOptions,
): Promise<boolean> {
  const claimed = await claimTarget(fs, path, withdrawn, opts);
  if (!claimed) {
    const restored = await linkWithRetry(fs, predecessor, path, opts);
    if (!restored) {
      throw new Error(`guarded vault mutation rollback collided at '${path}'`);
    }
    return await safeRemove(fs, predecessor);
  }

  const current = await fs.readText(withdrawn);
  if (current !== publishedContents) {
    await restoreClaim(fs, withdrawn, path, opts);
    throw new Error(`guarded vault mutation rollback refused changed target '${path}'`);
  }

  const restored = await linkWithRetry(fs, predecessor, path, opts);
  if (!restored) {
    await restoreClaim(fs, withdrawn, path, opts);
    throw new Error(`guarded vault mutation rollback collided at '${path}'`);
  }
  const predecessorRemoved = await safeRemove(fs, predecessor);
  const withdrawnRemoved = await safeRemove(fs, withdrawn);
  return predecessorRemoved && withdrawnRemoved;
}

/** Delete exact expected bytes without an unguarded compare-to-rm window. */
export async function atomicRemoveIfUnchanged(
  fs: GuardedAtomicFs,
  path: string,
  expected: string,
  opts: AtomicWriteOptions = {},
): Promise<boolean> {
  const id = randomUUID();
  const claim = claimPath(path, id);
  await fs.beginRecovery(
    recoveryRecord({ id, operation: "remove", target: path, claim, expected }),
  );
  let claimed: boolean;
  try {
    claimed = await claimTarget(fs, path, claim, opts);
  } catch (error) {
    await fs.finishRecovery(id);
    throw error;
  }
  if (!claimed) {
    await fs.finishRecovery(id);
    return false;
  }

  try {
    const actual = await fs.readText(claim);
    if (actual !== expected) {
      if (await restoreClaim(fs, claim, path, opts)) await fs.finishRecovery(id);
      return false;
    }
    await fs.remove(claim);
    await fs.finishRecovery(id);
    return true;
  } catch (error) {
    if (await restoreClaim(fs, claim, path, opts)) await fs.finishRecovery(id);
    throw error;
  }
}

async function prepare(fs: AtomicFs, path: string, contents: string, mode: number): Promise<void> {
  const data = new TextEncoder().encode(contents).buffer;
  // A restrictive creation mode prevents the temp itself from leaking bytes
  // if the process dies before the preserved/final mode is applied.
  await fs.writeBinary(path, data, 0o600);
  await applyMode(fs, path, normalizeMode(mode));
}

async function claimTarget(
  fs: AtomicFs,
  path: string,
  claim: string,
  opts: AtomicWriteOptions,
): Promise<boolean> {
  try {
    await renameWithRetry(fs, path, claim, opts);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function restoreClaim(
  fs: GuardedAtomicFs,
  claim: string,
  path: string,
  opts: AtomicWriteOptions,
): Promise<boolean> {
  try {
    const restored = await linkWithRetry(fs, claim, path, opts);
    if (restored) return await safeRemove(fs, claim);
    // Another path-based writer has already restored/recreated the canonical
    // pathname. Never overwrite it; the claimed predecessor is superseded.
    return await safeRemove(fs, claim);
  } catch (error) {
    // Keep the claim in place. Startup recovery can retry without data loss.
    throw new Error(`guarded vault mutation could not restore '${path}'`, { cause: error });
  }
}

async function renameWithRetry(
  fs: AtomicFs,
  from: string,
  to: string,
  opts: AtomicWriteOptions,
): Promise<void> {
  const retries = opts.retries ?? 4;
  const delayMs = opts.retryDelayMs ?? 50;
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (!isWindowsRetryable(error) || attempt >= retries) throw error;
      await sleep(delayMs * (attempt + 1));
    }
  }
}

async function linkWithRetry(
  fs: GuardedAtomicFs,
  from: string,
  to: string,
  opts: AtomicWriteOptions,
): Promise<boolean> {
  const retries = opts.retries ?? 4;
  const delayMs = opts.retryDelayMs ?? 50;
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.link(from, to);
      return true;
    } catch (error) {
      if (isAlreadyExists(error)) return false;
      if (!isWindowsRetryable(error) || attempt >= retries) throw error;
      await sleep(delayMs * (attempt + 1));
    }
  }
}

async function readExistingMode(fs: AtomicFs, path: string): Promise<number | null> {
  try {
    const mode = fs.statMode
      ? await fs.statMode(path)
      : isAbsolute(path)
        ? (await statPath(path)).mode
        : null;
    return typeof mode === "number" ? normalizeMode(mode) : null;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function readRequiredMode(fs: AtomicFs, path: string): Promise<number> {
  const mode = await readExistingMode(fs, path);
  if (mode === null) throw new Error(`guarded vault mutation lost its claim '${path}'`);
  return mode;
}

async function applyMode(fs: AtomicFs, path: string, mode: number): Promise<void> {
  if (fs.chmod) {
    await fs.chmod(path, mode);
    return;
  }
  if (isAbsolute(path)) {
    await chmodPath(path, mode);
  }
}

function normalizeMode(mode: number): number {
  if (!Number.isSafeInteger(mode) || mode < 0) throw new Error("atomic write mode is invalid");
  return mode & 0o7777;
}

function defaultCreateMode(): number {
  return 0o666 & ~process.umask();
}

function tempPath(path: string, id: string): string {
  return `${path}.notient-tmp-${process.pid}-${id}`;
}

function claimPath(path: string, id: string): string {
  return `${path}.notient-claim-${process.pid}-${id}`;
}

function rollbackPath(path: string, id: string): string {
  return `${path}.notient-rollback-${process.pid}-${id}`;
}

interface RecoveryRecordInput {
  id: string;
  operation: AtomicRecoveryRecord["operation"];
  target: string;
  prepared?: string;
  claim?: string;
  rollback?: string;
  expected?: string;
  contents?: string;
}

function recoveryRecord(input: RecoveryRecordInput): AtomicRecoveryRecord {
  return {
    version: 1,
    id: input.id,
    operation: input.operation,
    target: input.target,
    prepared: input.prepared ?? null,
    claim: input.claim ?? null,
    rollback: input.rollback ?? null,
    expectedSha256: input.expected === undefined ? null : sha256(input.expected),
    replacementSha256: input.contents === undefined ? null : sha256(input.contents),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isMissingFile(error: unknown): boolean {
  const msg = (error as { message?: string })?.message ?? "";
  const code = (error as { code?: string })?.code ?? "";
  return code === "ENOENT" || /ENOENT|not found/i.test(msg);
}

function isAlreadyExists(error: unknown): boolean {
  const msg = (error as { message?: string })?.message ?? "";
  const code = (error as { code?: string })?.code ?? "";
  return code === "EEXIST" || /EEXIST|already exists/i.test(msg);
}

function isWindowsRetryable(error: unknown): boolean {
  const msg = (error as { message?: string })?.message ?? "";
  const code = (error as { code?: string })?.code ?? "";
  return code === "EPERM" || code === "EBUSY" || /EPERM|EBUSY/.test(msg);
}

async function safeRemove(fs: AtomicFs, path: string): Promise<boolean> {
  try {
    await fs.remove(path);
    return true;
  } catch {
    // A committed target never depends on temp/claim cleanup succeeding.
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
