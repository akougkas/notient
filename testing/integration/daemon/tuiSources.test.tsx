import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { FsVault } from "../../../src/adapters/fsVault";
import { connectClient } from "../../../src/cli/client";
import { App } from "../../../src/cli/tui/runtime";
import { serializeConversation } from "../../../src/core/chat/conversationParser";
import { makeReadNoteTool } from "../../../src/core/chat/tools/vault";
import type { ChatMessage } from "../../../src/core/chat/types";
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
  "[smoke] restored TUI evidence opens exact passages beyond the first page and rejects edited sources",
  async () => {
    const vault = await mkdtemp(join(tmpdir(), "notient-tui-sources-"));
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    let screen: Screen | undefined;
    try {
      await mkdir(join(vault, "Notient/conversations"), { recursive: true });
      await mkdir(join(vault, "Research"));
      const read = makeReadNoteTool(new FsVault(vault));
      const messages: ChatMessage[] = [
        { role: "user", id: "u", content: "Compare our source evidence", createdAt: 1 },
      ];
      for (let i = 1; i <= 8; i++) {
        const path = `Research/Source ${i}.md`;
        await Bun.write(
          join(vault, path),
          `# Source ${i}\r\n\r\nVerified passage ${i}.\r\nOutside the selected evidence.\r\n`,
        );
        const data = await read.invoke(
          { notePath: path, lineRange: { start: 3, end: 3 } },
          new AbortController().signal,
          { clientIdentity: "human" },
        );
        messages.push({
          role: "assistant",
          id: `a${i}`,
          createdAt: i + 1,
          content: "",
          toolCalls: [{ id: `r${i}`, name: "vault.read_note", args: { notePath: path } }],
          toolResults: [{ callId: `r${i}`, status: "ok", durationMs: 1, data }],
        });
      }
      messages.push({
        role: "assistant",
        id: "final",
        createdAt: 10,
        content: "Eight sources support this answer. Suggested filename: [[Imaginary.md]].",
      });
      const conversation = conversationFixture({ messages, messageCount: messages.length });
      const transcript = serializeConversation(conversation);
      await Bun.write(join(vault, conversation.notePath), transcript);
      daemon = await startTestDaemon(vault);
      const connect = () =>
        connectClient({
          vaultPath: vault,
          socketPath: resolveSocketPath(vault, currentPlatform()),
          autoSpawn: false,
        });
      const client = await connect();
      await act(async () => {
        screen = await testRender(
          <App vaultPath={vault} client={client} connect={connect} onExit={() => {}} />,
          { width: 100, height: 30 },
        );
      });
      if (!screen) throw new Error("No terminal renderer");
      await frameContaining(screen, "Read sources · 8");
      expect(screen.captureCharFrame()).toContain("Source 1 · L3");
      expect(screen.captureCharFrame()).not.toContain("[1] Imaginary");
      await act(async () => {
        screen?.mockInput.pressEscape();
      });
      await frameContaining(screen, "o source");
      await act(async () => {
        await screen?.mockInput.pressKeys(Array(6).fill("\u001b[B"));
      });
      await frameContaining(screen, "[7] Source 7 · L3");
      for (const width of [60, 80, 120]) {
        await act(async () => {
          screen?.resize(width, 30);
        });
        expect(await frameContaining(screen, "[7] Source 7 · L3")).toContain("[8] Source 8 · L3");
      }
      await act(async () => {
        screen?.mockInput.pressKey("o");
      });
      await frameContaining(screen, "Verified passage 7.");
      expect(screen.captureCharFrame()).toContain("Cited passage");
      expect(screen.captureCharFrame()).not.toContain("Outside the selected evidence");
      await act(async () => {
        screen?.mockInput.pressKey("f");
      });
      await frameContaining(screen, "Outside the selected evidence");
      await act(async () => {
        screen?.mockInput.pressKey("3");
      });
      await frameContaining(screen, "Read sources · 8");
      await Bun.write(
        join(vault, "Research/Source 7.md"),
        "# Source 7\n\nA later human revision.\n",
      );
      await act(async () => {
        screen?.mockInput.pressEscape();
      });
      await frameContaining(screen, "o source");
      await act(async () => {
        screen?.mockInput.pressKey("o");
      });
      await frameContaining(screen, "f open current note");
      expect(screen.captureCharFrame()).not.toContain("Verified passage 7.");
      await act(async () => {
        screen?.mockInput.pressKey("f");
      });
      await frameContaining(screen, "A later human revision.");
      expect(await readFile(join(vault, conversation.notePath), "utf8")).toBe(transcript);
      expect(await readFile(join(vault, "Research/Source 7.md"), "utf8")).toBe(
        "# Source 7\n\nA later human revision.\n",
      );
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
