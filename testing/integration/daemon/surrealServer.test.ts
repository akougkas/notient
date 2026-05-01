import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseBoundPort,
  parseSurrealVersion,
  stopStaleSurrealProcess,
} from "../../../src/daemon/surrealServer";

const spawnedPids = new Set<number>();

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
  test("terminates a pid recorded by a stale per-vault server handoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-stale-surreal-"));
    const pidFile = join(root, "surreal.pid");
    const portFile = join(root, "surreal.port");
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    spawnedPids.add(child.pid);
    await writeFile(pidFile, `${child.pid}\n`, "utf8");
    await writeFile(portFile, "45678\n", "utf8");

    await stopStaleSurrealProcess({ pidFile, portFile });
    spawnedPids.delete(child.pid);

    await child.exited;
    await expect(stat(pidFile)).rejects.toThrow();
    await expect(stat(portFile)).rejects.toThrow();
    await rm(root, { recursive: true, force: true });
  });

  test("removes stale handoff files when the recorded process is already gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-stale-surreal-"));
    const pidFile = join(root, "surreal.pid");
    const portFile = join(root, "surreal.port");
    await writeFile(pidFile, "99999999\n", "utf8");
    await writeFile(portFile, "45678\n", "utf8");

    await stopStaleSurrealProcess({ pidFile, portFile });

    await expect(readFile(pidFile, "utf8")).rejects.toThrow();
    await expect(readFile(portFile, "utf8")).rejects.toThrow();
    await rm(root, { recursive: true, force: true });
  });
});
