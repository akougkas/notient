import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LockClock,
  type LockFs,
  VaultLock,
  createNodeLockFs,
} from "../../../../src/core/services/vaultLock";

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

  test("release leaves a successor's lock intact", async () => {
    const fs = new MemFs();
    const path = "/vault/.notient.lock";
    const lock = new VaultLock(fs, path, "instance-A", clock(1000));
    const handle = await lock.acquire();
    fs.files.set(path, JSON.stringify({ instanceId: "instance-B", timestamp: 2000 }));

    await handle.release();

    expect(JSON.parse(await fs.read(path))).toEqual({
      instanceId: "instance-B",
      timestamp: 2000,
    });
  });
});

describe("createNodeLockFs", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "notient-lockfs-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("round-trips a lock through a directory it creates itself", async () => {
    const fs = createNodeLockFs();
    // The daemon lock lives at ~/.notient/<vault-id>/daemon.lock, which may
    // not exist yet on a first boot.
    const path = join(root, "vault-id", "daemon.lock");
    expect(await fs.exists(path)).toBe(false);
    await fs.writeBinary(path, new TextEncoder().encode('{"instanceId":"a","timestamp":1}').buffer);
    expect(await fs.exists(path)).toBe(true);
    expect(JSON.parse(await fs.read(path))).toEqual({ instanceId: "a", timestamp: 1 });
    await fs.remove(path);
    expect(await fs.exists(path)).toBe(false);
  });

  test("remove is silent when the file is already gone", async () => {
    const fs = createNodeLockFs();
    await fs.remove(join(root, "absent.lock"));
    expect(await fs.exists(join(root, "absent.lock"))).toBe(false);
  });

  test("drives a real VaultLock acquire/release cycle", async () => {
    const path = join(root, "daemon.lock");
    const lock = new VaultLock(createNodeLockFs(), path, "instance-A", clock(1000));
    const handle = await lock.acquire();
    expect(await createNodeLockFs().exists(path)).toBe(true);
    await handle.release();
    expect(await createNodeLockFs().exists(path)).toBe(false);
  });
});
