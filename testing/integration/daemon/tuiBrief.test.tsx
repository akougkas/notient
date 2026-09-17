import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { SourceReference } from "../../../src/api/schema";
import { type BriefSession, BriefView } from "../../../src/cli/tui/views/BriefView";
import { vaultStateDir } from "../../../src/core/vault/identity";
import { analysisProvider, analysisSources } from "../../analysisFixture";
import { daemonResult, startTestDaemon } from "../../daemonHarness";

type Screen = Awaited<ReturnType<typeof testRender>>;
async function frameContaining(screen: Screen, text: string) {
  const deadline = performance.now() + 8000;
  let frame = "";
  while (performance.now() < deadline) {
    await act(async () => {
      await Bun.sleep(25);
    });
    await screen.renderOnce();
    frame = screen.captureCharFrame();
    if (frame.includes(text)) return frame;
  }
  throw new Error(`Missing ${text}:\n${frame}`);
}
test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] short TUI briefs on a typed topic, retains exact sources, and cancels provider work",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-brief-tui-"));
    const provider = analysisProvider();
    const session: BriefSession = { topic: "", mode: "topic", result: null };
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    let screen: Screen | undefined;
    let opened: SourceReference | undefined;
    const mount = async () => {
      await act(async () => {
        screen = await testRender(
          <BriefView
            session={session}
            initialPath={analysisSources[0].path}
            vaultPath={root}
            width={100}
            height={20}
            onClose={() => {}}
            onExit={() => {}}
            onSource={(source) => {
              opened = source;
            }}
          />,
          { width: 100, height: 20 },
        );
      });
    };
    try {
      await provider.configure(root);
      daemon = await startTestDaemon(root);
      for (let i = 0; i < 100; i++) {
        const status = await daemonResult(daemon.client, "daemon.status");
        if ((status.indexing as { state: string }).state === "current") break;
        if (i === 99) throw new Error("index not ready");
        await Bun.sleep(25);
      }
      await mount();
      if (!screen) throw new Error("no screen");
      await frameContaining(screen, "Prepare brief · Enter");
      await act(async () => {
        await screen?.mockInput.typeText("storage");
        screen?.mockInput.pressEnter();
      });
      const rendered = await frameContaining(screen, "different durability assumptions");
      expect(rendered).toContain("A little clarity");
      expect(rendered).toContain("sources checked");
      expect(rendered).not.toContain("## storage");
      await act(async () => {
        screen?.mockInput.pressKey("1");
      });
      expect(opened?.revision).toBe(analysisSources[0].revision);
      expect(opened?.range.startLine).toBe(3);
      expect(session.result?.summary?.evidence).toContainEqual(opened);
      const calls = provider.requests.length;
      await act(async () => {
        screen?.renderer.destroy();
      });
      await mount();
      await frameContaining(screen, "different durability assumptions");
      expect(provider.requests).toHaveLength(calls);
      await act(async () => {
        screen?.mockInput.pressEscape();
      });
      await frameContaining(screen, "Prepare brief · Enter");
      provider.setMode("wait");
      await act(async () => {
        screen?.mockInput.pressTab();
        screen?.mockInput.pressEnter();
      });
      await frameContaining(screen, "Esc stops");
      for (let i = 0; i < 100 && provider.requests.length === calls; i++)
        await act(async () => {
          await Bun.sleep(20);
        });
      expect(provider.requests.length).toBe(calls + 1);
      await act(async () => {
        screen?.mockInput.pressEscape();
      });
      await frameContaining(screen, "Stopped. Your notes are unchanged.");
      for (let i = 0; i < 100 && !provider.cancelled; i++)
        await act(async () => {
          await Bun.sleep(20);
        });
      expect(provider.cancelled).toBe(true);
    } finally {
      await act(async () => {
        screen?.renderer.destroy();
      });
      await daemon?.stop();
      provider.stop();
      await rm(vaultStateDir(root), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
