import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type ClientHandle, connectClient } from "../../../../src/cli/client";
import { vaultDaemonPidPath, vaultStateDir } from "../../../../src/core/vault/identity";
import { isProcessAlive } from "../../../../src/daemon/lifecycle";
import { currentPlatform, resolveSocketPath } from "../../../../src/daemon/socket";
import { daemonResult, startTestDaemon } from "../../../daemonHarness";

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] explicit CLI start recovers immediately after a graceful stop without competing owners",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-cli-restart-"));
    let initial: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    let client: ClientHandle | undefined;
    const pids = new Set<number>();
    const waitExit = async (pid: number) => {
      const deadline = performance.now() + 15000;
      while (isProcessAlive(pid)) {
        if (performance.now() > deadline) throw new Error("Owner did not finish shutdown");
        await Bun.sleep(40);
      }
    };
    try {
      await Bun.write(join(root, "Thought.md"), "My thought survives restarting.\n");
      initial = await startTestDaemon(root);
      const command = async (verb: string) => {
        const process = Bun.spawn(
          [
            globalThis.process.execPath,
            resolve("src/cli/index.ts"),
            "daemon",
            verb,
            "--vault",
            root,
            "--json",
          ],
          { env: initial!.env, stdout: "pipe", stderr: "pipe" },
        );
        const output = await new Response(process.stdout).text();
        const error = await new Response(process.stderr).text();
        expect(await process.exited, `${output}\n${error}`).toBe(0);
        const frames = output
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        for (const frame of frames) if (frame.type === "daemon:start_spawned") pids.add(frame.pid);
        return frames;
      };
      client = initial.client;
      for (let cycle = 0; cycle < 2; cycle++) {
        const old = await Bun.file(vaultDaemonPidPath(root)).json();
        pids.add(old.pid);
        await client.close();
        client = undefined;
        await command("stop");
        const observed = await command("start");
        expect(observed[0].type).toMatch(
          /^daemon:(start_spawned|start_in_progress|already_running)$/,
        );
        await waitExit(old.pid);
        // A still-stopping owner is an explicit advisory; once it exits an
        // explicit start may proceed, with the lock remaining authoritative.
        if (observed[0].type !== "daemon:start_spawned") await command("start");
        const deadline = performance.now() + 20000;
        while (!client) {
          try {
            client = await connectClient({
              vaultPath: root,
              socketPath: resolveSocketPath(root, currentPlatform()),
              autoSpawn: false,
              spawnTimeoutMs: 1000,
            });
          } catch (error) {
            if (performance.now() > deadline) throw error;
            await Bun.sleep(50);
          }
        }
        const current = await Bun.file(vaultDaemonPidPath(root)).json();
        pids.add(current.pid);
        expect(current.pid).not.toBe(old.pid);
        const read = await daemonResult(client, "notes.read", { path: "Thought.md" });
        expect(read.body).toBe("My thought survives restarting.\n");
      }
      await daemonResult(client, "daemon.shutdown");
      await client.close();
      client = undefined;
      for (const pid of pids) await waitExit(pid);
    } finally {
      await client?.close();
      // Test-owned processes only; failed startup must not outlive its fixture.
      for (const pid of pids) if (isProcessAlive(pid)) process.kill(pid, "SIGTERM");
      if (initial) await initial.stop();
      for (const pid of pids) await waitExit(pid);
      await rm(vaultStateDir(root), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);
