import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { NotientClient } from "../../../src/api/client";
import { createRpc } from "../../../src/cli/tui/rpc";
import { SettingsView } from "../../../src/cli/tui/views/SettingsView";
import { vaultStateDir } from "../../../src/core/vault/identity";
import { daemonResult, startTestDaemon } from "../../daemonHarness";

type Screen = Awaited<ReturnType<typeof testRender>>;
async function frame(screen: Screen, text: string) {
  let rendered = "";
  for (let i = 0; i < 100; i++) {
    await act(async () => {
      await Bun.sleep(25);
    });
    await screen.renderOnce();
    rendered = screen.captureCharFrame();
    if (rendered.includes(text)) return rendered;
  }
  throw new Error(`Missing ${text}:\n${rendered}`);
}
test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] settings authority, HTTP receipts, terminal editing and restart use the saved product configuration",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-settings-"));
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    let screen: Screen | undefined;
    try {
      await Bun.write(join(root, "Note.md"), "# Notes stay yours\n");
      daemon = await startTestDaemon(root);
      const operator = daemon.client;
      const pair = async (kind: "human" | "agent", scopes: string[]) => {
        const code = await daemonResult(operator, "pairing.create", {
          label: `Settings ${kind}`,
          kind,
          scopes,
        });
        const credential = await NotientClient.pair(
          String(code.endpoint),
          String(code.code),
          String(code.vaultId),
        );
        return {
          credential,
          client: new NotientClient({
            endpoint: String(code.endpoint),
            token: credential.token,
            vaultId: credential.vaultId,
          }),
        };
      };
      const admin = await pair("human", ["read", "write", "admin"]);
      const human = await pair("human", ["read", "write"]);
      const agent = await pair("agent", ["read", "write"]);
      const before = await admin.client.call("pipelines.list", {});
      const policy = structuredClone(before.pipelines.find((p) => p.id === "enrich")?.policy);
      if (!policy) throw new Error("Enrichment policy missing");
      const request = {
        pipeline: "enrich" as const,
        policy,
        revision: before.revision,
        idempotencyKey: "configure-enrich",
      };
      await expect(human.client.call("pipelines.configure", request)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(agent.client.call("pipelines.configure", request)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      const invalid = await agent.client.call("pipelines.validate", {
        pipeline: "enrich",
        policy: { ...policy, enabled: true },
      });
      expect(invalid.valid).toBe(false);
      await expect(
        admin.client.call("pipelines.configure", {
          ...request,
          policy: { ...policy, enabled: true },
        }),
      ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
      policy.readScope.folders = ["Research"];
      policy.readScope.excludeFolders = ["Research/Private"];
      policy.budget.notes = 8;
      const saved = await admin.client.call("pipelines.configure", request);
      expect(saved.replayed).toBe(false);
      expect(saved.settings.pipelines.enrich.readScope.excludeFolders).toEqual([
        "Research/Private",
      ]);
      const raw = JSON.parse(await readFile(join(root, ".notient/config.json"), "utf8"));
      expect(raw.background.pipelines.enrich.budget.notes).toBe(8);
      raw.chat.maxRoundsPerTurn = 7;
      await Bun.write(join(root, ".notient/config.json"), JSON.stringify(raw, null, 2));
      const pauseInput = { paused: true, revision: saved.revision, idempotencyKey: "pause" };
      await expect(agent.client.call("background.pause", pauseInput)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await admin.client.call("background.pause", pauseInput);
      expect(
        JSON.parse(await readFile(join(root, ".notient/config.json"), "utf8")).chat
          .maxRoundsPerTurn,
      ).toBe(7);
      expect((await admin.client.call("pipelines.configure", request)).replayed).toBe(true);
      expect((await admin.client.call("pipelines.list", {})).paused).toBe(true);
      await expect(
        admin.client.call("pipelines.configure", {
          ...request,
          policy: { ...policy, mode: "report" },
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        admin.client.call("pipelines.configure", { ...request, idempotencyKey: "stale" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const rpc = createRpc(daemon.client);
      await act(async () => {
        screen = await testRender(
          <SettingsView
            rpc={() => rpc}
            width={80}
            height={28}
            onClose={() => {}}
            onExit={() => {}}
          />,
          { width: 80, height: 28 },
        );
      });
      if (!screen) throw new Error("Preferences did not mount");
      const mounted = screen;
      await frame(screen, "Background intelligence");
      await act(async () => {
        mounted.mockInput.pressArrow("down");
      });
      await act(async () => {
        mounted.mockInput.pressEnter();
      });
      await frame(screen, "Background work");
      for (let i = 0; i < 3; i++)
        await act(async () => {
          mounted.mockInput.pressKey("TAB");
        });
      await frame(screen, "Notes per run");
      await act(async () => {
        mounted.mockInput.pressEnter();
      });
      await frame(screen, "Ctrl+S keep value");
      await act(async () => {
        mounted.mockInput.pressKey("a", { ctrl: true });
        await mounted.mockInput.typeText("6");
      });
      await act(async () => {
        mounted.mockInput.pressKey("s", { ctrl: true });
      });
      await frame(screen, "Unsaved change");
      await act(async () => {
        mounted.mockInput.pressKey("s", { ctrl: true });
      });
      await frame(screen, "Review settings");
      expect(
        (await rpc.pipelines()).pipelines.find((p) => p.id === "enrich")?.policy.budget.notes,
      ).toBe(8);
      await act(async () => {
        mounted.mockInput.pressKey("s", { ctrl: true });
      });
      await frame(screen, "Saved. These settings");
      expect(
        (await rpc.pipelines()).pipelines.find((p) => p.id === "enrich")?.policy.budget.notes,
      ).toBe(6);
      await act(async () => {
        mounted.renderer.destroy();
      });
      screen = undefined;
      await daemon.stop();
      daemon = await startTestDaemon(root);
      const restored = await createRpc(daemon.client).pipelines();
      expect(restored.paused).toBe(true);
      expect(restored.pipelines.find((p) => p.id === "enrich")?.policy.budget.notes).toBe(6);
      // The same paired caller's receipt remains historical after another user's save.
      const code = await daemonResult(daemon.client, "daemon.status");
      const reconnected = new NotientClient({
        endpoint: String(code.httpEndpoint),
        token: admin.credential.token,
        vaultId: admin.credential.vaultId,
      });
      expect((await reconnected.call("pipelines.configure", request)).replayed).toBe(true);
      expect(
        (await reconnected.call("pipelines.list", {})).pipelines.find((p) => p.id === "enrich")
          ?.policy.budget.notes,
      ).toBe(6);
      expect(await readFile(join(root, "Note.md"), "utf8")).toBe("# Notes stay yours\n");
    } finally {
      if (screen) {
        const closing = screen;
        await act(async () => {
          closing.renderer.destroy();
        });
      }
      await daemon?.stop();
      await rm(vaultStateDir(root), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
