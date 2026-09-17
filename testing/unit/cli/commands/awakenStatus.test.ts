import { describe, expect, test } from "bun:test";
import type { ClientHandle, ClientOptions, RpcResponseFrame } from "../../../../src/cli/client";
import { runAwakenStatus } from "../../../../src/cli/commands/awakenStatus";
import { createUuidRecordId } from "../../../../src/core/db/recordId";

const AWAKEN_RUN_ID = createUuidRecordId(
  "awaken_run",
  "018f05cd-3f7b-7000-8000-000000000001",
).toString();

function harness(responses: RpcResponseFrame[][], closeError?: Error) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const connections: ClientOptions[] = [];
  let closed = false;
  const client: ClientHandle = {
    principal: { id: "human", kind: "human", scopes: ["read", "write", "admin"] },
    call(method, params) {
      calls.push({ method, params });
      const frames = responses.shift() ?? [];
      return (async function* () {
        if (frames[0]?.type !== "ack") {
          yield { id: frames[0]?.id ?? `req-${calls.length}`, type: "ack", method };
        }
        for (const frame of frames) yield frame;
      })();
    },
    close: async () => {
      closed = true;
      if (closeError !== undefined) throw closeError;
    },
  };
  return {
    calls,
    connections,
    closed: () => closed,
    connect: async (options: ClientOptions) => {
      connections.push(options);
      return client;
    },
  };
}

function statusResult(status: "running" | "completed", processed: number): RpcResponseFrame[] {
  return [
    {
      id: "req-1",
      type: "result",
      ok: true,
      run: {
        runId: AWAKEN_RUN_ID,
        status,
        processed,
        failed: 0,
        total: 2,
        startedAt: Date.now() - 2_000,
      },
    },
  ];
}

describe("awaken status CLI", () => {
  test("emits one none frame when the daemon has no run history", async () => {
    const rpc = harness([[{ id: "req-1", type: "result", ok: true, run: null }]]);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runAwakenStatus({
      vaultPath: "/vault",
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      clientIdentity: "operator",
      connect: rpc.connect,
    });
    expect(code).toBe(0);
    expect(stdout.map((line) => JSON.parse(line))).toEqual([
      { type: "awaken:status", status: "none" },
    ]);
    expect(stderr).toEqual([]);
    expect(rpc.calls).toEqual([{ method: "awaken.status", params: {} }]);
    expect(rpc.connections[0]?.clientIdentity).toBe("operator");
    expect(rpc.closed()).toBe(true);
  });

  test("follow mode locks every later poll to the first run id", async () => {
    const rpc = harness([statusResult("running", 1), statusResult("completed", 2)]);
    const stdout: string[] = [];
    const code = await runAwakenStatus({
      vaultPath: "/vault",
      stdout: (line) => stdout.push(line),
      stderr: () => {},
      follow: true,
      pollIntervalMs: 0,
      connect: rpc.connect,
    });
    expect(code).toBe(0);
    expect(stdout.map((line) => JSON.parse(line).status)).toEqual(["running", "completed"]);
    expect(rpc.calls).toEqual([
      { method: "awaken.status", params: {} },
      { method: "awaken.status", params: { runId: AWAKEN_RUN_ID } },
    ]);
  });

  test("surfaces daemon errors and closes the connection", async () => {
    const rpc = harness([
      [
        {
          id: "req-1",
          type: "error",
          code: "INTERNAL",
          message: "database unavailable",
          detail: {},
        },
      ],
    ]);
    const stderr: string[] = [];
    const code = await runAwakenStatus({
      vaultPath: "/vault",
      stdout: () => {},
      stderr: (line) => stderr.push(line),
      connect: rpc.connect,
    });
    expect(code).toBe(1);
    expect(stderr[0]).toContain("database unavailable");
    expect(rpc.closed()).toBe(true);
  });

  test("rejects a non-canonical run id returned by the daemon", async () => {
    const rpc = harness([
      [
        {
          id: "req-1",
          type: "result",
          ok: true,
          run: {
            runId: "awaken_run:one",
            status: "running",
            processed: 1,
            failed: 0,
            total: 2,
            startedAt: Date.now(),
          },
        },
      ],
    ]);
    const stderr: string[] = [];
    expect(
      await runAwakenStatus({
        vaultPath: "/vault",
        stdout: () => {},
        stderr: (line) => stderr.push(line),
        connect: rpc.connect,
      }),
    ).toBe(1);
    expect(stderr[0]).toContain("invalid response");
  });

  test("rejects extra result and run fields", async () => {
    const extraResult = harness([
      [{ id: "req-1", type: "result", ok: true, run: null, legacyStatus: "none" }],
    ]);
    const resultStderr: string[] = [];
    expect(
      await runAwakenStatus({
        vaultPath: "/vault",
        stdout: () => {},
        stderr: (line) => resultStderr.push(line),
        connect: extraResult.connect,
      }),
    ).toBe(1);
    expect(resultStderr[0]).toContain("unsupported fields");

    const extraRun = harness([
      [
        {
          id: "req-1",
          type: "result",
          ok: true,
          run: {
            runId: AWAKEN_RUN_ID,
            status: "running",
            processed: 1,
            failed: 0,
            total: 2,
            startedAt: Date.now(),
            eta: 1,
          },
        },
      ],
    ]);
    const runStderr: string[] = [];
    expect(
      await runAwakenStatus({
        vaultPath: "/vault",
        stdout: () => {},
        stderr: (line) => runStderr.push(line),
        connect: extraRun.connect,
      }),
    ).toBe(1);
    expect(runStderr[0]).toContain("run fields are not exact");
  });

  test("rejects duplicate terminal frames and no-result streams", async () => {
    const result = statusResult("completed", 2)[0];
    if (result === undefined) throw new Error("missing status result fixture");
    const duplicate = harness([[result, result]]);
    const duplicateStderr: string[] = [];
    expect(
      await runAwakenStatus({
        vaultPath: "/vault",
        stdout: () => {},
        stderr: (line) => duplicateStderr.push(line),
        connect: duplicate.connect,
      }),
    ).toBe(1);
    expect(duplicateStderr[0]).toContain("duplicate terminal");

    const empty = harness([[]]);
    const emptyStderr: string[] = [];
    expect(
      await runAwakenStatus({
        vaultPath: "/vault",
        stdout: () => {},
        stderr: (line) => emptyStderr.push(line),
        connect: empty.connect,
      }),
    ).toBe(1);
    expect(emptyStderr[0]).toContain("returned no result");
  });

  test("treats a missing locked follow-up row as corruption", async () => {
    const rpc = harness([
      statusResult("running", 1),
      [{ id: "req-2", type: "result", ok: true, run: null }],
    ]);
    const stderr: string[] = [];
    expect(
      await runAwakenStatus({
        vaultPath: "/vault",
        stdout: () => {},
        stderr: (line) => stderr.push(line),
        follow: true,
        pollIntervalMs: 0,
        connect: rpc.connect,
      }),
    ).toBe(1);
    expect(stderr[0]).toContain("lost the locked run");
  });

  test("surfaces connection close failures", async () => {
    const rpc = harness(
      [[{ id: "req-1", type: "result", ok: true, run: null }]],
      new Error("close refused"),
    );
    const stderr: string[] = [];
    expect(
      await runAwakenStatus({
        vaultPath: "/vault",
        stdout: () => {},
        stderr: (line) => stderr.push(line),
        connect: rpc.connect,
      }),
    ).toBe(1);
    expect(stderr[0]).toContain("connection close failed");
  });
});
