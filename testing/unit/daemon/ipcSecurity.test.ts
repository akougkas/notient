import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPrivateDirectory,
  secureDaemonSocket,
  secureDaemonStateTree,
} from "../../../src/daemon/ipcSecurity";

describe("daemon IPC filesystem confinement", () => {
  test("creates exact mode-0700 state directories under a permissive umask", async () => {
    if (process.platform === "win32") return;
    const base = await mkdtemp(join(tmpdir(), "notient-ipc-umask-"));
    const stateDir = join(base, ".notient", "vault-id");
    const previousUmask = process.umask(0);
    try {
      await secureDaemonStateTree(stateDir);
    } finally {
      process.umask(previousUmask);
    }
    try {
      expect((await stat(join(base, ".notient"))).mode & 0o7777).toBe(0o700);
      expect((await stat(stateDir)).mode & 0o7777).toBe(0o700);
      await assertPrivateDirectory(stateDir);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("repairs readable existing modes and rejects writable or symlinked state roots", async () => {
    if (process.platform === "win32") return;
    const base = await mkdtemp(join(tmpdir(), "notient-ipc-state-"));
    try {
      const root = join(base, ".notient");
      const stateDir = join(root, "vault-id");
      await mkdir(stateDir, { recursive: true });
      await chmod(root, 0o755);
      await chmod(stateDir, 0o711);
      await secureDaemonStateTree(stateDir);
      expect((await stat(root)).mode & 0o7777).toBe(0o700);
      expect((await stat(stateDir)).mode & 0o7777).toBe(0o700);

      const writableRoot = join(base, "writable-state");
      await mkdir(writableRoot, { mode: 0o700 });
      await chmod(writableRoot, 0o777);
      await expect(secureDaemonStateTree(join(writableRoot, "vault-id"))).rejects.toThrow(
        "may contain hostile preplants",
      );

      const linkedRoot = join(base, "linked-state");
      const outside = join(base, "outside");
      await mkdir(outside, { mode: 0o755 });
      await symlink(outside, linkedRoot);
      await expect(secureDaemonStateTree(join(linkedRoot, "vault-id"))).rejects.toThrow();
      expect((await stat(outside)).mode & 0o7777).toBe(0o755);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("establishes exact mode 0600 on the bound Unix socket", async () => {
    if (process.platform === "win32") return;
    const base = await mkdtemp(join(tmpdir(), "notient-ipc-socket-"));
    const stateDir = join(base, ".notient", "vault-id");
    const socketPath = join(stateDir, "notient.sock");
    const server = createServer();
    try {
      await secureDaemonStateTree(stateDir);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      await chmod(socketPath, 0o777);
      await secureDaemonSocket(socketPath);
      const secured = await lstat(socketPath);
      expect(secured.isSocket()).toBe(true);
      expect(secured.mode & 0o7777).toBe(0o600);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(base, { recursive: true, force: true });
    }
  });

  test("refuses a non-socket IPC preplant", async () => {
    if (process.platform === "win32") return;
    const base = await mkdtemp(join(tmpdir(), "notient-ipc-preplant-"));
    try {
      const stateDir = join(base, ".notient", "vault-id");
      const socketPath = join(stateDir, "notient.sock");
      await secureDaemonStateTree(stateDir);
      await writeFile(socketPath, "not a socket", { mode: 0o600 });
      await expect(secureDaemonSocket(socketPath)).rejects.toThrow("not a Unix socket");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
