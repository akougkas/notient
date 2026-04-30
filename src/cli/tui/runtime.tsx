import { join } from "node:path";
import { type KeyEvent, type ScrollBoxRenderable, createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useTerminalDimensions } from "@opentui/react";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { type ClientHandle, connectClient } from "../client";
import type { Emitter } from "../output";
import { type ChatLine, ChatView } from "./ChatView";
import { InputBar } from "./InputBar";
import { completeAtMention } from "./attachments";
import {
  type HistoryKeyName,
  type HistoryNav,
  appendHistoryToFile,
  createHistoryNav,
  historyAppend,
  historyReset,
  loadHistoryFromFile,
  routeHistoryKey,
} from "./history";
import { computeInputHeight } from "./inputBindings";
import { type ProposalListItem, dispatchSlashCommand, isSlashCommand } from "./slashCommands";
import { type StatusBarFields, buildStatusBar, estimateTokens } from "./statusBar";

const HISTORY_MAX = 100;

export interface TuiRuntimeOptions {
  vaultPath: string;
  emitter: Emitter;
  clientIdentity?: string;
}

export async function startTuiRuntime(options: TuiRuntimeOptions): Promise<void> {
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const client = await connectClient({
    socketPath,
    vaultPath: options.vaultPath,
    clientIdentity: options.clientIdentity,
  });

  const session = await startConversation(client);
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
        conversationId={session.id}
        topic={session.topic}
        onExit={onExit}
      />,
    );
  });
  await client.close();
}

interface ConversationSession {
  readonly id: string;
  readonly topic: string;
}

