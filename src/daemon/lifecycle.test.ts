import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdleExitTimer, removePidFile, writePidFile } from "./lifecycle";

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
});

describe("PID file", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "notient-pid-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("write creates a JSON record at the path", async () => {
    const path = join(root, "notient.lock");
    await writePidFile(path, {
      pid: 1234,
      instanceId: "abc",
      socketPath: "/tmp/sock",
      startedAt: 1000,
      version: "0.1.0",
    });
    const raw = await readFile(path, "utf-8");
    expect(JSON.parse(raw)).toEqual({
      pid: 1234,
      instanceId: "abc",
      socketPath: "/tmp/sock",
      startedAt: 1000,
      version: "0.1.0",
    });
  });

  test("remove deletes the file silently when missing", async () => {
    await removePidFile(join(root, "missing.lock"));
    expect(true).toBe(true);
  });

  test("remove deletes the file when present", async () => {
    const path = join(root, "notient.lock");
    await writePidFile(path, {
      pid: 1,
      instanceId: "x",
      socketPath: "/tmp/sock",
      startedAt: 0,
      version: "0",
    });
    await removePidFile(path);
    let exists = true;
    try {
      await stat(path);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });
});
