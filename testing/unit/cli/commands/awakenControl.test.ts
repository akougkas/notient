import { describe, expect, test } from "bun:test";
import type { ClientHandle, RpcResponseFrame } from "../../../../src/cli/client";
import { runAwakenCancel } from "../../../../src/cli/commands/awakenCancel";
import { runAwakenPause } from "../../../../src/cli/commands/awakenPause";
import { runAwakenResume } from "../../../../src/cli/commands/awakenResume";
import { createUuidRecordId } from "../../../../src/core/db/recordId";

const RUN_ID = createUuidRecordId("awaken_run", "018f05cd-3f7b-7000-8000-000000000001").toString();

function harness(
  frames: RpcResponseFrame[],
  closeError?: Error,
): {
  client: ClientHandle;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      principal: { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
      call(method, params) {
        calls.push({ method, params });
        return (async function* () {
          if (frames[0]?.type !== "ack") {
            yield { id: frames[0]?.id ?? "req-1", type: "ack", method };
          }
          for (const frame of frames) yield frame;
        })();
      },
      close: async () => {
        if (closeError !== undefined) throw closeError;
      },
    },
  };
}

function resultFrame(
  method: "pause" | "resume" | "cancel",
  extra: Record<string, unknown> = {},
): RpcResponseFrame {
  const status = method === "pause" ? "paused" : method === "cancel" ? "cancelled" : "running";
  return {
    id: "req-1",
    type: "result",
    ok: true,
    runId: RUN_ID,
    processed: 2,
    failed: 1,
    total: 5,
    status,
    ...(method === "resume" ? {} : { draining: true }),
    ...extra,
  };
}

describe("awaken control CLI wire boundary", () => {
  test("renders each operation-specific exact result", async () => {
    const cases = [
      { verb: "pause" as const, run: runAwakenPause, outputType: "awaken:paused" },
      { verb: "resume" as const, run: runAwakenResume, outputType: "awaken:resumed" },
      { verb: "cancel" as const, run: runAwakenCancel, outputType: "awaken:cancelled" },
    ];
    for (const entry of cases) {
      const rpc = harness([
        { id: "req-1", type: "ack", method: `awaken.${entry.verb}` },
        resultFrame(entry.verb),
      ]);
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await entry.run({
        vaultPath: "/vault",
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
        connect: async () => rpc.client,
      });
      expect(code).toBe(0);
      expect(stderr).toEqual([]);
      expect(rpc.calls).toEqual([{ method: `awaken.${entry.verb}`, params: {} }]);
      expect(JSON.parse(stdout[0] ?? "")).toMatchObject({
        type: entry.outputType,
        runId: RUN_ID,
        processed: 2,
        failed: 1,
        total: 5,
      });
    }
  });

  test("rejects missing, extra, and inconsistent counters", async () => {
    for (const frame of [
      resultFrame("pause", { legacyStatus: "paused" }),
      { ...resultFrame("pause"), draining: undefined },
      { ...resultFrame("pause"), processed: 5, failed: 1 },
    ]) {
      const rpc = harness([frame]);
      const stdout: string[] = [];
      const stderr: string[] = [];
      expect(
        await runAwakenPause({
          vaultPath: "/vault",
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
          connect: async () => rpc.client,
        }),
      ).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr[0]).toContain("malformed response");
    }
  });

  test("rejects duplicate terminal frames and a stream with no result", async () => {
    const duplicate = harness([resultFrame("resume"), resultFrame("resume")]);
    const duplicateStderr: string[] = [];
    expect(
      await runAwakenResume({
        vaultPath: "/vault",
        stderr: (line) => duplicateStderr.push(line),
        connect: async () => duplicate.client,
      }),
    ).toBe(1);
    expect(duplicateStderr[0]).toContain("duplicate terminal");

    const empty = harness([]);
    const emptyStderr: string[] = [];
    expect(
      await runAwakenCancel({
        vaultPath: "/vault",
        stderr: (line) => emptyStderr.push(line),
        connect: async () => empty.client,
      }),
    ).toBe(1);
    expect(emptyStderr[0]).toContain("returned no result");
  });

  test("surfaces exact RPC errors and does not print success", async () => {
    const rpc = harness([
      {
        id: "req-1",
        type: "error",
        code: "INVALID_PARAMS",
        message: "nothing to pause",
        detail: {},
      },
    ]);
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(
      await runAwakenPause({
        vaultPath: "/vault",
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
        connect: async () => rpc.client,
      }),
    ).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr[0]).toContain("INVALID_PARAMS: nothing to pause");
  });

  test("a close failure prevents a successful control frame", async () => {
    const rpc = harness([resultFrame("cancel")], new Error("close refused"));
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(
      await runAwakenCancel({
        vaultPath: "/vault",
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
        connect: async () => rpc.client,
      }),
    ).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr[0]).toContain("connection close failed");
  });
});