async function startConversation(client: ClientHandle): Promise<ConversationSession> {
  for await (const frame of client.call("chat.start", { topic: "TUI session" })) {
    if (frame.type === "result") {
      const detail = frame as unknown as { conversation?: { id?: string; topic?: string } };
      const id = detail.conversation?.id;
      if (typeof id !== "string") throw new Error("chat.start result missing id");
      const topic =
        typeof detail.conversation?.topic === "string" ? detail.conversation.topic : "TUI session";
      return { id, topic };
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
  topic: string;
  onExit: () => void;
}

function App({ vaultPath, client, conversationId, topic, onExit }: AppProps): React.ReactNode {
  const [lines, setLines] = useState<ChatLine[]>([
    {
      kind: "system",
      text: "Notient ready. Type /help for commands; /quit to exit.",
    },
  ]);
  const [buffer, setBuffer] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [pendingApprovals, setPendingApprovals] = useState<Map<string, string>>(new Map());
  const [proposalItems, setProposalItems] = useState<ProposalListItem[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [lastTurnTokens, setLastTurnTokens] = useState<number | null>(null);
  const lastAssistantRef = useRef<string | null>(null);

  const historyPath = useMemo(() => join(vaultPath, ".notient", "history.txt"), [vaultPath]);
  const [historyNav, setHistoryNav] = useState<HistoryNav>(() =>
    createHistoryNav(loadHistoryFromFile(historyPath, HISTORY_MAX)),
  );
  const historyAnchorRef = useRef<string | null>(null);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);

  // Surface the daemon's startup probe once at TUI boot if it found a
  // mismatch. The probe runs fire-and-forget at daemon seal so it is
  // usually ready by the time the TUI connects; if it isn't yet, we just
  // skip — the operator can re-run /model show later.
  useEffect(() => {
    const cancel = { value: false };
    void surfaceProbeWarning(client, cancel, (text) => {
      setLines((prior) => [...prior, { kind: "system", text }]);
    });
    return () => {
      cancel.value = true;
    };
  }, [client]);

  const handleBufferChange = useCallback((next: string) => {
    setBuffer(next);
    if (historyAnchorRef.current !== null && historyAnchorRef.current !== next) {
      historyAnchorRef.current = null;
      setHistoryNav((prior) => historyReset(prior));
    }
  }, []);

  const runSlash = useCallback(
    async (line: string): Promise<void> => {
      const outcome = await dispatchSlashCommand(line, {
        client,
        vaultPath,
        getLastAssistant: () => lastAssistantRef.current,
      });
      if (outcome.resetTranscript) {
        setLines([{ kind: "system", text: "Transcript cleared." }]);
      } else if (outcome.message.length > 0) {
        setLines((prior) => [...prior, { kind: "system", text: outcome.message }]);
      }
      if (outcome.proposalItems !== undefined) {
        setProposalItems(outcome.proposalItems);
      }
      if (outcome.exit) onExit();
    },
    [client, onExit, vaultPath],
  );

  const submit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      setBuffer("");
      historyAnchorRef.current = null;
      setHistoryNav((prior) => historyAppend(prior, trimmed, HISTORY_MAX));
      appendHistoryToFile(historyPath, trimmed, HISTORY_MAX);
      if (isSlashCommand(trimmed)) {
        await runSlash(trimmed);
        return;
      }
      setLines((prior) => [...prior, { kind: "user", text: trimmed }]);
      setBusy(true);
      try {
        const finalAssistant = await runChatTurn(
          client,
          conversationId,
          trimmed,
          setLines,
          setPendingApprovals,
          setModel,
          setLastTurnTokens,
        );
        if (finalAssistant.length > 0) lastAssistantRef.current = finalAssistant;
      } finally {
        setBusy(false);
      }
    },
    [client, conversationId, historyPath, runSlash],
  );

  const tryHistoryKey = useCallback(
    (event: KeyEvent): boolean => {
      const keyName: HistoryKeyName =
        event.name === "up" ? "up" : event.name === "down" ? "down" : "other";
      if (keyName === "other") return false;
      const routed = routeHistoryKey({
        keyName,
        nav: historyNav,
        buffer,
        inHistory: historyAnchorRef.current !== null,
      });
      if (routed === null) return false;
      setHistoryNav(routed.nav);
      setBuffer(routed.value);
      historyAnchorRef.current = routed.anchor;
      event.preventDefault();
      return true;
    },
    [buffer, historyNav],
  );

  const tryPageScroll = useCallback((event: KeyEvent): boolean => {
    if (event.name !== "pageup" && event.name !== "pagedown") return false;
    const scroll = scrollRef.current;
    if (scroll) {
      scroll.scrollBy({ x: 0, y: event.name === "pageup" ? -0.9 : 0.9 }, "viewport");
      event.preventDefault();
    }
    return true;
  }, []);

  const handleKey = useCallback(
    (event: KeyEvent) => {
      if (event.eventType !== "press" && event.eventType !== "repeat") return;
      if (event.ctrl && event.name === "c") {
        onExit();
        return;
      }
      if (tryPageScroll(event)) return;
      if (busy) return;
      if (tryProposalKey(event, buffer, proposalItems, runSlash, setProposalItems)) return;
      if (event.name === "tab" && !event.shift && !event.ctrl) {
        handleTabKey(buffer, handleBufferChange, setLines, client);
        event.preventDefault();
        return;
      }
      tryHistoryKey(event);
    },
    [
      busy,
      buffer,
      client,
      handleBufferChange,
      onExit,
      proposalItems,
      runSlash,
      tryHistoryKey,
      tryPageScroll,
    ],
  );
  useKeyboard(handleKey);

  const { width } = useTerminalDimensions();
  const inputHeight = computeInputHeight(buffer, Math.max(1, width - 2), 6);

  const statusFields = useMemo<StatusBarFields>(
    () => ({
      vaultPath,
      topic,
      model,
      busy,
      pendingCount: pendingApprovals.size,
      lastTurnTokens,
    }),
    [vaultPath, topic, model, busy, pendingApprovals, lastTurnTokens],
  );

  const handleSubmit = useCallback(
    (final: string) => {
      void submit(final);
    },
    [submit],
  );

  return (
    <box flexDirection="column" width="100%" height="100%">
      <StatusBar fields={statusFields} />
      <ChatView lines={lines} scrollRef={scrollRef} />
      <InputBar
        busy={busy}
        value={buffer}
        height={inputHeight}
        focused={!busy}
        onChange={handleBufferChange}
        onSubmit={handleSubmit}
      />
      <FooterHint />
    </box>
  );
}

async function surfaceProbeWarning(
  client: ClientHandle,
  cancel: { value: boolean },
  emit: (text: string) => void,
): Promise<void> {
  try {
    for await (const frame of client.call("daemon.status", {})) {
      if (cancel.value) return;
      if (frame.type !== "result") continue;
      const probe = (frame as { probe?: { status: string; message: string } }).probe;
      if (!probe || probe.status === "ok") return;
      emit(`startup probe: ${probe.message}`);
      return;
    }
  } catch {
    // best-effort surfacing
  }
}

