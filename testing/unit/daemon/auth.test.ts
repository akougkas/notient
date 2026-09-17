import { describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authenticateHello,
  deriveAgentCredential,
  makeHelloAuthenticator,
} from "../../../src/daemon/auth";
import { readAdminToken, removeAdminToken, writeAdminToken } from "../../../src/daemon/lifecycle";
import { RpcError, type RpcErrorCode } from "../../../src/daemon/rpc";

const TOKEN = "b".repeat(64);
const OTHER_TOKEN = "c".repeat(64);

describe("session.hello authentication", () => {
  test("the root token establishes only the reserved human principal", () => {
    expect(authenticateHello({ clientIdentity: "human", token: TOKEN }, TOKEN)).toEqual({
      id: "human",
      kind: "human",
      scopes: ["read", "write", "admin"],
    });
  });

  test("a derived credential establishes its exact agent principal", () => {
    const agentCredential = deriveAgentCredential(TOKEN, "claude-code");
    expect(authenticateHello({ clientIdentity: "claude-code", agentCredential }, TOKEN)).toEqual({
      id: "claude-code",
      kind: "agent",
      scopes: ["read", "write"],
    });
  });

  test("agent credentials are boot-scoped, id-bound, and never equal the root token", () => {
    const claude = deriveAgentCredential(TOKEN, "claude-code");
    expect(claude).toMatch(/^[0-9a-f]{64}$/);
    expect(claude).not.toBe(TOKEN);
    expect(deriveAgentCredential(TOKEN, "codex")).not.toBe(claude);
    expect(deriveAgentCredential(OTHER_TOKEN, "claude-code")).not.toBe(claude);
  });

  test("an identity swap cannot reuse another agent credential", () => {
    const claudeCredential = deriveAgentCredential(TOKEN, "claude-code");
    expectRpcCode(
      () =>
        authenticateHello({ clientIdentity: "codex", agentCredential: claudeCredential }, TOKEN),
      "UNAUTHENTICATED",
    );
  });

  test("a caller cannot impersonate the owner of an active grant at handshake", () => {
    const attackerCredential = deriveAgentCredential(TOKEN, "untrusted-host");
    expectRpcCode(
      () =>
        authenticateHello(
          { clientIdentity: "granted-agent", agentCredential: attackerCredential },
          TOKEN,
        ),
      "UNAUTHENTICATED",
    );
  });

  test("missing and wrong agent credentials are UNAUTHENTICATED", () => {
    expectRpcCode(() => authenticateHello({ clientIdentity: "codex" }, TOKEN), "UNAUTHENTICATED");
    expectRpcCode(
      () => authenticateHello({ clientIdentity: "codex", agentCredential: "0".repeat(64) }, TOKEN),
      "UNAUTHENTICATED",
    );
    expectRpcCode(
      () => authenticateHello({ clientIdentity: "codex", agentCredential: 42 }, TOKEN),
      "UNAUTHENTICATED",
    );
  });

  test("missing and wrong human tokens are UNAUTHENTICATED", () => {
    expectRpcCode(() => authenticateHello({ clientIdentity: "human" }, TOKEN), "UNAUTHENTICATED");
    expectRpcCode(
      () => authenticateHello({ clientIdentity: "human", token: OTHER_TOKEN }, TOKEN),
      "UNAUTHENTICATED",
    );
  });

  test("a missing daemon root token authenticates nobody", () => {
    expectRpcCode(
      () => authenticateHello({ clientIdentity: "human", token: TOKEN }, null),
      "UNAUTHENTICATED",
    );
    expectRpcCode(
      () =>
        authenticateHello(
          {
            clientIdentity: "codex",
            agentCredential: deriveAgentCredential(TOKEN, "codex"),
          },
          null,
        ),
      "UNAUTHENTICATED",
    );
  });

  test("hello shapes are strict and agents cannot submit the root token", () => {
    expectRpcCode(
      () => authenticateHello({ clientIdentity: "codex", token: TOKEN }, TOKEN),
      "INVALID_PARAMS",
    );
    expectRpcCode(
      () =>
        authenticateHello(
          {
            clientIdentity: "human",
            agentCredential: deriveAgentCredential(TOKEN, "codex"),
          },
          TOKEN,
        ),
      "INVALID_PARAMS",
    );
    expectRpcCode(
      () => authenticateHello({ clientIdentity: "human", token: TOKEN, legacy: true }, TOKEN),
      "INVALID_PARAMS",
    );
  });

  test("clientIdentity is required and must be exact canonical input", () => {
    expectRpcCode(() => authenticateHello({ token: TOKEN }, TOKEN), "INVALID_PARAMS");
    expectRpcCode(
      () => authenticateHello({ clientIdentity: "Not Valid!", token: TOKEN }, TOKEN),
      "INVALID_PARAMS",
    );
    expectRpcCode(
      () =>
        authenticateHello({ clientIdentity: " codex ", agentCredential: "0".repeat(64) }, TOKEN),
      "INVALID_PARAMS",
    );
    expectRpcCode(
      () => authenticateHello({ clientIdentity: 7, token: TOKEN }, TOKEN),
      "INVALID_PARAMS",
    );
  });

  test("the human id has no derived agent credential", () => {
    expect(() => deriveAgentCredential(TOKEN, "human")).toThrow("reserved human identity");
  });

  test("makeHelloAuthenticator closes over the live root token", () => {
    const authenticate = makeHelloAuthenticator({ adminToken: TOKEN });
    expect(
      authenticate({
        clientIdentity: "codex",
        agentCredential: deriveAgentCredential(TOKEN, "codex"),
      }),
    ).toEqual({ id: "codex", kind: "agent", scopes: ["read", "write"] });
  });
});

