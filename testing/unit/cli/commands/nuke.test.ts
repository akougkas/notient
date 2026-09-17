import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { DaemonStartHook, DaemonStopHook } from "../../../../src/cli/commands/daemonControl";
import { runNukeCommand } from "../../../../src/cli/commands/nuke";
import { makeEmitter } from "../../../../src/cli/output";
import { vaultDataDir, vaultRestoreQuarantinePath } from "../../../../src/core/vault/identity";
import { armRestoreQuarantine } from "../../../../src/core/vault/restoreQuarantine";

describe("notient nuke CLI", () => {
  let root: string;
  let originalHome: string | undefined;
  let vaultPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "notient-nuke-"));
    originalHome = process.env.HOME;
    process.env.HOME = join(root, "home");
    vaultPath = join(root, "vault");
    await mkdir(vaultPath, { recursive: true });
    await mkdir(vaultDataDir(vaultPath), { recursive: true });
    await writeFile(join(vaultDataDir(vaultPath), "old.db"), "old rows");
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      process.env.HOME = undefined;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(root, { recursive: true, force: true });
  });

  test("with --yes stops, wipes the data dir, restarts, and emits success", async () => {
    const calls: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const stopDaemon: DaemonStopHook = async () => {
      calls.push("stop");
    };
    const startDaemon: DaemonStartHook = async () => {
      calls.push("start");
      await expect(stat(vaultRestoreQuarantinePath(vaultPath))).rejects.toThrow();
      await mkdir(vaultDataDir(vaultPath), { recursive: true });
    };
    await armRestoreQuarantine(vaultPath);

    const exitCode = await runNukeCommand({
      vaultPath,
      yes: true,
      emitter: makeEmitter({
        mode: "json",
        write: (line) => events.push(JSON.parse(line) as Record<string, unknown>),
      }),
      stopDaemon,
      startDaemon,
    });

    expect(exitCode).toBe(0);
    expect(calls).toEqual(["stop", "start"]);
    expect(events[0]).toMatchObject({ type: "nuke-success", dataDir: vaultDataDir(vaultPath) });
    const dataDir = await stat(vaultDataDir(vaultPath));
    expect(dataDir.isDirectory()).toBe(true);
  });

  test("with --yes is idempotent when the data dir is already gone", async () => {
    await rm(vaultDataDir(vaultPath), { recursive: true, force: true });
    const startDaemon: DaemonStartHook = async () => {
      await mkdir(vaultDataDir(vaultPath), { recursive: true });
    };

    const exitCode = await runNukeCommand({
      vaultPath,
      yes: true,
      emitter: makeEmitter({ mode: "json", write: () => {} }),
      stopDaemon: async () => {},
      startDaemon,
    });

    expect(exitCode).toBe(0);
    const dataDir = await stat(vaultDataDir(vaultPath));
    expect(dataDir.isDirectory()).toBe(true);
  });

  test("without --yes refuses non-TTY stdin before stopping or wiping", async () => {
    const fakeStdin = Object.assign(Readable.from([]), {
      isTTY: false,
    }) as NodeJS.ReadableStream & {
      isTTY?: boolean;
    };
    let stopped = false;
    let started = false;

    const exitCode = await runNukeCommand({
      vaultPath,
      yes: false,
      emitter: makeEmitter({ mode: "json", write: () => {} }),
      stdin: fakeStdin,
      stopDaemon: async () => {
        stopped = true;
      },
      startDaemon: async () => {
        started = true;
      },
    });

    expect(exitCode).toBe(2);
    expect(stopped).toBe(false);
    expect(started).toBe(false);
    const dataDir = await stat(vaultDataDir(vaultPath));
    expect(dataDir.isDirectory()).toBe(true);
  });
});
