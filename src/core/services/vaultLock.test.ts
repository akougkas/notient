import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type LockClock, type LockFs, VaultLock } from "./vaultLock";

class MemFs implements LockFs {
  files = new Map<string, string>();
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async read(path: string): Promise<string> {
    const v = this.files.get(path);
    if (!v) throw new Error("ENOENT");
    return v;
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, new TextDecoder().decode(data));
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}

let originalSetInterval: typeof setInterval;
beforeEach(() => {
  originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = (() => 0) as unknown as typeof setInterval;
});
afterEach(() => {
  globalThis.setInterval = originalSetInterval;
});

const clock = (now: number): LockClock => ({ now: () => now });

describe("VaultLock", () => {
  test("acquires when no lock exists", async () => {
    const fs = new MemFs();
    const lock = new VaultLock(fs, "/vault/.notient.lock", "instance-A", clock(1000));
    const handle = await lock.acquire();
    expect(fs.files.has("/vault/.notient.lock")).toBe(true);
    await handle.release();
    expect(fs.files.has("/vault/.notient.lock")).toBe(false);
  });

  test("rejects when alive holder advances its heartbeat during recheck", async () => {
    const fs = new MemFs();
    fs.files.set(
      "/vault/.notient.lock",
      JSON.stringify({ instanceId: "instance-A", timestamp: 1000 }),
    );
    const lock = new VaultLock(fs, "/vault/.notient.lock", "instance-B", clock(1500));
    setTimeout(() => {
      fs.files.set(
        "/vault/.notient.lock",
        JSON.stringify({ instanceId: "instance-A", timestamp: 9999 }),
      );
    }, 500);
    await expect(lock.acquire()).rejects.toThrow(/another window/);
  });

  test("steals stale lock (timestamp older than the staleness window)", async () => {
    const fs = new MemFs();
    fs.files.set(
      "/vault/.notient.lock",
      JSON.stringify({ instanceId: "instance-A", timestamp: 1000 }),
    );
    const lock = new VaultLock(fs, "/vault/.notient.lock", "instance-B", clock(20_000));
    const handle = await lock.acquire();
    await handle.release();
  });

  test("steals lock from dead holder whose heartbeat does not advance", async () => {
    const fs = new MemFs();
    fs.files.set(
      "/vault/.notient.lock",
      JSON.stringify({ instanceId: "instance-A", timestamp: 1000 }),
    );
    const lock = new VaultLock(fs, "/vault/.notient.lock", "instance-B", clock(1500));
    const handle = await lock.acquire();
    await handle.release();
  });

  test("re-acquire by same instance is idempotent (no error)", async () => {
    const fs = new MemFs();
    fs.files.set(
      "/vault/.notient.lock",
      JSON.stringify({ instanceId: "instance-A", timestamp: 1000 }),
    );
    const lock = new VaultLock(fs, "/vault/.notient.lock", "instance-A", clock(1500));
    const handle = await lock.acquire();
    await handle.release();
  });
});
