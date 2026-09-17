import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { SourceReference } from "../../../src/api/schema";
import { createRpc } from "../../../src/cli/tui/rpc";
import { type AnalysisSession, AnalysisView } from "../../../src/cli/tui/views/AnalysisView";
import { vaultStateDir } from "../../../src/core/vault/identity";
import { analysisProvider, analysisSources } from "../../analysisFixture";
import { startTestDaemon } from "../../daemonHarness";

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
  "[smoke] a short TUI compares chosen notes, renders Markdown, opens exact evidence and retains results without another inference",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "notient-analysis-tui-"));
    const provider = analysisProvider();
    const session: AnalysisSession = { paths: [], question: "", result: null };
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    let screen: Screen | undefined;
    let opened: SourceReference | undefined;
    const mount = async () => {
      if (!daemon) throw new Error("No daemon");
      const rpc = createRpc(daemon.client);
      await act(async () => {
        screen = await testRender(
          <AnalysisView
            session={session}
            kind="compare"
            initialPath={analysisSources[0].path}
            vaultPath={root}
            rpc={() => rpc}
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
      await Bun.write(
        join(root, "Another experiment.md"),
        "An unrelated note chosen only if rapid navigation loses state.",
      );
      daemon = await startTestDaemon(root);
      await mount();
      if (!screen) throw new Error("No screen");
      await frameContaining(screen, "Think across your notes");
      await frameContaining(screen, "Compare these notes · Ctrl+R");
      await act(async () => {
        await screen?.mockInput.typeText("unfindable-note-title");
      });
      await frameContaining(screen, "No matching notes.");
      await act(async () => {
        screen?.mockInput.pressKey("a", { ctrl: true });
        screen?.mockInput.pressKey("k", { ctrl: true });
        await screen?.mockInput.typeText("experiment");
      });
      await frameContaining(screen, "› Another experiment.md");
      await act(async () => {
        screen?.mockInput.pressArrow("down");
        screen?.mockInput.pressEnter();
      });
      await frameContaining(screen, "With        Work/Storage experiment.md");
      await act(async () => {
        await screen?.mockInput.typeText("Are the assumptions the same?");
      });
      await frameContaining(screen, "Are the assumptions the same?");
      await act(async () => {
        screen?.mockInput.pressKey("r", { ctrl: true });
      });
      const rendered = await frameContaining(screen, "Different assumptions:");
      expect(rendered).not.toContain("**Different assumptions:");
      expect(rendered).toContain("2 sources checked");
      expect(JSON.stringify(provider.requests[0])).toContain("Are the assumptions the same?");
      await act(async () => {
        screen?.mockInput.pressKey("1");
      });
      expect(opened?.revision).toBe(analysisSources[0].revision);
      expect(opened?.range.startLine).toBe(3);
      expect(session.result?.comparisons).toHaveLength(1);
      await act(async () => {
        screen?.renderer.destroy();
      });
      const calls = provider.requests.length;
      await mount();
      await frameContaining(screen, "Different assumptions:");
      expect(provider.requests).toHaveLength(calls);
      await act(async () => {
        screen?.mockInput.pressEscape();
      });
      await frameContaining(screen, "Are the assumptions the same?");
      provider.setMode("wait");
      await act(async () => {
        screen?.mockInput.pressKey("r", { ctrl: true });
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
