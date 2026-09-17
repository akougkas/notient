/**
 * `notient mcp` — Model Context Protocol server over stdio.
 *
 * Runs the Notient MCP adapter so Claude Code, Codex, and Cursor can call the
 * vault as a tool. The process is a client of the daemon, not a second
 * daemon: it dials the same unix socket every CLI verb uses and auto-spawns
 * the daemon on a cold vault via `connectClient`.
 *
 * stdout discipline. stdout is the MCP JSON-RPC channel and nothing else may
 * touch it. Two consequences:
 *   - Every adapter log line goes to stderr through `logStderr`.
 *   - The daemon spawn must not inherit stdout. `connectClient`'s
 *     `spawnDaemon` already uses `stdio: "ignore"` with `detached: true`, so
 *     no daemon output can reach our stdout. If that ever changes, this
 *     command must spawn the daemon itself instead of relying on the
 *     auto-spawn.
 *
 * Principal. The adapter connects as an authenticated agent, never as the
 * human admin. `connectClient` derives an id-bound credential from the local
 * root token and sends only that credential in `session.hello`.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_AGENT_ID } from "../../core/auth/agentIdentity";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { type ClientHandle, type ClientOptions, connectClient } from "../client";
import { createReconnectingCaller } from "../mcp/rpcBridge";
import { createNotientMcpServer } from "../mcp/server";

export const MCP_DEFAULT_AGENT_ID = "mcp-client";

export interface McpCommandOptions {
  vaultPath: string;
  clientIdentity: string;
  /** Test seam; defaults to a newline-terminated write to process.stderr. */
  writeStderr?: (line: string) => void;
  /** Test seam; defaults to dialing the real per-vault socket. */
  connect?: () => Promise<ClientHandle>;
}

export async function runMcpCommand(options: McpCommandOptions): Promise<number> {
  const logStderr =
    options.writeStderr ??
    ((line: string) => {
      process.stderr.write(`${line}\n`);
    });

  if (options.clientIdentity === DEFAULT_AGENT_ID) {
    logStderr("notient mcp: INVALID_PARAMS: --as human is reserved for the local operator");
    return 1;
  }

  const connect =
    options.connect ??
    (() => {
      const clientOptions: ClientOptions = {
        socketPath: resolveSocketPath(options.vaultPath, currentPlatform()),
        vaultPath: options.vaultPath,
        clientIdentity: options.clientIdentity,
      };
      return connectClient(clientOptions);
    });

  const caller = createReconnectingCaller(connect);
  const server = createNotientMcpServer({
    caller,
    vaultPath: options.vaultPath,
  });
  const transport = new StdioServerTransport();

  logStderr(
    `notient mcp: serving vault ${options.vaultPath} as "${options.clientIdentity}" over stdio`,
  );

  // The host closes our stdin when it is done with us; the SDK transport
  // does not always surface that as onclose, and an open daemon socket
  // would otherwise keep the process alive.
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.stdin.once("end", () => resolve());
    process.stdin.once("close", () => resolve());
  });

  try {
    await server.connect(transport);
    await closed;
    return 0;
  } catch (error) {
    logStderr(`notient mcp: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await caller.close();
    // Nothing else should outlive the transport; stray handles (a daemon
    // socket mid-teardown) must not keep the host waiting.
    setTimeout(() => process.exit(0), 50).unref();
  }
}
