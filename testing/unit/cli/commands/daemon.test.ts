import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DaemonConnectionTimeoutError } from "../../../../src/cli/client";
import {
  renderDaemonAlreadyRunningFrame,
  renderDaemonStatusFrame,
  runDaemonCommand,
} from "../../../../src/cli/commands/daemon";
import { currentIndexingFixture } from "../../../indexingFixture";

describe("renderDaemonStatusFrame", () => {
  test("surfaces model mismatch details at the top level", () => {
    const event = renderDaemonStatusFrame({
      id: "req-1",
      type: "result",
      ok: true,
      indexing: currentIndexingFixture(),
      probe: {
        status: "mismatch",
        configuredModel: "configured-model",
        loadedModel: "loaded-model",
        message: "model mismatch: configured configured-model; loaded model loaded-model",
      },
    });

    expect(event.type).toBe("rpc:result");
    expect(event.modelStatus).toBe("mismatch");
    expect(event.configuredModel).toBe("configured-model");
    expect(event.loadedModel).toBe("loaded-model");
    expect(event.modelWarning).toBe(
      "model mismatch: configured configured-model; loaded model loaded-model",
    );
  });

  test("renders matching models without a warning field", () => {
    const event = renderDaemonStatusFrame({
      id: "req-1",
      type: "result",
      ok: true,
      indexing: currentIndexingFixture(),
      probe: {
        status: "ok",
        configuredModel: "configured-model",
        loadedModel: "configured-model",
        message: "configured model configured-model is loaded",
      },
    });

    expect(event.modelStatus).toBe("ok");
    expect(event.configuredModel).toBe("configured-model");
    expect(event.loadedModel).toBe("configured-model");
    expect(event.modelWarning).toBeUndefined();
  });

  test("renders an existing status result as already-running", () => {
    const event = renderDaemonAlreadyRunningFrame({
      id: "req-1",
      type: "result",
      ok: true,
      vault: "/tmp/vault",
      pid: 1234,
      indexing: currentIndexingFixture(),
      probe: {
        status: "ok",
        configuredModel: "configured-model",
        loadedModel: "configured-model",
        message: "configured model configured-model is loaded",
      },
    });

    expect(event).toMatchObject({
      type: "daemon:already_running",
      ok: true,
      vault: "/tmp/vault",
      pid: 1234,
      modelStatus: "ok",
    });
    expect(event.id).toBeUndefined();
  });
});

