import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IdleExitTimer,
  type PidRecord,
  claimPidFile,
  inspectPidFile,
  isProcessAlive,
  listDaemonPidFiles,
  removeOwnedPidFile,
  updateOwnedPidFile,
} from "../../../src/daemon/lifecycle";

describe("IdleExitTimer", () => {
  test("fires after idleMs with no markActive", async () => {
    let fired = false;
    const timer = new IdleExitTimer({
      idleMs: 30,
      onIdleExit: () => {
        fired = true;
      },
    });
    timer.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fired).toBe(true);
    timer.stop();
  });

  test("markActive resets the deadline", async () => {
    let fired = false;
    const timer = new IdleExitTimer({
      idleMs: 50,
      onIdleExit: () => {
        fired = true;
      },
    });
    timer.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    timer.markActive();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fired).toBe(false);
    timer.stop();
  });

  test("isBusy vetoes the exit and rearms the deadline", async () => {
    let fired = false;
    let busy = true;
    const timer = new IdleExitTimer({
      idleMs: 20,
      onIdleExit: () => {
        fired = true;
      },
      isBusy: () => busy,
    });
    timer.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fired).toBe(false);
    busy = false;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fired).toBe(true);
    timer.stop();
  });
});

describe("PID file", () => {
  let root: string;

  function record(overrides: Partial<PidRecord> = {}): PidRecord {
    return {
      pid: 1234,
      instanceId: "instance-a",
      socketPath: "/tmp/sock",
      vault: "/vaults/notes",
      startedAt: 1000,
      version: "0.1.0-alpha",
      booting: true,
      ...overrides,
    };
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "notient-pid-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("claim creates a complete boot record at the path", async () => {
    const path = join(root, "daemon.pid");
    expect(await claimPidFile(path, record())).toBe(true);
    const raw = await readFile(path, "utf-8");
    expect(JSON.parse(raw)).toEqual(record());
  });

  test("claim is exclusive and creates the parent directory", async () => {
    const path = join(root, "nested", "vault-id", "daemon.pid");
    expect(await claimPidFile(path, record({ pid: 7 }))).toBe(true);
    expect(await claimPidFile(path, record({ pid: 8, instanceId: "instance-b" }))).toBe(false);
    expect(await inspectPidFile(path)).toEqual({
      kind: "record",
      record: record({ pid: 7 }),
    });
  });

  test("ready publication and removal require the current instance id", async () => {
    const path = join(root, "daemon.pid");
    await claimPidFile(path, record());
    await expect(
      updateOwnedPidFile(path, record({ instanceId: "instance-b", booting: false })),
    ).rejects.toThrow(/ownership lost/);
    await removeOwnedPidFile(path, "instance-b");
    expect((await inspectPidFile(path)).kind).toBe("record");

    await updateOwnedPidFile(path, record({ booting: false }));
    expect(await inspectPidFile(path)).toEqual({
      kind: "record",
      record: record({ booting: false }),
    });
    await removeOwnedPidFile(path, "instance-a");
    let exists = true;
    try {
      await stat(path);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  test("inspection distinguishes missing, malformed, and incomplete records", async () => {
    expect(await inspectPidFile(join(root, "missing.pid"))).toEqual({ kind: "missing" });
    const garbage = join(root, "garbage.pid");
    await writeFile(garbage, "not json", "utf-8");
    expect(await inspectPidFile(garbage)).toMatchObject({
      kind: "invalid",
      pid: null,
      reason: "pid file is not valid JSON",
    });
    const partial = join(root, "partial.pid");
    await writeFile(partial, JSON.stringify({ pid: 5 }), "utf-8");
    expect(await inspectPidFile(partial)).toMatchObject({
      kind: "invalid",
      pid: 5,
    });
  });

  test("isProcessAlive is true for this process and false for pid 0", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });

  test("listDaemonPidFiles reports each vault dir with a liveness flag", async () => {
    await claimPidFile(
      join(root, "aaaa", "daemon.pid"),
      record({ pid: process.pid, socketPath: "/tmp/a.sock", vault: "/vaults/a" }),
    );
    // A pid that cannot be alive: 2^22 is above the default pid_max.
    await claimPidFile(
      join(root, "bbbb", "daemon.pid"),
      record({ pid: 4_194_303, socketPath: "/tmp/b.sock", vault: "/vaults/b" }),
    );
    const entries = await listDaemonPidFiles(root);
    expect(entries.map((entry) => entry.vaultId)).toEqual(["aaaa", "bbbb"]);
    expect(entries[0]?.alive).toBe(true);
    expect(entries[1]?.alive).toBe(false);
  });

  test("listDaemonPidFiles returns an empty list when the root is absent", async () => {
    expect(await listDaemonPidFiles(join(root, "nope"))).toEqual([]);
  });
});
