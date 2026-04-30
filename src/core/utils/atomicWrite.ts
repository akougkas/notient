import { chmod as chmodPath, stat as statPath } from "node:fs/promises";
import { isAbsolute } from "node:path";

export interface AtomicFs {
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  statMode?(path: string): Promise<number | null>;
  chmod?(path: string, mode: number): Promise<void>;
}

export interface AtomicWriteOptions {
  retries?: number;
  retryDelayMs?: number;
}

export async function atomicWrite(
  fs: AtomicFs,
  path: string,
  contents: string,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const retries = opts.retries ?? 4;
  const delayMs = opts.retryDelayMs ?? 50;
  const tmp = `${path}.notient-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const data = new TextEncoder().encode(contents).buffer;
  const existingMode = await readExistingMode(fs, path);

  await fs.writeBinary(tmp, data);

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await fs.rename(tmp, path);
    } catch (error) {
      lastError = error;
      if (!isWindowsRetryable(error) || attempt === retries) {
        await safeRemove(fs, tmp);
        throw error;
      }
      await sleep(delayMs * (attempt + 1));
      continue;
    }
    await restoreMode(fs, path, existingMode);
    return;
  }
  throw lastError;
}

async function readExistingMode(fs: AtomicFs, path: string): Promise<number | null> {
  try {
    const mode = fs.statMode
      ? await fs.statMode(path)
      : isAbsolute(path)
        ? (await statPath(path)).mode
        : null;
    return typeof mode === "number" ? mode & 0o7777 : null;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function restoreMode(fs: AtomicFs, path: string, mode: number | null): Promise<void> {
  if (mode === null) return;
  if (fs.chmod) {
    await fs.chmod(path, mode);
    return;
  }
  if (isAbsolute(path)) {
    await chmodPath(path, mode);
  }
}

function isMissingFile(error: unknown): boolean {
  const msg = (error as { message?: string })?.message ?? "";
  const code = (error as { code?: string })?.code ?? "";
  return code === "ENOENT" || /ENOENT|not found/i.test(msg);
}

function isWindowsRetryable(error: unknown): boolean {
  const msg = (error as { message?: string })?.message ?? "";
  const code = (error as { code?: string })?.code ?? "";
  return code === "EPERM" || code === "EBUSY" || /EPERM|EBUSY/.test(msg);
}

async function safeRemove(fs: AtomicFs, path: string): Promise<void> {
  try {
    await fs.remove(path);
  } catch {
    // ignore cleanup failure
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
