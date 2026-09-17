import { mkdir, unlink } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import { dirname } from "node:path";
import {
  type ConnectionSession,
  MethodDispatcher,
  type MethodHandler,
  type MethodKind,
  parseEnvelope,
} from "../../../src/daemon/rpc";
import { currentPlatform, resolveSocketPath, writeFrame } from "../../../src/daemon/socket";
import { fakeDaemonAuthenticator, installFakeDaemonAuth } from "../../helpers/fakeDaemonAuth";

export interface TestRpcRegistration {
  method: string;
  handler: MethodHandler;
  kind: MethodKind;
}

export interface TestRpcDaemon {
  server: Server;
  close(): Promise<void>;
}

/** Real socket + production dispatcher harness for CLI/handler integration tests. */
export async function startTestRpcDaemon(
  vaultPath: string,
  registrations: ReadonlyArray<TestRpcRegistration>,
): Promise<TestRpcDaemon> {
  const socketPath = resolveSocketPath(vaultPath, currentPlatform());
  const cleanupAuth = await installFakeDaemonAuth(vaultPath);
  await mkdir(dirname(socketPath), { recursive: true });
  await unlink(socketPath).catch(() => {});

  const dispatcher = new MethodDispatcher({
    authenticate: fakeDaemonAuthenticator(),
  });
  for (const registration of registrations) {
    dispatcher.register(registration.method, registration.handler, { kind: registration.kind });
  }

  let connectionSequence = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    const session: ConnectionSession = {
      id: `test-connection-${connectionSequence++}`,
      principal: null,
    };
    let buffer = "";
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) dispatchLine(dispatcher, socket, session, line);
        newline = buffer.indexOf("\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  return {
    server,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(socketPath).catch(() => {});
      await cleanupAuth();
    },
  };
}

function dispatchLine(
  dispatcher: MethodDispatcher,
  socket: Socket,
  session: ConnectionSession,
  line: string,
): void {
  const parsed = parseEnvelope(line);
  if (!parsed.ok) {
    writeFrame(
      socket,
      JSON.stringify({
        id: "unknown",
        type: "error",
        code: "INVALID_PARAMS",
        message: parsed.reason,
        detail: {},
      }),
    );
    return;
  }
  void dispatcher.dispatch(parsed.envelope, (frame) => writeFrame(socket, frame), session);
}