describe("runDaemonCommand start", () => {
  let savedBaseUrl: string | undefined;
  beforeEach(() => {
    savedBaseUrl = process.env.NOTIENT_LLM_BASE_URL;
    // Process deployment must not make lifecycle unit tests contact a real model.
    process.env.NOTIENT_LLM_BASE_URL = "";
  });
  afterEach(() => {
    if (savedBaseUrl === undefined) Reflect.deleteProperty(process.env, "NOTIENT_LLM_BASE_URL");
    else process.env.NOTIENT_LLM_BASE_URL = savedBaseUrl;
  });
  test("does not spawn when a daemon already answers status", async () => {
    const events: Record<string, unknown>[] = [];
    let spawnCalls = 0;

    await runDaemonCommand({
      verb: "start",
      vaultPath: "/tmp/vault",
      clientIdentity: "codex",
      emitter: { emit: (event) => events.push(event) },
      startProbe: async (args) => {
        expect(args.vaultPath).toBe("/tmp/vault");
        expect(args.clientIdentity).toBe("codex");
        expect(args.socketPath).toContain("notient.sock");
        return {
          state: "reachable",
          frame: {
            type: "result",
            ok: true,
            vault: "/tmp/vault",
            pid: 1234,
            sealed: true,
            indexing: currentIndexingFixture(),
            probe: {
              status: "ok",
              configuredModel: "configured-model",
              loadedModel: "configured-model",
              message: "configured model configured-model is loaded",
            },
          },
        };
      },
      spawnDaemon: () => {
        spawnCalls++;
        return { pid: 9999, unref: () => undefined };
      },
    });

    expect(spawnCalls).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "daemon:already_running",
      ok: true,
      vault: "/tmp/vault",
      pid: 1234,
      sealed: true,
      modelStatus: "ok",
    });
  });

  test("starting local operation does not probe or require an inference catalog", async () => {
    process.env.NOTIENT_LLM_BASE_URL = "http://127.0.0.1:1/v1";
    const started = performance.now();
    let spawned = false;
    await runDaemonCommand({
      verb: "start",
      vaultPath: "/tmp/vault",
      emitter: { emit: () => {} },
      startProbe: async () => ({ state: "absent" }),
      spawnDaemon: () => {
        spawned = true;
        return { pid: 4321, unref: () => {} };
      },
    });
    expect(spawned).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });
  test("spawns once when no daemon answers status", async () => {
    const events: Record<string, unknown>[] = [];
    let spawnVaultPath = "";
    let unrefCalls = 0;

    await runDaemonCommand({
      verb: "start",
      vaultPath: "/tmp/vault",
      emitter: { emit: (event) => events.push(event) },
      startProbe: async () => ({ state: "absent" }),
      spawnDaemon: (vaultPath) => {
        spawnVaultPath = vaultPath;
        return {
          pid: 4321,
          unref: () => {
            unrefCalls++;
          },
        };
      },
    });

    expect(spawnVaultPath).toBe("/tmp/vault");
    expect(unrefCalls).toBe(1);
    expect(events).toEqual([{ type: "daemon:start_spawned", pid: 4321 }]);
  });

  test("the final ownership probe observes a daemon started before spawning", async () => {
    const events: Record<string, unknown>[] = [];
    let probes = 0;
    let spawnCalls = 0;

    await runDaemonCommand({
      verb: "start",
      vaultPath: "/tmp/vault",
      emitter: { emit: (event) => events.push(event) },
      startProbe: async () => {
        probes++;
        if (probes === 1) return { state: "absent" };
        return {
          state: "reachable",
          frame: { type: "result", ok: true, vault: "/tmp/vault", pid: 2222 },
        };
      },
      spawnDaemon: () => {
        spawnCalls++;
        return { pid: 9999, unref: () => undefined };
      },
    });

    expect(probes).toBe(2);
    expect(spawnCalls).toBe(0);
    expect(events).toEqual([
      { type: "daemon:already_running", ok: true, vault: "/tmp/vault", pid: 2222 },
    ]);
  });

  test("an absent socket inside a completed ownership timeout permits explicit start", async () => {
    const events: Record<string, unknown>[] = [];
    let spawned = 0;
    await runDaemonCommand({
      verb: "start",
      vaultPath: `/tmp/notient-probe-${crypto.randomUUID()}`,
      emitter: { emit: (event) => events.push(event) },
      connect: async () => {
        throw new DaemonConnectionTimeoutError(
          250,
          Object.assign(new Error("socket gone"), { code: "ENOENT" }),
          null,
        );
      },
      spawnDaemon: () => {
        spawned++;
        return { pid: 123, unref: () => {} };
      },
    });
    expect(spawned).toBe(1);
    expect(events).toEqual([{ type: "daemon:start_spawned", pid: 123 }]);
  });

  test("a captured owner without a pid file remains protected while alive", async () => {
    let spawned = 0;
    const failure = new DaemonConnectionTimeoutError(
      250,
      Object.assign(new Error("socket gone"), { code: "ENOENT" }),
      process.pid,
    );
    await expect(
      runDaemonCommand({
        verb: "start",
        vaultPath: `/tmp/notient-probe-${crypto.randomUUID()}`,
        emitter: { emit: () => {} },
        connect: async () => {
          throw failure;
        },
        spawnDaemon: () => {
          spawned++;
          return { pid: 123, unref: () => {} };
        },
      }),
    ).rejects.toBe(failure);
    expect(spawned).toBe(0);
  });

  test("reports a boot owner without probing models or spawning", async () => {
    const events: Record<string, unknown>[] = [];
    let spawnCalls = 0;
    await runDaemonCommand({
      verb: "start",
      vaultPath: "/tmp/vault",
      emitter: { emit: (event) => events.push(event) },
      startProbe: async () => ({
        state: "owned",
        owner: {
          pid: 3141,
          socketPath: "/tmp/notient.sock",
          vault: "/tmp/vault",
          startedAt: 100,
          instanceId: "boot-owner",
          version: "0.1.0-alpha",
          booting: true,
        },
      }),
      spawnDaemon: () => {
        spawnCalls++;
        return { pid: 9999, unref: () => undefined };
      },
    });

    expect(spawnCalls).toBe(0);
    expect(events).toEqual([
      {
        type: "daemon:start_in_progress",
        state: "booting",
        vault: "/tmp/vault",
        pid: 3141,
        instanceId: "boot-owner",
        socketPath: "/tmp/notient.sock",
        startedAt: 100,
      },
    ]);
  });
});

describe("runDaemonCommand stop", () => {
  test("an absent daemon is already stopped and is never spawned", async () => {
    const events: Record<string, unknown>[] = [];
    await runDaemonCommand({
      verb: "stop",
      vaultPath: "/tmp/vault",
      emitter: { emit: (event) => events.push(event) },
      connect: async (options) => {
        expect(options.autoSpawn).toBe(false);
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    });

    expect(events).toEqual([{ type: "daemon:already_stopped", vault: "/tmp/vault" }]);
  });
});
