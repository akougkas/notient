/**
 * Atomic File Write Utility
 *
 * Provides crash-safe file writes using the temp-file + rename pattern.
 * On POSIX filesystems, rename() is atomic when source and dest are on
 * the same filesystem, ensuring files are either fully written or unchanged.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Check if error code indicates Windows file-locking issue.
 */
function isRetryableError(code: string | undefined): boolean {
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

/**
 * Fallback rename using copy + delete.
 * Returns true if successful, false otherwise.
 */
async function copyAndDelete(src: string, dest: string): Promise<boolean> {
  try {
    await fs.promises.copyFile(src, dest);
    await fs.promises.unlink(src);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rename with retry for Windows EPERM issues.
 * Windows can temporarily lock files (antivirus, indexing, etc.)
 */
async function renameWithRetry(
  src: string,
  dest: string,
  maxRetries = 3,
  baseDelayMs = 100,
): Promise<void> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await fs.promises.rename(src, dest);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const isRetryable = isRetryableError(code);
      const isLastAttempt = attempt === maxRetries - 1;

      if (!isRetryable) {
        throw error;
      }

      if (isLastAttempt) {
        const copySucceeded = await copyAndDelete(src, dest);
        if (copySucceeded) return;
        throw error;
      }

      // Exponential backoff: 100ms, 200ms, 400ms
      const delay = baseDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Atomically write data to a file using temp file + rename pattern.
 * This ensures the file is either fully written or not changed at all.
 *
 * @param filePath - Target file path
 * @param data - Content to write
 * @throws Error if write fails (temp file is cleaned up)
 */
export async function atomicWriteFile(filePath: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.tmp.${Date.now()}`);

  try {
    // Ensure directory exists before writing
    await fs.promises.mkdir(dir, { recursive: true });

    // Write to temp file first
    if (typeof data === "string") {
      await fs.promises.writeFile(tempPath, data, "utf-8");
    } else {
      await fs.promises.writeFile(tempPath, data);
    }

    // Sync to ensure data is flushed to disk before rename
    // This is important for crash safety, but we gracefully degrade on EPERM
    // (common on WSL2 with Windows-mounted filesystems)
    try {
      const fd = await fs.promises.open(tempPath, "r+");
      try {
        await fd.sync();
      } finally {
        await fd.close();
      }
    } catch (syncError) {
      // EPERM on fsync is common on WSL2 - data is likely already flushed
      if ((syncError as NodeJS.ErrnoException).code !== "EPERM") {
        throw syncError;
      }
    }

    // Atomic rename (on same filesystem, this is atomic)
    // On Windows, rename can fail with EPERM if file is locked - retry with backoff
    await renameWithRetry(tempPath, filePath);
  } catch (error) {
    // Clean up temp file if write or rename failed
    try {
      await fs.promises.unlink(tempPath);
    } catch {
      // Ignore cleanup errors - temp file may not exist
    }
    throw error;
  }
}