function FooterHint(): React.ReactNode {
  return (
    <box height={1} paddingLeft={1} paddingRight={1}>
      <text fg="#475569">
        Ctrl+C exit · Ctrl+U cut-to-start · Ctrl+W kill word · Tab @-complete · Up/Dn history ·
        PgUp/PgDn scroll · Shift+Enter newline
      </text>
    </box>
  );
}

function StatusBar({ fields }: { fields: StatusBarFields }): React.ReactNode {
  const segments = buildStatusBar(fields);
  return (
    <box
      height={1}
      backgroundColor="#0F172A"
      paddingLeft={1}
      paddingRight={1}
      flexDirection="row"
      justifyContent="space-between"
    >
      <text fg="#94A3B8">{segments.left}</text>
      <text fg="#94A3B8">{segments.right}</text>
    </box>
  );
}

/**
 * Re-exported so existing callers (notably runtime.test.ts) keep their
 * single-line label assertions while the rendered status bar uses the new
 * two-segment layout.
 */
export function buildStatusLabel(vaultPath: string, busy: boolean, pendingCount: number): string {
  const segs = buildStatusBar({
    vaultPath,
    topic: "",
    model: null,
    busy,
    pendingCount,
    lastTurnTokens: null,
  });
  return segs.right === "" ? segs.left : `${segs.left} · ${segs.right}`;
}

function tryProposalKey(
  event: KeyEvent,
  buffer: string,
  proposalItems: ReadonlyArray<ProposalListItem>,
  runSlash: (line: string) => Promise<void>,
  setProposalItems: React.Dispatch<React.SetStateAction<ProposalListItem[]>>,
): boolean {
  if (buffer.length > 0 || proposalItems.length === 0) return false;
  if (event.name !== "a" && event.name !== "r") return false;
  const first = proposalItems[0];
  if (first === undefined) return false;
  event.preventDefault();
  setProposalItems((prior) => prior.slice(1));
  const command =
    event.name === "a" ? `/approve-edge ${first.id}` : `/reject-edge ${first.id} rejected from TUI`;
  void runSlash(command);
  return true;
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
  setModel: React.Dispatch<React.SetStateAction<string | null>>,
  setLastTurnTokens: React.Dispatch<React.SetStateAction<number | null>>,
): Promise<string> {
  const turnState: TurnState = { assistantBuffer: "" };
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
        setModel,
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
  setLastTurnTokens(estimateTokens(turnState.assistantBuffer));
  return turnState.assistantBuffer;
}

interface TurnState {
  assistantBuffer: string;
}

function handleStreamEvent(
  detail: { event: string; [key: string]: unknown },
  turnState: TurnState,
  setLines: React.Dispatch<React.SetStateAction<ChatLine[]>>,
  setPendingApprovals: React.Dispatch<React.SetStateAction<Map<string, string>>>,
  setModel: React.Dispatch<React.SetStateAction<string | null>>,
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
      if (typeof detail.model === "string" && detail.model.length > 0) setModel(detail.model);
      setLines((prior) => [
        ...prior,
        {
          kind: "system",
          text: `context summarized (${detail.originalTokens} → ${detail.summarizedTokens} tokens)`,
        },
      ]);
      return;
    case "loop:context_overflow_warning":
      if (typeof detail.model === "string" && detail.model.length > 0) setModel(detail.model);
      setLines((prior) => [
        ...prior,
        {
          kind: "system",
          text: `warning: configured modelContextTokens=${detail.configuredTokens} but turn estimates ${detail.estimatedTokens} tokens. Increase chat.modelContextTokens.`,
        },
      ]);
      return;
    case "loop:tool_mode_probed":
      if (typeof detail.model === "string" && detail.model.length > 0) setModel(detail.model);
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
  applyBuffer: (next: string) => void,
  setLines: React.Dispatch<React.SetStateAction<ChatLine[]>>,
  client: ClientHandle,
): void {
  const lastSpaceIndex = buffer.lastIndexOf(" ");
  const trailing = lastSpaceIndex < 0 ? buffer : buffer.slice(lastSpaceIndex + 1);
  if (!trailing.startsWith("@")) return;
  const appendSystemLine = (text: string): void => {
    setLines((prior) => [...prior, { kind: "system", text }]);
  };
  void completeAtMention(trailing.slice(1), buffer, lastSpaceIndex, applyBuffer, appendSystemLine, {
    client,
  });
}
