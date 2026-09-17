import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHttpApi } from "../../../src/daemon/http";
import { PairingStore } from "../../../src/daemon/pairing";
import { MethodDispatcher, type Principal } from "../../../src/daemon/rpc";

const operator: Principal = { id: "human", kind: "human", scopes: ["read", "write", "admin"] };
const roots: string[] = [];
const servers: ReturnType<typeof startHttpApi>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "notient-http-test-"));
  roots.push(root);
  const pairing = new PairingStore(join(root, "pairings.json"), "0123456789abcdef");
  await pairing.load();
  const dispatcher = new MethodDispatcher();
  dispatcher.register(
    "capabilities.get",
    async () => ({
      ok: true,
      apiVersion: "v1",
      version: "test",
      vaultId: pairing.vaultId,
      operations: ["capabilities.get"],
      limits: {
        requestBytes: 100,
        concurrentRequests: 32,
        eventPage: 100,
        requestDurationMs: 180000,
      },
    }),
    { kind: "read" },
  );
  const api = startHttpApi({
    pairing,
    invoke: (method, context) => dispatcher.invoke(method, context),
  });
  servers.push(api);
  return { root, pairing, dispatcher, api };
}
async function pair(pairing: PairingStore, scopes = ["read"]) {
  const code = pairing.create({ label: "test", kind: "human", scopes }, operator);
  return pairing.exchange({ code: code.code, vaultId: code.vaultId });
}
describe("authenticated loopback HTTP", () => {
  test("single-use scoped credentials persist as hashes and revoke across restart", async () => {
    const { pairing, root } = await fixture();
    const code = pairing.create({ label: "Desktop", kind: "human", scopes: ["read"] }, operator);
    await expect(
      pairing.exchange({ code: code.code, vaultId: "fedcba9876543210" }),
    ).rejects.toThrow("vault identity");
    const credential = await pairing.exchange({ code: code.code, vaultId: code.vaultId });
    await expect(pairing.exchange({ code: code.code, vaultId: code.vaultId })).rejects.toThrow(
      "already used",
    );
    expect(await readFile(join(root, "pairings.json"), "utf8")).not.toContain(credential.token);
    const restarted = new PairingStore(join(root, "pairings.json"), pairing.vaultId);
    await restarted.load();
    expect(restarted.authenticate(credential.token).principal.scopes).toEqual(["read"]);
    await restarted.revoke(credential.credentialId, operator);
    const again = new PairingStore(join(root, "pairings.json"), pairing.vaultId);
    await again.load();
    expect(() => again.authenticate(credential.token)).toThrow("revoked");
    expect(() =>
      pairing.create({ label: "bad", kind: "agent", scopes: ["admin"] }, operator),
    ).toThrow("agents cannot");
  });
  test("rejects planted private credential files", async () => {
    const { pairing, root } = await fixture();
    await symlink("/etc/passwd", join(root, "pairings.json"));
    await expect(pairing.load()).rejects.toThrow();
  });
  test("rejects cross-origin, host-rebinding, query secrets and scope escalation", async () => {
    const { pairing, api, dispatcher } = await fixture();
    const credential = await pair(pairing);
    const headers = {
      Authorization: `Bearer ${credential.token}`,
      "Content-Type": "application/json",
    };
    const post = (route: string, extra = {}) =>
      fetch(`${api.endpoint}/api/v1/${route}`, {
        method: "POST",
        headers: { ...headers, ...extra },
        body: "{}",
      });
    expect((await post("capabilities/get")).status).toBe(200);
    expect(
      (await post("capabilities/get", { origin: "app://obsidian.md" })).headers.get(
        "access-control-allow-origin",
      ),
    ).toBe("app://obsidian.md");
    expect((await post("capabilities/get", { origin: "https://attacker.example" })).status).toBe(
      403,
    );
    expect((await post("capabilities/get", { host: "attacker.example" })).status).toBe(403);
    expect((await post("capabilities/get?token=secret")).status).toBe(400);
    dispatcher.register(
      "changes.apply",
      async () => {
        throw new Error("must not execute");
      },
      { kind: "write" },
    );
    const denied = await fetch(`${api.endpoint}/api/v1/changes/apply`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        previewId: "x",
        previewRevision: "a".repeat(64),
        idempotencyKey: "x",
      }),
    });
    expect(denied.status).toBe(403);
    expect((await post("db/sql")).status).toBe(404);
  });
  test("revocation cancels an admitted mutation before effects", async () => {
    const { pairing, api, dispatcher } = await fixture();
    const credential = await pair(pairing, ["read", "write"]);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let effects = 0;
    dispatcher.register(
      "changes.apply",
      async ({ signal }) => {
        entered();
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        signal?.throwIfAborted();
        effects++;
        return { ok: true };
      },
      { kind: "write" },
    );
    const work = fetch(`${api.endpoint}/api/v1/changes/apply`, {
      method: "POST",
      headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        previewId: "x",
        previewRevision: "a".repeat(64),
        idempotencyKey: "x",
      }),
    });
    await started;
    await api.revoke(credential.credentialId, operator);
    expect((await work).status).toBe(401);
    expect(effects).toBe(0);
  });
});