function expectRpcCode(operation: () => unknown, code: RpcErrorCode): void {
  try {
    operation();
    throw new Error("expected authentication refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe(code);
  }
}

describe("admin token file", () => {
  test("is 64 hex chars, mode 0600, readable back, and removable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "notient-admin-token-"));
    try {
      const tokenPath = join(dir, "nested", "admin.token");
      await mkdir(join(dir, "nested"), { mode: 0o700 });
      const token = await writeAdminToken(tokenPath);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      if (process.platform !== "win32") {
        expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
      }
      expect(await readAdminToken(tokenPath)).toBe(token);

      // Two boots never mint the same token.
      const second = await writeAdminToken(tokenPath);
      expect(second).not.toBe(token);

      await removeAdminToken(tokenPath);
      expect(await readAdminToken(tokenPath)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("readAdminToken returns null for a missing file", async () => {
    expect(await readAdminToken(join(tmpdir(), "notient-no-such-admin.token"))).toBeNull();
  });

  test("refuses a symlink preplant without touching its target", async () => {
    if (process.platform === "win32") return;
    const dir = await mkdtemp(join(tmpdir(), "notient-admin-token-symlink-"));
    try {
      const stateDir = join(dir, "state");
      const target = join(dir, "outside");
      const tokenPath = join(stateDir, "admin.token");
      await mkdir(stateDir, { mode: 0o700 });
      await writeFile(target, "sentinel", { mode: 0o600 });
      await symlink(target, tokenPath);

      await expect(writeAdminToken(tokenPath)).rejects.toThrow("non-regular admin token");
      expect(await readFile(target, "utf8")).toBe("sentinel");
      expect((await lstat(tokenPath)).isSymbolicLink()).toBe(true);
      expect(await readAdminToken(tokenPath)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("atomically replaces an owned stale token and establishes exact mode 0600", async () => {
    if (process.platform === "win32") return;
    const dir = await mkdtemp(join(tmpdir(), "notient-admin-token-stale-"));
    try {
      const stateDir = join(dir, "state");
      const tokenPath = join(stateDir, "admin.token");
      await mkdir(stateDir, { mode: 0o700 });
      await writeFile(tokenPath, "stale", { mode: 0o600 });
      await chmod(tokenPath, 0o666);

      const token = await writeAdminToken(tokenPath);
      expect(token).not.toBe("stale");
      expect(await readAdminToken(tokenPath)).toBe(token);
      expect((await stat(tokenPath)).mode & 0o7777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
