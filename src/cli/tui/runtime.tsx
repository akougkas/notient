import { type KeyEvent, createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import type React from "react";
import { useCallback, useState } from "react";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { type ClientHandle, connectClient } from "../client";
import type { Emitter } from "../output";
import { type ChatLine, ChatView } from "./ChatView";
import { InputBar } from "./InputBar";
import { completeAtMention } from "./attachments";
import { dispatchSlashCommand, isSlashCommand } from "./slashCommands";

export interface TuiRuntimeOptions {
  vaultPath: string;
  emitter: Emitter;
}

export async function startTuiRuntime(options: TuiRuntimeOptions): Promise<void> {
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({
    socketPath,
    vaultPath: options.vaultPath,
  });

  const conversationId = await startConversation(client);
  const renderer = await createCliRenderer({});
  const root = createRoot(renderer);

  await new Promise<void>((resolve) => {
    const onExit = (): void => {
      root.unmount();
      try {
        renderer.destroy?.();
      } catch {
        // best-effort teardown
      }
      resolve();
    };
    root.render(
      <App
        vaultPath={options.vaultPath}
        client={client}
        conversationId={conversationId}
        onExit={onExit}
      />,
    );
  });
  await client.close();
}

async function startConversation(client: ClientHandle): Promise<string> {
  for await (const frame of client.call("chat.start", { topic: "TUI session" })) {
    if (frame.type === "result") {
      const detail = frame as unknown as { conversation?: { id?: string } };
      const id = detail.conversation?.id;
      if (typeof id !== "string") throw new Error("chat.start result missing id");
      return id;
    }
    if (frame.type === "error") {
      throw new Error(`chat.start failed: ${(frame as { message?: string }).message ?? "unknown"}`);
    }
  }
  throw new Error("chat.start returned no result frame");
}

interface AppProps {
  vaultPath: string;
  client: ClientHandle;
  conversationId: string;
  onExit: () => void;
}

function App({ vaultPath, client, conversationId, onExit }: AppProps): React.ReactNode {
  const [lines, setLines] = useState<ChatLine[]>([
    {
      kind: "system",
      text: "Notient ready. Type /help for commands; /quit to exit.",
    },
  ]);
  const [buffer, setBuffer] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [pendingApprovals, setPendingApprovals] = useState<Map<string, string>>(new Map());

  const submit = useCallback(
    async (text: string) => {
      if (text.trim().length === 0) return;
      if (isSlashCommand(text)) {
        const outcome = await dispatchSlashCommand(text, { client, vaultPath });
        if (outcome.message.length > 0) {
          setLines((prior) => [...prior, { kind: "system", text: outcome.message }]);
        }
        if (outcome.exit) onExit();
        return;
      }
      setLines((prior) => [...prior, { kind: "user", text }]);
      setBusy(true);
      try {
        await runChatTurn(client, conversationId, text, setLines, setPendingApprovals);
      } finally {
        setBusy(false);
      }
    },
    [client, conversationId, onExit, vaultPath],
  );

  const handleKey = useCallback(
    (event: KeyEvent) => {
      if (event.eventType !== "press" && event.eventType !== "repeat") return;
      if (event.ctrl && event.name === "c") {
        onExit();
        return;
      }
      if (busy) return;
      if (event.name === "tab" && !event.shift && !event.ctrl) {
        handleTabKey(buffer, setBuffer, setLines, client);
        return;
      }
      handleEditingKey(event, buffer, setBuffer, submit);
    },
    [busy, buffer, client, onExit, submit],
  );
  useKeyboard(handleKey);

  return (
    <box flexDirection="column" width="100%" height="100%">
      <StatusBar vaultPath={vaultPath} busy={busy} pendingCount={pendingApprovals.size} />
      <ChatView lines={lines} />
      <InputBar busy={busy} buffer={buffer} />
    </box>
  );
}

function StatusBar({
  vaultPath,
  busy,
  pendingCount,
}: {
  vaultPath: string;
  busy: boolean;
  pendingCount: number;
}): React.ReactNode {
  return (
    <box height={1} backgroundColor="#222222" paddingLeft={1} paddingRight={1}>
      <text fg="#94A3B8">{buildStatusLabel(vaultPath, busy, pendingCount)}</text>
    </box>
  );
}

export function buildStatusLabel(vaultPath: string, busy: boolean, pendingCount: number): string {
  const vaultLabel = vaultPath.split("/").pop() ?? vaultPath;
  const state = busy ? "thinking…" : "idle";
  const base = `notient · vault:${vaultLabel} · ${state}`;
  return pendingCount > 0 ? `${base} · pending:${pendingCount}` : base;
}

export function frameToErrorLine(frame: { type: "error"; message?: unknown }): ChatLine {
  const message = typeof frame.message === "string" ? frame.message : "unknown";
  return { kind: "error", text: `rpc error: ${message}` };
}

async function runChatTurn(
  client: ClientHandle,
  conversationId: string,
  userMessage: string,
  setLines: React.Dispatch<React.SetStateAction<ChatLine[]>>,
  setPendingApprovals: React.Dispatch<React.SetStateAction<Map<string, string>>>,
): Promise<void> {
  const turnState = { assistantBuffer: "" };
  for await (const frame of client.call("chat.send", {
    conversationId,
    userMessage,
  })) {
    if (frame.type === "event") {
      handleStreamEvent(
        frame as unknown as { event: string; [key: string]: unknown },
        turnState,
        setLines,
        setPendingApprovals,
      );
      continue;
    }
    if (frame.type === "result") break;
    if (frame.type === "error") {
      const errorLine = frameToErrorLine(frame as { type: "error"; message?: unknown });
      setLines((prior) => [...prior, errorLine]);
      break;
    }
  }
}

interface TurnState {
  assistantBuffer: string;
}

function handleStreamEvent(
  detail: { event: string; [key: string]: unknown },
  turnState: TurnState,
  setLines: React.Dispatch<React.SetStateAction<ChatLine[]>>,
  setPendingApprovals: React.Dispatch<React.SetStateAction<Map<string, string>>>,
): void {
  switch (detail.event) {
    case "loop:assistant_delta":
      turnState.assistantBuffer += (detail.contentDelta as string | undefined) ?? "";
      setLines((prior) => upsertAssistant(prior, turnState.assistantBuffer));
      return;
    case "loop:tool_call_started":
      setLines((prior) => [...prior, { kind: "tool", text: (detail.tool as string) ?? "tool" }]);
      return;
    case "loop:tool_call_result": {
      const callId = (detail.callId as string | undefined) ?? "";
      setLines((prior) => [...prior, { kind: "tool", text: `done ${callId.slice(0, 8)}` }]);
      return;
    }
    case "loop:tool_call_error":
      setLines((prior) => [
        ...prior,
        { kind: "error", text: `tool error: ${(detail.error as string) ?? ""}` },
      ]);
      return;
    case "loop:approval_pending": {
      const callId = (detail.callId as string) ?? "";
      const tool = (detail.tool as string) ?? "tool";
      setPendingApprovals((prior) => {
        const next = new Map(prior);
        next.set(callId, tool);
        return next;
      });
      setLines((prior) => [
        ...prior,
        {
          kind: "approval",
          text: `pending: ${tool} (callId=${callId}). use /approve ${callId} or /deny ${callId}.`,
          callId,
        },
      ]);
      return;
    }
    case "loop:approval_resolved": {
      const callId = (detail.callId as string) ?? "";
      setPendingApprovals((prior) => {
        const next = new Map(prior);
        next.delete(callId);
        return next;
      });
      return;
    }
    case "loop:context_summarized":
      setLines((prior) => [
        ...prior,
        {
          kind: "system",
          text: `context summarized (${detail.originalTokens} → ${detail.summarizedTokens} tokens)`,
        },
      ]);
      return;
    case "loop:context_overflow_warning":
      setLines((prior) => [
        ...prior,
        {
          kind: "system",
          text: `warning: configured modelContextTokens=${detail.configuredTokens} but turn estimates ${detail.estimatedTokens} tokens. Increase chat.modelContextTokens.`,
        },
      ]);
      return;
    case "loop:tool_mode_probed":
      setLines((prior) => [
        ...prior,
        {
          kind: "system",
          text: `tool-mode for ${detail.model}: ${detail.mode} (attempts=${detail.attempts})`,
        },
      ]);
      return;
  }
}

function upsertAssistant(lines: ChatLine[], buffer: string): ChatLine[] {
  const last = lines[lines.length - 1];
  if (last && last.kind === "assistant" && last.streaming === true) {
    const next = lines.slice(0, -1);
    next.push({ kind: "assistant", text: buffer, streaming: true });
    return next;
  }
  return [...lines, { kind: "assistant", text: buffer, streaming: true }];
}

function handleTabKey(
  buffer: string,
  setBuffer: React.Dispatch<React.SetStateAction<string>>,
  setLines: React.Dispatch<React.SetStateAction<ChatLine[]>>,
  client: ClientHandle,
): void {
  const lastSpaceIndex = buffer.lastIndexOf(" ");
  const trailing = lastSpaceIndex < 0 ? buffer : buffer.slice(lastSpaceIndex + 1);
  if (!trailing.startsWith("@")) return;
  const appendSystemLine = (text: string): void => {
    setLines((prior) => [...prior, { kind: "system", text }]);
  };
  void completeAtMention(trailing.slice(1), buffer, lastSpaceIndex, setBuffer, appendSystemLine, {
    client,
  });
}

function handleEditingKey(
  event: KeyEvent,
  buffer: string,
  setBuffer: React.Dispatch<React.SetStateAction<string>>,
  submit: (text: string) => void | Promise<void>,
): void {
  if (event.name === "return" || event.name === "enter") {
    setBuffer("");
    void submit(buffer);
    return;
  }
  if (event.name === "backspace") {
    setBuffer((prior) => prior.slice(0, -1));
    return;
  }
  if (event.sequence.length === 1 && !event.ctrl && !event.meta) {
    const char = event.sequence;
    setBuffer((prior) => prior + char);
  }
}
