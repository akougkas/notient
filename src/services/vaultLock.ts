/**
 * Multi-window vault lock management
 *
 * Prevents concurrent writes from multiple Obsidian windows.
 * Uses lockfile-based approach with staleness detection.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LOCK_FILES } from "../core/constants";
import type { StoragePaths } from "./storagePaths";

interface LockMetadata {
  pid: number;
  timestamp: number;
  hostname: string;
}

/** Lock staleness threshold (30 seconds - gives 3x safety margin over refresh) */
const LOCK_STALE_MS = 30000;

/** Lock refresh interval (10 seconds - refreshes 3 times before lock becomes stale) */
const LOCK_REFRESH_MS = 10000;

/** Max retry attempts for lock acquisition */
const LOCK_MAX_RETRIES = 3;

/** Base delay for exponential backoff (ms) */
const LOCK_RETRY_BASE_MS = 200;

export class VaultLock {
  private lockPath: string;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private hasLock = false;

  constructor(private storagePaths: StoragePaths) {
    this.lockPath = path.join(storagePaths.locks, LOCK_FILES.WRITER);
  }

  /**
   * Try to acquire the writer lock with retry logic
   * @returns true if lock acquired, false if another process holds it
   */
  async tryAcquire(): Promise<boolean> {
    for (let attempt = 1; attempt <= LOCK_MAX_RETRIES; attempt++) {
      try {
        // Ensure locks directory exists
        await fs.promises.mkdir(this.storagePaths.locks, { recursive: true });

        // Check if lock exists and is stale
        if (await this.isLockStale()) {
          await this.removeStaleLock();
        }

        // Try to create lock file atomically
        const metadata: LockMetadata = {
          pid: process.pid,
          timestamp: Date.now(),
          hostname: require("node:os").hostname(),
        };

        try {
          await fs.promises.writeFile(
            this.lockPath,
            JSON.stringify(metadata),
            { flag: "wx" }, // Exclusive create, fails if exists
          );
          this.hasLock = true;
          this.startRefresh();
          console.log(`[VaultLock] Lock acquired on attempt ${attempt}`);
          return true;
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") {
            // Lock exists - retry with exponential backoff
            if (attempt < LOCK_MAX_RETRIES) {
              const backoffMs = LOCK_RETRY_BASE_MS * 2 ** (attempt - 1);
              console.log(
                `[VaultLock] Lock held by another process, retrying in ${backoffMs}ms (attempt ${attempt}/${LOCK_MAX_RETRIES})`,
              );
              await new Promise((resolve) => setTimeout(resolve, backoffMs));
              continue;
            }
            console.warn("[VaultLock] Lock held by another process after all retries");
            return false;
          }
          throw err;
        }
      } catch (error) {
        console.error(`[VaultLock] Error acquiring lock (attempt ${attempt}):`, error);
        if (attempt >= LOCK_MAX_RETRIES) {
          return false;
        }
        // Retry on error too
        const backoffMs = LOCK_RETRY_BASE_MS * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
    return false;
  }

  /**
   * Check if current process holds the lock
   */
  isHeld(): boolean {
    return this.hasLock;
  }

  /**
   * Release the writer lock
   */
  async release(): Promise<void> {
    this.stopRefresh();

    if (!this.hasLock) {
      return;
    }

    try {
      // Verify we still own the lock before releasing
      const metadata = await this.readLockMetadata();
      if (metadata && metadata.pid === process.pid) {
        await fs.promises.unlink(this.lockPath);
      }
    } catch (error) {
      // Ignore errors during release
      console.warn("[VaultLock] Error releasing lock:", error);
    }

    this.hasLock = false;
  }

  /**
   * Check if existing lock is stale (old or from dead process)
   */
  private async isLockStale(): Promise<boolean> {
    const metadata = await this.readLockMetadata();
    if (!metadata) {
      return false; // No lock exists
    }

    // Check if lock is too old
    if (Date.now() - metadata.timestamp > LOCK_STALE_MS) {
      return true;
    }

    // Could also check if PID is still running, but that's platform-specific
    // For now, rely on timestamp staleness

    return false;
  }

  /**
   * Read lock metadata from file
   */
  private async readLockMetadata(): Promise<LockMetadata | null> {
    try {
      const content = await fs.promises.readFile(this.lockPath, "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Remove a stale lock file
   */
  private async removeStaleLock(): Promise<void> {
    try {
      await fs.promises.unlink(this.lockPath);
      console.log("[VaultLock] Removed stale lock");
    } catch {
      // Ignore if already removed
    }
  }

  /**
   * Start periodic lock refresh
   */
  private startRefresh(): void {
    this.stopRefresh();
    this.refreshInterval = setInterval(async () => {
      if (this.hasLock) {
        try {
          // Verify we still own the lock before refreshing
          const currentMeta = await this.readLockMetadata();
          if (!currentMeta || currentMeta.pid !== process.pid) {
            console.error(
              "[VaultLock] Lost lock ownership during refresh - another process took it",
            );
            this.hasLock = false;
            this.stopRefresh();
            return;
          }

          const metadata: LockMetadata = {
            pid: process.pid,
            timestamp: Date.now(),
            hostname: require("node:os").hostname(),
          };
          await fs.promises.writeFile(this.lockPath, JSON.stringify(metadata));
        } catch (error) {
          console.error("[VaultLock] Failed to refresh lock:", error);
          // Clear lock flag on refresh failure to prevent corrupted state
          this.hasLock = false;
          this.stopRefresh();
        }
      }
    }, LOCK_REFRESH_MS);
  }

  /**
   * Stop periodic lock refresh
   */
  private stopRefresh(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  /**
   * Dispose of the lock
   */
  dispose(): void {
    this.stopRefresh();
    // Synchronous cleanup for unload
    if (this.hasLock) {
      try {
        fs.unlinkSync(this.lockPath);
      } catch {
        // Ignore
      }
      this.hasLock = false;
    }
  }
}
