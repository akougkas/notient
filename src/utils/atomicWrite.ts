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
 * Atomically write data to a file using temp file + rename pattern.
 * This ensures the file is either fully written or not changed at all.
 *
 * @param filePath - Target file path
 * @param data - Content to write
 * @throws Error if write fails (temp file is cleaned up)
 */
export async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.tmp.${Date.now()}`);

  try {
    // Write to temp file first
    await fs.promises.writeFile(tempPath, data, "utf-8");

    // Atomic rename (on same filesystem, this is atomic)
    await fs.promises.rename(tempPath, filePath);
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
