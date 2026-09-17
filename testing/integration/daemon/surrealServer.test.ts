import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureFreshSurrealProof,
  parseBoundPort,
  parseSurrealVersion,
  startSurreal,
  stopStaleSurrealProcess,
} from "../../../src/daemon/surrealServer";

const spawnedPids = new Set<number>();
const linuxTest = process.platform === "linux" ? test : test.skip;

afterEach(async () => {
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  spawnedPids.clear();
});

describe("stopStaleSurrealProcess", () => {
  linuxTest("terminates a pid recorded by a stale per-vault server handoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-stale-surreal-"));
    const dataDir = join(root, "data");
    const pidFile = join(root, "surreal.pid");
    const portFile = join(root, "surreal.port");
    const handle = await startSurreal({
      dataDir,
      secret: "integration-stale-surreal-secret",
      portFile,
      pidFile,
      logLevel: "none",
      hnswCacheMib: 64,
    });
    try {
      await stopStaleSurrealProcess({ dataDir, pidFile, portFile });
      await waitUntil(() => !processIsAlive(handle.pid), 3_000);
      await expect(stat(pidFile)).rejects.toThrow();
      await expect(stat(portFile)).rejects.toThrow();
    } finally {
      await handle.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes stale handoff files when the recorded process is already gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-stale-surreal-"));
    const dataDir = join(root, "data");
    const pidFile = join(root, "surreal.pid");
    const portFile = join(root, "surreal.port");
    await mkdir(dataDir);
    await writeFile(
      pidFile,
      `${JSON.stringify({
        format: "notient-surreal-process",
        version: 2,
        state: "running",
        instanceId: randomUUID(),
        dataDir,
        expectedExecutable: "/usr/bin/surreal",
        pid: 99_999_999,
        port: 45_678,
        proof: { kind: "unavailable", executable: "/usr/bin/surreal" },
      })}\n`,
      "utf8",
    );
    await writeFile(portFile, "45678\n", "utf8");

    await stopStaleSurrealProcess({ dataDir, pidFile, portFile });

    await expect(readFile(pidFile, "utf8")).rejects.toThrow();
    await expect(readFile(portFile, "utf8")).rejects.toThrow();
    await rm(root, { recursive: true, force: true });
  });

  test("never signals an unrelated live process named by a forged ownership record", async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-unrelated-surreal-pid-"));
    const dataDir = join(root, "data");
    const pidFile = join(root, "surreal.pid");
    const portFile = join(root, "surreal.port");
    await mkdir(dataDir);
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    spawnedPids.add(child.pid);
    await writeFile(
      pidFile,
      `${JSON.stringify({
        format: "notient-surreal-process",
        version: 2,
        state: "running",
        instanceId: randomUUID(),
        dataDir,
        expectedExecutable: "/usr/bin/surreal",
        pid: child.pid,
        port: 45_678,
        proof: {
          kind: "linux-procfs",
          bootId: "forged-boot-generation",
          processStartTicks: "1",
          executable: "/usr/bin/surreal",
        },
      })}\n`,
      "utf8",
    );
    await writeFile(portFile, "45678\n", "utf8");

    try {
      await expect(stopStaleSurrealProcess({ dataDir, pidFile, portFile })).rejects.toThrow(
        "refusing to signal it",
      );
      expect(processIsAlive(child.pid)).toBe(true);
      expect(await stat(pidFile)).toBeDefined();
      expect(await stat(portFile)).toBeDefined();
    } finally {
      process.kill(child.pid, "SIGKILL");
      spawnedPids.delete(child.pid);
      await child.exited;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects legacy or corrupt pid files without treating their integers as signal targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-invalid-surreal-pid-"));
    const dataDir = join(root, "data");
    const pidFile = join(root, "surreal.pid");
    const portFile = join(root, "surreal.port");
    await mkdir(dataDir);
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    spawnedPids.add(child.pid);
    await writeFile(pidFile, `${child.pid}\n`, "utf8");

    try {
      await expect(stopStaleSurrealProcess({ dataDir, pidFile, portFile })).rejects.toThrow(
        "record is not an object",
      );
      expect(processIsAlive(child.pid)).toBe(true);
    } finally {
      process.kill(child.pid, "SIGKILL");
      spawnedPids.delete(child.pid);
      await child.exited;
      await rm(root, { recursive: true, force: true });
    }
  });

  linuxTest(
    "clears a crash-left starting record only after its Linux owner and child are absent",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "notient-abandoned-surreal-start-"));
      const dataDir = join(root, "data");
      const pidFile = join(root, "surreal.pid");
      const portFile = join(root, "surreal.port");
      await mkdir(dataDir);
      await writeFile(
        pidFile,
        `${JSON.stringify({
          format: "notient-surreal-process",
          version: 2,
          state: "starting",
          instanceId: randomUUID(),
          dataDir,
          expectedExecutable: "/usr/bin/surreal",
          port: 45_678,
          ownerPid: 99_999_999,
          ownerProof: {
            kind: "linux-procfs",
            bootId: "dead-owner-boot",
            processStartTicks: "1",
            executable: "/usr/bin/bun",
          },
        })}\n`,
        "utf8",
      );
      await writeFile(portFile, "45678\n", "utf8");

      await stopStaleSurrealProcess({ dataDir, pidFile, portFile });

      await expect(stat(pidFile)).rejects.toThrow();
      await expect(stat(portFile)).rejects.toThrow();
      await rm(root, { recursive: true, force: true });
    },
  );

  linuxTest(
    "does not clear a starting record whose exact owner generation is still alive",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "notient-live-surreal-start-"));
      const dataDir = join(root, "data");
      const pidFile = join(root, "surreal.pid");
      const portFile = join(root, "surreal.port");
      await mkdir(dataDir);
      const ownerProof = await captureFreshSurrealProof(process.pid, process.execPath, "linux");
      await writeFile(
        pidFile,
        `${JSON.stringify({
          format: "notient-surreal-process",
          version: 2,
          state: "starting",
          instanceId: randomUUID(),
          dataDir,
          expectedExecutable: "/usr/bin/surreal",
          port: 45_678,
          ownerPid: process.pid,
          ownerProof,
        })}\n`,
        "utf8",
      );

      try {
        await expect(stopStaleSurrealProcess({ dataDir, pidFile, portFile })).rejects.toThrow(
          "still owns SurrealDB startup",
        );
        expect(await stat(pidFile)).toBeDefined();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe("startSurreal exit ownership", () => {
  test("reports one unexpected child exit without attempting an in-handle restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-surreal-exit-"));
    const exits: Array<number | null> = [];
    const handle = await startSurreal({
      dataDir: join(root, "data"),
      secret: "integration-surreal-exit-secret",
      portFile: join(root, "surreal.port"),
      pidFile: join(root, "surreal.pid"),
      logLevel: "none",
      hnswCacheMib: 64,
      onUnexpectedExit: (code) => exits.push(code),
    });
    try {
      process.kill(handle.pid, "SIGKILL");
      await waitUntil(() => exits.length === 1, 3_000);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(exits).toHaveLength(1);
      expect(exits[0]).not.toBe(0);
    } finally {
      await handle.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for SurrealDB child exit");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
