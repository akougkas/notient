import { chmod, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { dirname } from "node:path";
import { vaultAdminTokenPath } from "../../src/core/vault/identity";
import { authenticateHello, makeHelloAuthenticator } from "../../src/daemon/auth";
import { secureDaemonStateTree } from "../../src/daemon/ipcSecurity";
import type { Authenticator } from "../../src/daemon/rpc";

const FAKE_DAEMON_ROOT_TOKEN = "a".repeat(64);

/**
 * Install the same private token shape a booted daemon exposes to its local
 * CLI. The returned cleanup removes only this test vault's derived state
 * directory, which prevents command fixtures from leaking state under the
 * developer's real ~/.notient tree.
 */
export async function installFakeDaemonAuth(vaultPath: string): Promise<() => Promise<void>> {
  const tokenPath = vaultAdminTokenPath(vaultPath);
  const stateDir = dirname(tokenPath);
  await secureDaemonStateTree(stateDir);
  await writeFile(tokenPath, FAKE_DAEMON_ROOT_TOKEN, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  if (process.platform !== "win32") await chmod(tokenPath, 0o600);
  return async () => {
    await rm(stateDir, { recursive: true, force: true });
  };
}

/** Answer one hello with the principal produced by the real authenticator. */
export function replyToAuthenticatedHello(socket: Socket, frame: Record<string, unknown>): boolean {
  if (frame.method !== "session.hello") return false;
  const id = typeof frame.id === "string" ? frame.id : "unknown";
  const params = frame.params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("fake daemon received session.hello without object params");
  }
  const principal = authenticateHello(params as Record<string, unknown>, FAKE_DAEMON_ROOT_TOKEN);
  socket.write(`${JSON.stringify({ id, type: "result", ok: true, principal })}\n`);
  return true;
}

/** Production authenticator closed over the token installed above. */
export function fakeDaemonAuthenticator(): Authenticator {
  return makeHelloAuthenticator({ adminToken: FAKE_DAEMON_ROOT_TOKEN });
}
