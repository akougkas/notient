import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createRpc } from "../../../src/cli/tui/rpc";
import { HistoryView } from "../../../src/cli/tui/views/HistoryView";
import { vaultStateDir } from "../../../src/core/vault/identity";
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
  "[smoke] history renders saved Markdown and requires review and confirmation before guarded undo",
  async () => {
    const vault = await mkdtemp(join(tmpdir(), "notient-tui-history-"));
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    let screen: Screen | undefined;
    try {
      daemon = await startTestDaemon(vault);
      const rpc = createRpc(daemon.client);
      await act(async () => {
        screen = await testRender(
          <HistoryView
            rpc={() => rpc}
            width={100}
            height={20}
            onClose={() => {}}
            onExit={() => {}}
          />,
          { width: 100, height: 20 },
        );
      });
      if (!screen) throw new Error("No history screen");
      const empty = await frameContaining(screen, "Your first saved thought will appear here.");
      expect(
        empty.split("\n").find((line) => line.includes("Your first saved thought")),
      ).not.toContain("0 changes");
      expect(empty).toContain("0 changes · page 1");
      const body = "# A considered thought\n\n**Keep my meaning.**\n";
      const preview = await rpc.previewChanges({
        idempotencyKey: "tui-history-create",
        changes: [{ kind: "create", path: "Thought.md", body, expected: null }],
      });
      await rpc.applyChanges({
        previewId: preview.previewId,
        previewRevision: preview.revision,
        idempotencyKey: "tui-history-apply",
      });
      await act(async () => {
        screen?.mockInput.pressKey("r");
      });
      await frameContaining(screen, "Thought.md");
      await act(async () => {
        screen?.mockInput.pressEnter();
      });
      await frameContaining(screen, "This note did not exist");
      await act(async () => {
        screen?.mockInput.pressTab();
      });
      const rendered = await frameContaining(screen, "Keep my meaning.");
      expect(rendered).not.toContain("**Keep my meaning.**");
      await act(async () => {
        screen?.mockInput.pressKey("r");
      });
      await frameContaining(screen, "**Keep my meaning.**");
      await act(async () => {
        screen?.mockInput.pressKey("u");
      });
      await frameContaining(screen, "Enter confirms");
      expect(await Bun.file(join(vault, "Thought.md")).text()).toBe(body);
      await act(async () => {
        screen?.mockInput.pressEscape();
      });
      await frameContaining(screen, "Undo cancelled");
      expect(await Bun.file(join(vault, "Thought.md")).exists()).toBe(true);
      await act(async () => {
        screen?.mockInput.pressKey("u");
      });
      await frameContaining(screen, "Enter confirms");
      await Bun.write(join(vault, "Thought.md"), "A later human thought.\n");
      await act(async () => {
        screen?.mockInput.pressEnter();
      });
      await frameContaining(screen, "changed");
      expect(await Bun.file(join(vault, "Thought.md")).text()).toBe("A later human thought.\n");
      await Bun.write(join(vault, "Thought.md"), body);
      await act(async () => {
        screen?.mockInput.pressEnter();
      });
      await frameContaining(screen, "Restored");
      expect(await Bun.file(join(vault, "Thought.md")).exists()).toBe(false);
      expect((await rpc.historyList()).entries[0].undo?.completedAt).toBeNumber();
      await act(async () => {
        screen?.mockInput.pressKey("u");
        screen?.mockInput.pressEnter();
      });
      expect((await rpc.historyList()).entries).toHaveLength(1);
    } finally {
      await act(async () => {
        screen?.renderer.destroy();
      });
      await daemon?.stop();
      await rm(vaultStateDir(vault), { recursive: true, force: true });
      await rm(vault, { recursive: true, force: true });
    }
  },
  60000,
);
