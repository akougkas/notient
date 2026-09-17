import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { connectClient } from "../../../src/cli/client";
import { rememberConversation, restoreConversation } from "../../../src/cli/tui/conversations";
import { createRpc } from "../../../src/cli/tui/rpc";
import { App } from "../../../src/cli/tui/runtime";
import { serializeConversation } from "../../../src/core/chat/conversationParser";
import { vaultStateDir } from "../../../src/core/vault/identity";
import { currentPlatform, resolveSocketPath } from "../../../src/daemon/socket";
import { conversationFixture } from "../../conversationFixture";
import { startTestDaemon } from "../../daemonHarness";

type Screen = Awaited<ReturnType<typeof testRender>>;

async function frameContaining(screen: Screen, text: string): Promise<string> {
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
  throw new Error(`TUI did not render ${JSON.stringify(text)}:\n${frame}`);
}

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] mounted TUI restores, switches and reopens real conversations across daemon restart without inference",
  async () => {
    const vault = await mkdtemp(join(tmpdir(), "notient-tui-threads-"));
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    let screen: Screen | undefined;
    const connect = () =>
      connectClient({
        vaultPath: vault,
        socketPath: resolveSocketPath(vault, currentPlatform()),
        autoSpawn: false,
      });
    const mount = async () => {
      let mounted: Screen | undefined;
      const client = await connect();
      await act(async () => {
        mounted = await testRender(
          <App vaultPath={vault} client={client} connect={connect} onExit={() => {}} />,
          { width: 100, height: 30 },
        );
      });
      if (!mounted) throw new Error("TUI did not mount");
      return mounted;
    };
    try {
      await mkdir(join(vault, "Notient/conversations"), { recursive: true });
      await mkdir(join(vault, "Research/Nested"), { recursive: true });
      await Bun.write(
        join(vault, "Research/Nested/Concurrent readers.md"),
        "---\nstatus: exploring\ntags: [systems]\n---\n# Readers\n\nRead a nested source without knowing its folder.\n\n## Experiment\nFirst experiment.\n\n## Experiment\nSecond experiment keeps a distinct target.\n\nAn exact explicit block. ^proof\n\n- [ ] Verify the result\n",
      );
      await Bun.write(
        join(vault, "Storage.md"),
        `# Storage\n\n## Recovery\n\nThe durable journal survives a restart. Long source paragraphs must wrap so the reader can verify the complete evidence, including the final word: marmot.\n${Array.from({ length: 60 }, (_, index) => `Source line ${index}`).join("\n")}\nEnd of source evidence.\n`,
      );
      const first = conversationFixture({ updatedAt: 10000 });
      const second = conversationFixture({
        id: "thread-second",
        notePath: "Notient/conversations/2026-09-16 Second thread-second.md",
        topic: "Recovery experiments",
        updatedAt: 9000,
      });
      const foreign = conversationFixture({
        id: "foreign-thread",
        notePath: "Notient/conversations/2026-09-16 Foreign foreign-thread.md",
        clientIdentity: "codex",
        topic: "Agent private thread",
        updatedAt: 20000,
      });
      const originals = new Map<string, string>();
      for (const conversation of [first, second, foreign]) {
        const bytes = serializeConversation(conversation);
        await Bun.write(join(vault, conversation.notePath), bytes);
        originals.set(conversation.notePath, bytes);
      }
      daemon = await startTestDaemon(vault);
      const indexedBy = performance.now() + 20000;
      while (!(await createRpc(daemon.client).resolveLink("[[Storage#Recovery]]")).resolved) {
        if (performance.now() >= indexedBy)
          throw new Error("Startup index did not discover Storage.md");
        await Bun.sleep(50);
      }
      expect(await createRpc(daemon.client).resolveLink("[[Storage#Recovery]]")).toEqual({
        ok: true,
        resolved: true,
        selector: { kind: "heading", text: "Recovery" },
        path: "Storage.md",
      });
      screen = await mount();
      expect(await frameContaining(screen, "Use a durable journal.")).toContain("Storage research");
      expect(screen.captureCharFrame()).not.toContain("Agent private thread");

      // Restored citations navigate through the existing canonical reader.
      await act(async () => {
        screen?.mockInput.pressEscape();
      });
      await frameContaining(screen, "o source");
      await act(async () => {
        screen?.mockInput.pressKey("o");
      });
      expect(await frameContaining(screen, "The durable journal survives")).toContain("Storage.md");
      expect(screen.captureCharFrame()).toContain("Cited passage");
      expect(screen.captureCharFrame()).toContain("marmot.");
      await act(async () => {
        await screen?.mockInput.pressKeys(Array(10).fill("\u001b[6~"));
      });
      await frameContaining(screen, "End of source evidence.");
      await act(async () => {
        await screen?.mockInput.pressKeys(Array(10).fill("\u001b[5~"));
      });
      await frameContaining(screen, "The durable journal survives");
      await act(async () => {
        screen?.mockInput.pressKey("f");
        screen?.mockInput.pressKey("r");
      });
      await frameContaining(screen, "# Storage");
      await act(async () => {
        screen?.mockInput.pressKey("3");
      });
      await frameContaining(screen, "Storage research");

      // The menu is available while composing and the note picker lists notes immediately.
      // Deliver navigation, query and Enter in one batch as a real terminal can.
      // None of the query may leak into the conversation composer or get sent.
      await act(async () => {
        screen?.mockInput.pressKey("p", { ctrl: true });
        await screen?.mockInput.typeText("find");
        screen?.mockInput.pressEnter();
      });
      await frameContaining(screen, "open ");
      await frameContaining(screen, "Storage.md");
      await act(async () => {
        await screen?.mockInput.typeText("STORAGE");
      });
      await frameContaining(screen, "› Storage.md");
      await act(async () => {
        screen?.mockInput.pressEnter();
      });
      await frameContaining(screen, "The durable journal survives");
      await act(async () => {
        screen?.mockInput.pressKey("r");
      });
      await frameContaining(screen, "# Storage");
      await act(async () => {
        screen?.mockInput.pressEscape();
      });
      await frameContaining(screen, "Storage research");

      await act(async () => {
        screen?.mockInput.pressKey("p", { ctrl: true });
        await screen?.mockInput.typeText("find");
        screen?.mockInput.pressEnter();
      });
      await act(async () => {
        await screen?.mockInput.typeText("READERS");
      });
      await frameContaining(screen, "Research/Nested/Concurrent readers.md");
      await act(async () => {
        screen?.mockInput.pressEnter();
      });
      await frameContaining(screen, "Read a nested source without knowing its folder.");
      await act(async () => {
        screen?.mockInput.pressArrow("right");
      });
      await frameContaining(screen, "On this note");
      expect(screen.captureCharFrame()).toContain("exploring");
      expect(screen.captureCharFrame()).toContain("1 open tasks");
      await act(async () => {
        screen?.mockInput.pressArrow("down");
        screen?.mockInput.pressArrow("down");
        screen?.mockInput.pressEnter();
      });
      await frameContaining(screen, "Second experiment keeps a distinct target.");
      expect(screen.captureCharFrame()).not.toContain("First experiment.");
      await act(async () => {
        screen?.mockInput.pressArrow("right");
      });
      await frameContaining(screen, "On this note");
      await act(async () => {
        screen?.mockInput.pressArrow("down");
        screen?.mockInput.pressArrow("down");
        screen?.mockInput.pressArrow("down");
        screen?.mockInput.pressEnter();
      });
      await frameContaining(screen, "An exact explicit block.");
      expect(screen.captureCharFrame()).not.toContain("Second experiment keeps");
      await act(async () => {
        screen?.mockInput.pressEscape();
      });
      await frameContaining(screen, "Storage research");

      await act(async () => {
        screen?.mockInput.pressKey("o", { ctrl: true });
        await screen?.mockInput.typeText("experiments");
        screen?.mockInput.pressEnter();
      });
      await frameContaining(screen, "Choose a thread");
      await frameContaining(screen, "threads experiments");
      await act(async () => {
        screen?.mockInput.pressEnter();
      });
      await frameContaining(screen, "Conversation restored.");
      expect(screen.captureCharFrame()).toContain("Recovery experiments");

      // An unsent draft must survive an attempted thread switch.
      await act(async () => {
        await screen?.mockInput.typeText("unsent draft");
      });
      await act(async () => {
        screen?.mockInput.pressKey("n", { ctrl: true });
      });
      expect(await frameContaining(screen, "Send or clear your draft")).toContain("unsent draft");
      await act(async () => {
        await daemon?.stop();
      });
      daemon = undefined;
      await frameContaining(screen, "daemon disconnected");
      daemon = await startTestDaemon(vault);
      await act(async () => {
        screen?.mockInput.pressEscape();
      });
      const reconnected = await frameContaining(screen, "Reconnected. Conversation restored.");
      expect(reconnected).toContain("Recovery experiments");
      expect(reconnected).toContain("unsent draft");
      await act(async () => {
        screen?.renderer.destroy();
      });
      screen = undefined;
      await daemon.stop();
      daemon = await startTestDaemon(vault);
      screen = await mount();
      await frameContaining(screen, "Recovery experiments");
      await frameContaining(screen, "Use a durable journal.");

      await act(async () => {
        screen?.mockInput.pressKey("n", { ctrl: true });
      });
      await frameContaining(screen, "A place to think with your notes");
      expect((await createRpc(daemon.client).chatList()).conversations).toHaveLength(3);

      // The advertised composer commands use the same thread actions.
      await act(async () => {
        await screen?.mockInput.typeText("/threads");
      });
      await act(async () => {
        screen?.mockInput.pressEnter();
      });
      const picker = await frameContaining(screen, "Choose a thread");
      expect(picker).toContain("Recovery experiments");
      expect(picker).not.toContain("Agent private thread");
      for (const [path, bytes] of originals)
        expect(await readFile(join(vault, path), "utf8")).toBe(bytes);

      // A missing saved transcript is an error, not an excuse to create another.
      await rememberConversation(vault, "human", "Notient/conversations/Missing.md");
      await expect(restoreConversation(createRpc(daemon.client), vault)).rejects.toThrow();
      expect((await createRpc(daemon.client).chatList()).conversations).toHaveLength(3);
    } finally {
      await act(async () => {
        screen?.renderer.destroy();
      });
      await daemon?.stop();
      await rm(vault, { recursive: true, force: true });
      await rm(vaultStateDir(vault), { recursive: true, force: true });
    }
  },
  60000,
);
