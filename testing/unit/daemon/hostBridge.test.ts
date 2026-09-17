import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsVault } from "../../../src/adapters/fsVault";
import { HostBridge } from "../../../src/daemon/hostBridge";
import { PairingStore } from "../../../src/daemon/pairing";
import { MethodDispatcher, type Principal } from "../../../src/daemon/rpc";

const roots: string[] = [];
const human: Principal = { id: "human", kind: "human", scopes: ["read", "write", "admin"] };
const agent: Principal = { id: "agent", kind: "agent", scopes: ["read", "write"] };
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "notient-host-"));
  roots.push(root);
  const pairing = new PairingStore(join(root, "pairings.json"), "0123456789abcdef");
  await pairing.load();
  const code = pairing.create(
    { label: "Obsidian", kind: "human", scopes: ["read", "host"] },
    human,
  );
  const credential = await pairing.exchange({ code: code.code, vaultId: code.vaultId });
  const bridge = new HostBridge(join(root, "hosts.json"), pairing);
  await bridge.load();
  const dispatcher = new MethodDispatcher();
  bridge.register(dispatcher);
  const call = (
    method: string,
    params: Record<string, unknown> = {},
    principal = credential.principal,
    signal?: AbortSignal,
  ) =>
    dispatcher.invoke(method, {
      params,
      principal,
      signal,
      connectionId: "test",
      requestId: randomUUID(),
      emit: () => {},
    });
  const { sessionId } = await call("host.attach", { instanceId: randomUUID(), label: "Obsidian" });
  const poll = () => call("host.poll", { sessionId });
  const reply = (id: string, result: unknown) =>
    call("host.reply", { sessionId, commandId: id, result });
  const commands = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const page = await poll();
      const commands = page.commands as Array<{ id: string; kind: string; paths?: string[] }>;
      if (commands.length) return commands;
      await Bun.sleep(1);
    }
    throw new Error("host command was not queued");
  };
  return { root, pairing, credential, bridge, call, poll, reply, commands };
}

test("dirty host vetoes real bytes; a clean guard remains held through write and releases on success/conflict", async () => {
  const f = await fixture();
  const path = join(f.root, "note.md");
  await Bun.write(path, "original");
  const vault = new FsVault(f.root, { beforeMutation: (paths) => f.bridge.beforeMutation(paths) });
  const denied = vault.writeIfUnchanged("note.md", "original", "changed").catch((error) => error);
  const [first] = await f.commands();
  expect(first.paths).toEqual(["note.md"]);
  await f.reply(first.id, { kind: "guard", allowed: false, reason: "Unsaved edits" });
  expect((await denied).message).toContain("Unsaved edits");
  expect(await readFile(path, "utf8")).toBe("original");
  expect((await f.poll()).guards).toEqual([]);
  const writing = vault.writeIfUnchanged("note.md", "original", "changed");
  const [command] = await f.commands();
  const result = { kind: "guard", allowed: true, reason: null };
  await f.reply(command.id, result);
  expect((await f.poll()).guards).toEqual([{ id: command.id, paths: ["note.md"] }]);
  expect(await writing).toBe(true);
  expect(await readFile(path, "utf8")).toBe("changed");
  expect((await f.poll()).guards).toEqual([]);
  const stale = vault.writeIfUnchanged("note.md", "original", "stale");
  const [next] = await f.commands();
  await f.reply(next.id, result);
  expect(await stale).toBe(false);
  expect((await f.poll()).guards).toEqual([]);
  expect(await readFile(path, "utf8")).toBe("changed");
});

test("host authority, reply correlation, cancellation and persisted offline protection fail closed", async () => {
  const f = await fixture();
  await expect(
    f.call("host.attach", { instanceId: randomUUID(), label: "fake" }, agent),
  ).rejects.toThrow("host scope");
  await expect(
    f.call(
      "host.attach",
      { instanceId: randomUUID(), label: "fake" },
      { ...agent, scopes: ["host"] },
    ),
  ).rejects.toThrow("paired human");
  const request = f.call("host.context", {}, agent);
  const [command] = await f.commands();
  await expect(f.reply(command.id, { kind: "open", opened: true, reason: null })).rejects.toThrow(
    "does not match",
  );
  await f.reply(command.id, { kind: "context", context: null });
  expect(await request).toEqual({ ok: true, context: null });
  const controller = new AbortController();
  const cancelled = f.call("host.context", {}, agent, controller.signal).catch((error) => error);
  const [pending] = await f.commands();
  controller.abort();
  expect((await cancelled).message).toContain("interrupted");
  expect(await f.reply(pending.id, { kind: "context", context: null })).toEqual({
    ok: true,
    accepted: false,
  });
  const restarted = new HostBridge(join(f.root, "hosts.json"), f.pairing);
  await restarted.load();
  await expect(restarted.beforeMutation(["note.md"])).rejects.toThrow("disconnected");
  await f.pairing.revoke(f.credential.credentialId, human);
  expect(await restarted.beforeMutation(["note.md"])).toBeTypeOf("function");
});

test("host registration cannot execute arbitrary code or expose hidden paths; duplicate replies cannot change a held guard", async () => {
  const f = await fixture();
  await expect(
    f.call("host.open", { source: { path: ".obsidian/config.md" } }, human),
  ).rejects.toThrow();
  await expect(f.call("host.execute", { script: "alert(1)" }, human)).rejects.toThrow(
    "unknown method",
  );
  const work = f.bridge.beforeMutation(["one.md", "two.md"]);
  const [command] = await f.commands();
  const result = { kind: "guard", allowed: true, reason: null };
  await f.reply(command.id, result);
  const release = await work;
  expect(await f.reply(command.id, result)).toEqual({ ok: true, accepted: true });
  await expect(
    f.reply(command.id, { kind: "guard", allowed: false, reason: "changed" }),
  ).rejects.toThrow("changed after");
  release?.();
  expect((await f.poll()).guards).toEqual([]);
});

test("cancellation is rechecked after the host acknowledges a guard and before any filesystem effect", async () => {
  const f = await fixture();
  await Bun.write(join(f.root, "note.md"), "original");
  const vault = new FsVault(f.root, { beforeMutation: (paths) => f.bridge.beforeMutation(paths) });
  const controller = new AbortController();
  const writing = vault
    .writeIfUnchanged("note.md", "original", "changed", async () =>
      controller.signal.throwIfAborted(),
    )
    .catch((error) => error);
  const [command] = await f.commands();
  controller.abort(new Error("permission revoked while awaiting the editor"));
  await f.reply(command.id, { kind: "guard", allowed: true, reason: null });
  expect((await writing).message).toContain("permission revoked");
  expect(await readFile(join(f.root, "note.md"), "utf8")).toBe("original");
  expect((await f.poll()).guards).toEqual([]);
});
