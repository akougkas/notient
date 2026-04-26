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
  private static readonly STALE_MS = 60_000;

  constructor(
    private readonly fs: LockFs,
    private readonly path: string,
    private readonly instanceId: string,
    private readonly clock: LockClock = { now: () => Date.now() },
  ) {}

  async acquire(): Promise<VaultLockHandle> {
    if (await this.fs.exists(this.path)) {
      const raw = await this.fs.read(this.path);
      const data = parseLock(raw);
      const fresh = data && this.clock.now() - data.timestamp < VaultLock.STALE_MS;
      if (fresh && data && data.instanceId !== this.instanceId) {
        throw new Error(
          `Notient: vault is open in another window (lock holder ${data.instanceId}, age ${this.clock.now() - data.timestamp}ms). Close it or wait 60s.`,
        );
      }
    }
    await this.write();
    const interval = setInterval(() => {
      this.write().catch((error) => console.error("[VaultLock] heartbeat failed", error));
    }, 20_000);
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

  private async write(): Promise<void> {
    const payload = JSON.stringify({ instanceId: this.instanceId, timestamp: this.clock.now() });
    const data = new TextEncoder().encode(payload).buffer;
    await this.fs.writeBinary(this.path, data);
  }
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
