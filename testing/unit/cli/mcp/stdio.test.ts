import { noteReadFixture } from "../../../noteReadFixture";
/**
 * End-to-end check of `notient mcp` as a real subprocess.
 *
 * A fake daemon listens on the unix socket the CLI resolves for the vault,
 * so the adapter connects instead of auto-spawning a real daemon. The MCP
 * SDK's own stdio client then drives initialize, tools/list, and one
 * tools/call over the child's stdin/stdout. This is also the regression test
 * for stdout discipline: any stray adapter print would corrupt the JSON-RPC
 * framing and every request below would fail.
 *
 * The child runs with HOME pointed at a temp dir so the fake socket never
 * lands in the developer's real `~/.notient/`. The socket path is assembled
 * here from `vaultId` rather than `resolveSocketPath` because Bun's
 * `os.homedir()` resolves HOME once at process start and ignores a later
 * assignment, so the parent cannot ask the helper for the child's answer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { vaultId } from "../../../../src/core/vault/identity";
import { deriveAgentCredential } from "../../../../src/daemon/auth";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const CLI_ENTRY = join(REPO_ROOT, "src/cli/index.ts");
const ADMIN_TOKEN = "a".repeat(64);

interface FakeDaemon {
  server: Server;
  frames: Record<string, unknown>[];
  close: () => Promise<void>;
}

/**
 * Terminal frame for one method. `vitals.get` answers with an error frame so
 * the test can assert the adapter's error conversion end to end.
 */
function terminalFrame(id: string, method: string, params: Record<string, unknown>): string {
  if (method === "session.hello") {
    const clientIdentity = params.clientIdentity;
    if (typeof clientIdentity !== "string") throw new Error("hello clientIdentity missing");
    return JSON.stringify({
      id,
      type: "result",
      ok: true,
      principal: { id: clientIdentity, kind: "agent", scopes: ["read", "write"] },
    });
  }
  if (method === "vitals.get") {
    return JSON.stringify({
      id,
      type: "error",
      code: "INVALID_PARAMS",
      message: "note not indexed",
    });
  }
  if (method === "notes.read") {
    return JSON.stringify({
      id,
      type: "result",
      ...noteReadFixture("# Auth\n\nPasskeys.", "auth.md"),
    });
  }
  if (method === "vault.list") {
    return JSON.stringify({ id, type: "result", ok: true, paths: ["auth.md"] });
  }
  return JSON.stringify({ id, type: "result", ok: true });
}

function respond(socket: Socket, line: string, frames: Record<string, unknown>[]): void {
  const frame = JSON.parse(line) as Record<string, unknown>;
  frames.push(frame);
  const id = typeof frame.id === "string" ? frame.id : "unknown";
  const method = typeof frame.method === "string" ? frame.method : "";
  const params =
    typeof frame.params === "object" && frame.params !== null && !Array.isArray(frame.params)
      ? (frame.params as Record<string, unknown>)
      : {};
  socket.write(`${JSON.stringify({ id, type: "ack", method })}\n`);
  socket.write(`${terminalFrame(id, method, params)}\n`);
}

async function startFakeDaemon(socketPath: string): Promise<FakeDaemon> {
  await mkdir(dirname(socketPath), { recursive: true });
  const frames: Record<string, unknown>[] = [];
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (line.length > 0) respond(socket, line, frames);
      }
    });
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolvePromise);
  });

  return {
    server,
    frames,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

describe("notient mcp over real stdio", () => {
  let home: string;
  let vault: string;
  let socketPath: string;
  let daemon: FakeDaemon;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "notient-mcp-home-"));
    vault = await mkdtemp(join(tmpdir(), "notient-mcp-vault-"));
    await mkdir(join(vault, ".notient"), { recursive: true });
    // Mirrors resolveSocketPath(vault, "linux") with HOME = the temp home.
    socketPath = join(home, ".notient", vaultId(vault), "notient.sock");
    daemon = await startFakeDaemon(socketPath);
    await chmod(join(home, ".notient"), 0o700);
    await chmod(dirname(socketPath), 0o700);
    await writeFile(join(dirname(socketPath), "admin.token"), ADMIN_TOKEN, {
      encoding: "utf8",
      mode: 0o600,
    });
  });

  afterEach(async () => {
    await daemon.close();
    await rm(home, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  });

  test("initialize, tools/list, and tools/call round-trip against a fake daemon", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY, "mcp", "--vault", vault],
      cwd: REPO_ROOT,
      env: { ...(process.env as Record<string, string>), HOME: home },
      stderr: "ignore",
    });
    const client = new Client({ name: "stdio-test", version: "0.0.0" });
    await client.connect(transport);

    expect(client.getServerVersion()?.name).toBe("notient");

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain("notient_read_note");

    const called = await client.callTool({
      name: "notient_read_note",
      arguments: { path: "auth.md" },
    });
    expect(called.isError).toBeFalsy();
    const blocks = Array.isArray(called.content) ? called.content : [];
    expect(String((blocks[1] as { text?: string })?.text)).toContain("Passkeys.");

    const failed = await client.callTool({ name: "notient_vitals", arguments: { path: "x.md" } });
    expect(failed.isError).toBe(true);
    const failedBlocks = Array.isArray(failed.content) ? failed.content : [];
    expect(String((failedBlocks[0] as { text?: string })?.text)).toBe(
      "INVALID_PARAMS: note not indexed",
    );

    const rpcMethods = daemon.frames.map((frame) => frame.method);
    expect(rpcMethods).toEqual(["session.hello", "notes.read", "vitals.get"]);
    // The adapter authenticates its exact agent id without ever putting the
    // human root token on the socket.
    expect(daemon.frames[0].params).toEqual({
      clientIdentity: "mcp-client",
      agentCredential: deriveAgentCredential(ADMIN_TOKEN, "mcp-client"),
    });
    expect(JSON.stringify(daemon.frames[0])).not.toContain(ADMIN_TOKEN);

    await client.close();
  }, 30_000);

  test("--as human is rejected on stderr before a daemon connection", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, "mcp", "--vault", vault, "--as", "human"],
      cwd: REPO_ROOT,
      env: { ...(process.env as Record<string, string>), HOME: home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("--as human is reserved for the local operator");
    expect(daemon.frames).toEqual([]);
  }, 30_000);
});
