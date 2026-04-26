export interface AtomicFs {
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
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

  await fs.writeBinary(tmp, data);

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await fs.rename(tmp, path);
      return;
    } catch (error) {
      lastError = error;
      if (!isWindowsRetryable(error) || attempt === retries) {
        await safeRemove(fs, tmp);
        throw error;
      }
      await sleep(delayMs * (attempt + 1));
    }
  }
  throw lastError;
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
