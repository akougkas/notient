import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { newDraft } from "../../../src/api/drafts";
import { connectClient } from "../../../src/cli/client";
import { DraftStore } from "../../../src/cli/tui/draft";
import { createRpc } from "../../../src/cli/tui/rpc";
import { App } from "../../../src/cli/tui/runtime";
import { WritingView } from "../../../src/cli/tui/views/WritingView";
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
  "[smoke] prepared note opens as editable Markdown without chat commentary and only writes after review",
  async () => {
    const vault = await mkdtemp(join(tmpdir(), "notient-prepared-writing-"));
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    let screen: Screen | undefined;
    const draft = {
      title: "Storage thought",
      markdown:
        "# Storage thought\n\nMy open question needs evidence.\n\n- [ ] Test crash recovery\n",
    };
    const conversation = conversationFixture({ pinnedContext: [] });
    conversation.messages[1] = {
      id: "prepared",
      role: "assistant",
      content: "Conversational explanation stays in chat.",
      createdAt: 1001,
      toolCalls: [{ id: "draft-1", name: "notes.prepare_draft", args: draft }],
      toolResults: [{ callId: "draft-1", status: "ok", data: draft, durationMs: 0 }],
    };
    try {
      await mkdir(join(vault, "Notient/conversations"), { recursive: true });
      await writeFile(join(vault, conversation.notePath), serializeConversation(conversation));
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
          { width: 100, height: 32 },
        );
      });
      if (!screen) throw new Error("TUI did not mount");
      await frameContaining(screen, "Unsaved draft");
      await act(async () => {
        screen?.mockInput.pressKey("s", { ctrl: true });
      });
      await frameContaining(screen, "To Inbox/Storage thought.md");
      expect(await Bun.file(join(vault, "Inbox/Storage thought.md")).exists()).toBe(false);
      await act(async () => {
        screen?.mockInput.pressKey("s", { ctrl: true });
      });
      await frameContaining(screen, "Ready to become a note");
      const stored = await new DraftStore(vault, "human").load();
      expect(stored?.body).toBe(draft.markdown);
      expect(stored?.body).not.toContain("Conversational explanation");

      expect(await Bun.file(join(vault, "Inbox/Storage thought.md")).exists()).toBe(false);
      await act(async () => {
        screen?.mockInput.pressKey("s", { ctrl: true });
      });
      await frameContaining(screen, "Saved Inbox/Storage thought.md");
      expect(await readFile(join(vault, "Inbox/Storage thought.md"), "utf8")).toBe(draft.markdown);
      expect(await readFile(join(vault, conversation.notePath), "utf8")).toBe(
        serializeConversation(conversation),
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
  30000,
);

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] capture survives closing, previews before writing, records history and guards an edited revision",
  async () => {
    const vault = await mkdtemp(join(tmpdir(), "notient-tui-writing-"));
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    let screen: Screen | undefined;
    const store = new DraftStore(vault, "human");
    const connect = () =>
      connectClient({
        vaultPath: vault,
        socketPath: resolveSocketPath(vault, currentPlatform()),
        autoSpawn: false,
      });
    const mount = async () => {
      const client = await connect();
      await act(async () => {
        screen = await testRender(
          <App vaultPath={vault} client={client} connect={connect} onExit={() => {}} />,
          { width: 100, height: 30 },
        );
      });
    };
    try {
      daemon = await startTestDaemon(vault);
      const rpc = createRpc(daemon.client);
      await mount();
      if (!screen) throw new Error("TUI did not mount");
      await frameContaining(screen, "A place to think");
      await act(async () => {
        screen?.mockInput.pressKey("b", { ctrl: true });
      });
      await frameContaining(screen, "Start anywhere");
      const thought =
        "# A useful thought\n\nMy meaning stays mine.\n\n- [ ] Try the smallest experiment\n";
      await act(async () => {
        await screen?.mockInput.pasteBracketedText(thought);
      });
      await frameContaining(screen, "My meaning stays mine.");
      await act(async () => {
        screen?.mockInput.pressKey("l", { ctrl: true });
        screen?.mockInput.pressKey("a", { ctrl: true });
        screen?.mockInput.pressKey("k", { ctrl: true });
        await screen?.mockInput.typeText("Inbox/Captured thought.md");
        screen?.mockInput.pressKey("l", { ctrl: true });
      });
      await frameContaining(screen, "To Inbox/Captured thought.md");
      await act(async () => {
        screen?.mockInput.pressEscape();
      });
      await frameContaining(screen, "A place to think");
      expect((await store.load())?.body).toBe(thought);
      expect(await Bun.file(join(vault, "Inbox/Captured thought.md")).exists()).toBe(false);

      // Destroying the renderer and mounting a new client exercises disk recovery.
      await act(async () => {
        screen?.renderer.destroy();
      });
      await mount();
      await frameContaining(screen, "A place to think");
      await act(async () => {
        screen?.mockInput.pressKey("b", { ctrl: true });
      });
      await frameContaining(screen, "Your unsaved draft is restored");
      await frameContaining(screen, "My meaning stays mine.");
      await act(async () => {
        screen?.mockInput.pressKey("s", { ctrl: true });
      });
      await frameContaining(screen, "Ready to become a note");
      expect(await Bun.file(join(vault, "Inbox/Captured thought.md")).exists()).toBe(false);
      expect((await store.load())?.preview?.effects[0]?.after).toBe(thought);
      await act(async () => {
        screen?.mockInput.pressKey("s", { ctrl: true });
      });
      await frameContaining(screen, "Saved Inbox/Captured thought.md");
      expect(await readFile(join(vault, "Inbox/Captured thought.md"), "utf8")).toBe(thought);
      expect(await store.load()).toBeNull();
      const created = (await rpc.historyList()).entries;
      expect(created).toHaveLength(1);

      await act(async () => {
        screen?.mockInput.pressKey("e");
      });
      await frameContaining(screen, "Edit note");
      await frameContaining(screen, "My meaning stays mine.");
      await act(async () => {
        await screen?.mockInput.pressKeys(["\u001b[1;5F"]);
        await screen?.mockInput.pasteBracketedText("An edited thought.\n");
      });
      await act(async () => {
        screen?.mockInput.pressKey("s", { ctrl: true });
      });
      await frameContaining(screen, "Ready to become a note");
      await frameContaining(screen, "An edited thought.");
      await act(async () => {
        screen?.mockInput.pressKey("s", { ctrl: true });
      });
      await frameContaining(screen, "Saved Inbox/Captured thought.md");
      const edited = await readFile(join(vault, "Inbox/Captured thought.md"), "utf8");
      expect(edited).toBe(`${thought}An edited thought.\n`);
      const changed = (await rpc.historyList()).entries;
      expect(changed).toHaveLength(2);

      // The human changes the source after review; apply must preserve that newer edit.
      await act(async () => {
        screen?.mockInput.pressKey("e");
      });
      await frameContaining(screen, "Edit note");
      await frameContaining(screen, "An edited thought.");
      await act(async () => {
        await screen?.mockInput.pasteBracketedText("Stale draft.\n");
      });
      await act(async () => {
        screen?.mockInput.pressKey("s", { ctrl: true });
      });
      await frameContaining(screen, "Ready to become a note");
      await Bun.write(join(vault, "Inbox/Captured thought.md"), "An independent human edit.\n");
      await act(async () => {
        screen?.mockInput.pressKey("s", { ctrl: true });
      });
      await frameContaining(screen, "needs attention");
      expect(await readFile(join(vault, "Inbox/Captured thought.md"), "utf8")).toBe(
        "An independent human edit.\n",
      );
      expect((await store.load())?.body).toContain("Stale draft.");
      expect((await rpc.historyList()).entries).toHaveLength(2);
      await act(async () => {
        screen?.mockInput.pressKey("x", { ctrl: true });
        screen?.mockInput.pressEnter();
      });
      await frameContaining(screen, "Saved Inbox/Captured thought.md");
      expect(await store.load()).toBeNull();
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

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] reviewed answer recovery retries an ambiguous save after daemon restart without a second effect",
  async () => {
    const vault = await mkdtemp(join(tmpdir(), "notient-tui-retry-"));
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    let screen: Screen | undefined;
    const store = new DraftStore(vault, "human");
    const saved: string[] = [];
    const diagnostics: unknown[] = [];
    const answer = `# An answer worth keeping\n\n${Array.from({ length: 70 }, (_, index) => `Evidence paragraph ${index}.\n`).join("\n")}\nLast source retained.\n`;
    try {
      daemon = await startTestDaemon(vault);
      let rpc = createRpc(daemon.client);
      const draft = newDraft("Inbox", "My original thought");
      draft.path = "Inbox/Kept answer.md";
      await store.save(draft);
      let interruptReply = true;
      const mount = async () => {
        const transport = {
          ...rpc,
          applyChanges: async (input: Parameters<typeof rpc.applyChanges>[0]) => {
            diagnostics.push({ applying: input });
            const result = await rpc.applyChanges(input);
            diagnostics.push({ result });
            if (interruptReply) {
              interruptReply = false;
              throw new Error(
                "Connection lost after dispatch; outcome unknown. Retry the reviewed save.",
              );
            }
            return result;
          },
        };
        await act(async () => {
          screen = await testRender(
            <WritingView
              vaultPath={vault}
              identity="human"
              request={{ text: answer }}
              width={100}
              height={30}
              rpc={() => transport}
              onClose={() => {}}
              onExit={() => {}}
              onThink={() => {}}
              onReconnect={async () => {}}
              onSaved={(path) => {
                saved.push(path);
              }}
            />,
            { width: 100, height: 30 },
          );
        });
      };
      await mount();
      if (!screen) throw new Error("TUI did not mount");
      await frameContaining(screen, "My original thought");
      expect((await store.load())?.body).toBe("My original thought");
      await act(async () => {
        screen?.mockInput.pressKey("b", { ctrl: true });
      });
      await frameContaining(screen, "# An answer worth keeping");
      await act(async () => {
        screen?.mockInput.pressKey("s", { ctrl: true });
      });
      await frameContaining(screen, "Ready to become a note");
      await act(async () => {
        await screen?.mockInput.pressKeys(Array(15).fill("\u001b[6~"));
      });
      await frameContaining(screen, "Last source retained.");
      await act(async () => {
        screen?.mockInput.pressKey("s", { ctrl: true });
      });
      await frameContaining(screen, "outcome unknown");
      expect(saved).toEqual([]);
      expect(await readFile(join(vault, draft.path), "utf8")).toBe(answer);
      const reviewedId = (await store.load())?.preview?.previewId;
      expect(reviewedId).toBeString();
      expect((await rpc.historyList()).entries).toHaveLength(1);
      await act(async () => {
        screen?.renderer.destroy();
      });
      screen = undefined;
      await daemon.stop();
      daemon = await startTestDaemon(vault);
      rpc = createRpc(daemon.client);
      await mount();
      if (!screen) throw new Error("TUI did not remount");
      (screen as Screen).renderer.keyInput.on("keypress", (key) => {
        diagnostics.push({
          key: { name: key.name, ctrl: key.ctrl, repeated: key.repeated, eventType: key.eventType },
        });
      });
      await frameContaining(screen, "Ready to become a note");
      expect((await store.load())?.preview?.previewId).toBe(reviewedId);
      await act(async () => {
        screen?.mockInput.pressKey("s", { ctrl: true });
      });
      const deadline = performance.now() + 8000;
      while (!saved.length && performance.now() < deadline)
        await act(async () => {
          await Bun.sleep(25);
        });
      if (!saved.length)
        throw new Error(
          `Recovered save failed: ${JSON.stringify(diagnostics)}\n${screen.captureCharFrame()}`,
        );
      expect(saved).toEqual([draft.path]);
      expect(await store.load()).toBeNull();
      const history = (await rpc.historyList()).entries;
      expect(history).toHaveLength(1);
      expect(
        (
          await rpc.undoHistory({
            id: history[0].id,
            sources: (await rpc.historyEntry(history[0].id)).sources,
            idempotencyKey: "undo-recovered-capture",
          })
        ).ok,
      ).toBe(true);
      expect(await Bun.file(join(vault, draft.path)).exists()).toBe(false);
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

test.skipIf(process.env.NOTIENT_SMOKE !== "1")(
  "[smoke] TUI history and guarded undo decode actual structural move receipts",
  async () => {
    const vault = await mkdtemp(join(tmpdir(), "notient-tui-move-"));
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    try {
      await Bun.write(join(vault, "Thought.md"), "# A thought\n\nKeep these exact bytes.\n");
      daemon = await startTestDaemon(vault);
      const rpc = createRpc(daemon.client);
      const original = await rpc.noteBody("Thought.md");
      const preview = await rpc.previewChanges({
        idempotencyKey: "archive-one",
        changes: [
          {
            kind: "archive",
            source: original.note,
            destination: "Archive/Thought.md",
            updateReferences: false,
          },
        ],
      });
      const result = await rpc.applyChanges({
        previewId: preview.previewId,
        previewRevision: preview.revision,
        idempotencyKey: "apply-archive-one",
      });
      expect(result.state).toBe("applied");
      const history = await rpc.historyList();
      expect(history.entries[0].kind).toBe("notes.move");
      expect(
        (
          await rpc.undoHistory({
            id: history.entries[0].id,
            sources: (await rpc.historyEntry(history.entries[0].id)).sources,
            idempotencyKey: "undo-archive",
          })
        ).entry.kind,
      ).toBe("notes.move");
      expect((await rpc.noteBody("Thought.md")).body).toBe(original.body);
      expect(await Bun.file(join(vault, "Archive/Thought.md")).exists()).toBe(false);
    } finally {
      await daemon?.stop();
      await rm(vault, { recursive: true, force: true });
      await rm(vaultStateDir(vault), { recursive: true, force: true });
    }
  },
  30000,
);
