import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PidRecord,
  claimPidFile,
  inspectPidFile,
  removeOwnedPidFile,
} from "../../../src/daemon/lifecycle";
import { acquireDaemonOwnership } from "../../../src/daemon/ownership";

describe("daemon ownership", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "notient-ownership-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function paths(): { pidPath: string; lockPath: string; socketPath: string } {
    return {
      pidPath: join(root, "daemon.pid"),
      lockPath: join(root, "daemon.lock"),
      socketPath: join(root, "notient.sock"),
    };
  }

  function record(overrides: Partial<PidRecord> = {}): PidRecord {
    return {
      pid: process.pid,
      socketPath: paths().socketPath,
      vault: root,
      startedAt: 100,
      instanceId: "owner-a",
      version: "0.1.0-alpha",
      booting: true,
      ...overrides,
    };
  }

  test("publishes boot intent and lock with one instance id", async () => {
    const target = paths();
    const ownership = await acquireDaemonOwnership({
      record: record(),
      pidPath: target.pidPath,
      lockPath: target.lockPath,
      socketAccepts: async () => false,
    });

    expect(await inspectPidFile(target.pidPath)).toEqual({
      kind: "record",
      record: record(),
    });
    expect(JSON.parse(await readFile(target.lockPath, "utf-8"))).toMatchObject({
      instanceId: "owner-a",
    });

    await ownership.lockHandle.release();
    await removeOwnedPidFile(target.pidPath, "owner-a");
  });

  test("a live pid blocks startup even when the socket is absent", async () => {
    const target = paths();
    const foreign = record({ pid: 404, instanceId: "owner-foreign" });
    await claimPidFile(target.pidPath, foreign);
    const lockBytes = JSON.stringify({ instanceId: "owner-foreign", timestamp: 50 });
    await writeFile(target.lockPath, lockBytes, "utf-8");

    await expect(
      acquireDaemonOwnership({
        record: record({ pid: 505 }),
        pidPath: target.pidPath,
        lockPath: target.lockPath,
        currentPid: 505,
        processAlive: (pid) => pid === 404,
        socketAccepts: async () => false,
      }),
    ).rejects.toThrow(/already owns vault/);

    expect(await inspectPidFile(target.pidPath)).toEqual({ kind: "record", record: foreign });
    expect(await readFile(target.lockPath, "utf-8")).toBe(lockBytes);
  });

  test("an invalid pid record fails closed without touching other artifacts", async () => {
    const target = paths();
    await writeFile(target.pidPath, '{"pid":404}', "utf-8");
    await writeFile(target.lockPath, "sentinel-lock", "utf-8");
    await writeFile(target.socketPath, "sentinel-socket", "utf-8");

    await expect(
      acquireDaemonOwnership({
        record: record(),
        pidPath: target.pidPath,
        lockPath: target.lockPath,
        socketAccepts: async () => false,
      }),
    ).rejects.toThrow(/invalid daemon record/);

    expect(await readFile(target.pidPath, "utf-8")).toBe('{"pid":404}');
    expect(await readFile(target.lockPath, "utf-8")).toBe("sentinel-lock");
    expect(await readFile(target.socketPath, "utf-8")).toBe("sentinel-socket");
  });
});
