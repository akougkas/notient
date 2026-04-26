export interface LockFs {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface LockClock {
  now(): number;
}

export interface VaultLockHandle {
  release(): Promise<void>;
}

export class VaultLock {
  private static readonly STALE_MS = 12_000;
  private static readonly HEARTBEAT_MS = 4_000;
  private static readonly RECHECK_MS = 2_500;

  constructor(
    private readonly fs: LockFs,
    private readonly path: string,
    private readonly instanceId: string,
    private readonly clock: LockClock = { now: () => Date.now() },
  ) {}

  async acquire(): Promise<VaultLockHandle> {
    const collision = await this.detectCollision();
    if (collision) {
      // The holder may be a dead process from an Obsidian reload; the heartbeat
      // would still look fresh for up to STALE_MS. Wait once and re-read. A
      // truly alive holder will have advanced its timestamp; a dead one won't.
      await sleep(VaultLock.RECHECK_MS);
      const stillAlive = await this.isHolderStillAdvancing(collision.timestamp);
      if (stillAlive) {
        throw new Error(
          `Notient: vault is open in another window (lock holder ${collision.instanceId}). Close that window first.`,
        );
      }
    }
    await this.write();
    const interval = setInterval(() => {
      this.write().catch((error) => console.error("[VaultLock] heartbeat failed", error));
    }, VaultLock.HEARTBEAT_MS);
    return {
      release: async () => {
        clearInterval(interval);
        try {
          await this.fs.remove(this.path);
        } catch {
          // ignore
        }
      },
    };
  }

  private async detectCollision(): Promise<{ instanceId: string; timestamp: number } | null> {
    if (!(await this.fs.exists(this.path))) return null;
    const raw = await this.fs.read(this.path);
    const data = parseLock(raw);
    if (!data) return null;
    if (data.instanceId === this.instanceId) return null;
    const fresh = this.clock.now() - data.timestamp < VaultLock.STALE_MS;
    return fresh ? data : null;
  }

  private async isHolderStillAdvancing(previousTimestamp: number): Promise<boolean> {
    if (!(await this.fs.exists(this.path))) return false;
    const raw = await this.fs.read(this.path);
    const data = parseLock(raw);
    if (!data) return false;
    if (data.instanceId === this.instanceId) return false;
    return data.timestamp > previousTimestamp;
  }

  private async write(): Promise<void> {
    const payload = JSON.stringify({ instanceId: this.instanceId, timestamp: this.clock.now() });
    const data = new TextEncoder().encode(payload).buffer;
    await this.fs.writeBinary(this.path, data);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLock(raw: string): { instanceId: string; timestamp: number } | null {
  try {
    const data = JSON.parse(raw) as { instanceId?: string; timestamp?: number };
    if (typeof data.instanceId === "string" && typeof data.timestamp === "number") {
      return { instanceId: data.instanceId, timestamp: data.timestamp };
    }
    return null;
  } catch {
    return null;
  }
}
