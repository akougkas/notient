import { z } from "zod";
import { inferenceAttemptSchema } from "../../api/pipelines";
import type { NoteSelector } from "../../api/schema";
import { preparedDrafts } from "../../core/chat/tools/draft";
import { noteOutline } from "./viewModels";
import { type AnalysisSession, AnalysisView } from "./views/AnalysisView";
import { type BriefSession, BriefView } from "./views/BriefView";
import { HistoryView } from "./views/HistoryView";
/**
 * TUI shell.
 *
 * Everything stateful lives in `store.ts`; everything that talks to the
 * daemon lives in `rpc.ts`; everything the keyboard does lives in
 * `keymap.ts`. This file is the wiring between the three, plus the polling
 * effects — which run only while the view that needs them is on screen.
 */

import { join } from "node:path";
import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { createCliRenderer } from "@opentui/core";
import { createRoot, flushSync, useKeyboard, useTerminalDimensions } from "@opentui/react";
import type React from "react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Conversation } from "../../core/chat/types";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import type { AgentEventWire, ChatApproveResult } from "../../daemon/wire";
import { type ClientHandle, connectClient } from "../client";
import type { Emitter } from "../output";
import type { ChatLine } from "./ChatView";
import {
  conversationLabel,
  conversationMatches,
  lastPreparedDraft,
  loadOwnConversation,
  ownConversations,
  rememberConversation,
  restoreConversation,
} from "./conversations";
import {
  type HistoryNav,
  appendHistoryToFile,
  createHistoryNav,
  historyAppend,
  loadHistoryFromFile,
} from "./history";
import { type Intent, resolveKey } from "./keymap";
import { type TuiLayout, deriveTuiLayout } from "./layout";
import { navigationMatches } from "./navigation";
import {
  type NotientRpc,
  RpcCallError,
  conversationMessageSchema,
  conversationSchema,
  createRpc,
  isDisconnect,
} from "./rpc";
import { type SlashContext, type SlashOutcome, dispatchSlashCommand } from "./slashCommands";
import { conversationSources } from "./sources";
import { estimateTokens } from "./statusBar";
import {
  type Action,
  type AppState,
  type InboxState,
  type ViewId,
  initialState,
  isTyping,
  reducer,
} from "./store";
import {
  exploreOpenTarget,
  extractCitations,
  groupInbox,
  inboxGroupIds,
  inboxSelectionVisualRow,
  selectedInboxEntry,
} from "./viewModels";
import { AskView } from "./views/AskView";
import { DisconnectedBanner, KeyHintBar, NoticeLine, PromptLine, TopBar } from "./views/Chrome";
import { ExploreView } from "./views/ExploreView";
import { HomeView } from "./views/HomeView";
import { InboxView } from "./views/InboxView";
import { ReviewView } from "./views/ReviewView";
import { SettingsView } from "./views/SettingsView";
import { StreamView } from "./views/StreamView";
import { WritingView } from "./views/WritingView";
import { COLOR } from "./views/theme";

const HISTORY_MAX = 100;
const STATS_POLL_MS = 5_000;
const INBOX_POLL_MS = 4_000;
const EVENTS_POLL_MS = 3_000;
export const RECENT_DISCOVERY_WINDOW_MS = 60 * 60 * 1000;

export interface TuiRuntimeOptions {
  vaultPath: string;
  emitter: Emitter;
  clientIdentity?: string;
}

export async function startTuiRuntime(options: TuiRuntimeOptions): Promise<void> {
  const socketPath = resolveSocketPath(options.vaultPath, currentPlatform());
  const connect = (): Promise<ClientHandle> =>
    connectClient({
      socketPath,
      vaultPath: options.vaultPath,
      ...(options.clientIdentity === undefined ? {} : { clientIdentity: options.clientIdentity }),
    });

  const client = await connect();
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
      <App vaultPath={options.vaultPath} client={client} connect={connect} onExit={onExit} />,
    );
  });
  await client.close();
}

interface AppProps {
  vaultPath: string;
  client: ClientHandle;
  connect: () => Promise<ClientHandle>;
  onExit: () => void;
}

export function App({ vaultPath, client, connect, onExit }: AppProps): React.ReactNode {
  const [state, dispatch] = useReducer(reducer, vaultPath, initialState);
  const [reviewRequests, setReviewRequests] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const briefSession = useRef<BriefSession>({ topic: "", mode: "topic", result: null });
  const [briefOpen, setBriefOpen] = useState(false);
  const analysisSessions = useRef<Record<"compare" | "correlate", AnalysisSession>>({
    compare: { paths: [], question: "", result: null },
    correlate: { paths: [], question: "", result: null },
  });
  const [analysisOpen, setAnalysisOpen] = useState<"compare" | "correlate" | null>(null);
  const { width, height } = useTerminalDimensions();
  const layout = useMemo(() => deriveTuiLayout(width, height), [height, width]);
  const rpcRef = useRef<NotientRpc>(createRpc(client));
  const sessionFlightRef = useRef(false);
  const turnStopRef = useRef(false);
  const sessionReadyRef = useRef(false);
  const conversationsRef = useRef<Conversation[]>([]);
  const noteRequestRef = useRef(0);
  const intentRef = useRef<(intent: Intent) => void>(() => {});
  useEffect(
    () => () => {
      void rpcRef.current.client.close();
    },
    [],
  );
  const inboxScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const askScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const streamScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const statusPollRef = useRef<Promise<void> | null>(null);
  const probeNoticeRef = useRef<string | null>(null);
  const statsPollRef = useRef<Promise<void> | null>(null);
  const inboxPollRef = useRef<Promise<void> | null>(null);
  const eventPollRef = useRef<Promise<void> | null>(null);
  const pendingTransitionFlightsRef = useRef(new Map<string, Promise<void>>());
  const eventSnapshotLoadedRef = useRef(false);
  const historyPath = useMemo(() => join(vaultPath, ".notient", "history.txt"), [vaultPath]);
  const historyNavRef = useRef<HistoryNav>(
    createHistoryNav(loadHistoryFromFile(historyPath, HISTORY_MAX)),
  );
  // Views read from the store; async callbacks need the latest snapshot
  // without being re-created on every keystroke.
  const elapsedSeconds = useTurnElapsed(state.ask.busy);
  const stateRef = useRef(state);
  stateRef.current = state;
  // Terminal input may deliver several characters before React renders.
  const promptBufferRef = useRef(state.prompt.buffer);
  promptBufferRef.current = state.prompt.buffer;
  const previousInboxFilterRef = useRef(state.inbox.filter);
  const transientChromeRows =
    (state.connection.connected ? 0 : 1) +
    (state.notice === null ? 0 : 1) +
    (state.prompt.kind === null ? 0 : 1 + Math.min(6, state.prompt.matches.length));
  const viewLayout = useMemo(
    () => deriveTuiLayout(width, Math.max(1, height - transientChromeRows)),
    [height, transientChromeRows, width],
  );

  useEffect(() => {
    if (state.view !== "inbox") return;
    if (previousInboxFilterRef.current !== state.inbox.filter) {
      resetInboxScroll(inboxScrollRef);
    }
    previousInboxFilterRef.current = state.inbox.filter;
    revealInboxSelection(inboxScrollRef, state.inbox, viewLayout.inbox.scrollHeight);
  }, [state.inbox, state.view, viewLayout.inbox.scrollHeight]);

  const fail = useCallback((error: unknown, context: string): void => {
    if (isDisconnect(error)) {
      dispatch({
        type: "conn/lost",
        reason: error instanceof Error ? error.message : "connection lost",
      });
      return;
    }
    const message =
      error instanceof RpcCallError
        ? `${context}: ${error.code} ${error.message}`
        : `${context}: ${error instanceof Error ? error.message : String(error)}`;
    dispatch({ type: "notice", text: message });
  }, []);

  const selectConversation = useCallback(
    async (conversation: Conversation | null) => {
      try {
        await rememberConversation(
          vaultPath,
          rpcRef.current.client.principal.id,
          conversation?.notePath ?? null,
        );
      } catch (error) {
        fail(error, "Saving selected conversation");
      }
      sessionReadyRef.current = true;
      dispatch(conversation === null ? { type: "ask/new" } : { type: "ask/restore", conversation });
    },
    [fail, vaultPath],
  );

  const canSwitchConversation = useCallback(() => {
    if (sessionFlightRef.current || stateRef.current.ask.busy) {
      dispatch({
        type: "notice",
        text: "Wait for the current turn to finish before switching threads.",
      });
      return false;
    }
    const draft = stateRef.current.ask.buffer.trim();
    if (draft && !["/threads", "/new"].includes(draft)) {
      dispatch({ type: "notice", text: "Send or clear your draft before switching threads." });
      return false;
    }
    return true;
  }, []);

  const newConversation = useCallback(async () => {
    if (!canSwitchConversation()) return;
    sessionFlightRef.current = true;
    try {
      await selectConversation(null);
      dispatch({ type: "notice", text: "New thread. Ask a question or bring a note with @path." });
    } finally {
      sessionFlightRef.current = false;
    }
  }, [canSwitchConversation, selectConversation]);

  const openConversations = useCallback(async () => {
    if (!canSwitchConversation()) return;
    sessionFlightRef.current = true;
    conversationsRef.current = [];
    dispatch({ type: "prompt/open", kind: "conversation-picker" });
    dispatch({ type: "notice", text: "Loading conversations…" });
    try {
      conversationsRef.current = await ownConversations(rpcRef.current);
      if (stateRef.current.prompt.kind !== "conversation-picker") return;
      dispatch({
        type: "prompt/matches",
        matches: conversationMatches(conversationsRef.current, stateRef.current.prompt.buffer).map(
          conversationLabel,
        ),
      });
      dispatch({
        type: "notice",
        text: conversationsRef.current.length
          ? "Choose a thread · type to filter · Enter to continue"
          : "No saved threads yet. Ctrl+N starts one.",
      });
    } catch (error) {
      fail(error, "Loading conversations");
    } finally {
      sessionFlightRef.current = false;
    }
  }, [canSwitchConversation, fail]);

  /* ---------------------------------------------------------------- */
  /* Loaders                                                           */
  /* ---------------------------------------------------------------- */

  const fetchStatus = useCallback(async (): Promise<void> => {
    try {
      const status = await rpcRef.current.status();
      dispatch({ type: "status/loaded", status });
      const probeNotice = status.probe.status === "mismatch" ? status.probe.message : null;
      if (probeNotice !== null && probeNotice !== probeNoticeRef.current) {
        dispatch({ type: "notice", text: `startup probe: ${probeNotice}` });
      }
      if (
        probeNotice === null &&
        probeNoticeRef.current !== null &&
        stateRef.current.notice === `startup probe: ${probeNoticeRef.current}`
      )
        dispatch({ type: "notice", text: null });
      probeNoticeRef.current = probeNotice;
    } catch (error) {
      dispatch({
        type: "status/failed",
        message: error instanceof Error ? error.message : String(error),
      });
      fail(error, "daemon.status");
    }
    try {
      const health = await rpcRef.current.health();
      dispatch({ type: "health/loaded", endpoints: health.endpoints });
    } catch (error) {
      fail(error, "health.probe");
    }
  }, [fail]);

  const loadStatus = useCallback(
    (): Promise<void> => runSingleFlight(statusPollRef, fetchStatus),
    [fetchStatus],
  );

  const fetchStats = useCallback(async (): Promise<void> => {
    try {
      dispatch({ type: "stats/loaded", stats: await rpcRef.current.vaultStats() });
    } catch (error) {
      if (isDisconnect(error)) return fail(error, "vault.stats");
      dispatch({
        type: "stats/failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [fail]);

  const loadStats = useCallback(
    (): Promise<void> => runSingleFlight(statsPollRef, fetchStats),
    [fetchStats],
  );

  const refreshStats = useCallback(
    (): Promise<void> => runTrailingFlight(statsPollRef, fetchStats),
    [fetchStats],
  );

  const fetchInbox = useCallback(async (): Promise<void> => {
    try {
      const [proposals, approvals] = await Promise.all([
        rpcRef.current.proposalsList({ limit: 100 }),
        rpcRef.current.approvalsPending(),
      ]);
      dispatch({
        type: "inbox/loaded",
        proposals: proposals.proposals,
        approvals: approvals.approvals,
      });
    } catch (error) {
      if (isDisconnect(error)) return fail(error, "inbox");
      dispatch({
        type: "inbox/failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [fail]);

  const loadInbox = useCallback(
    (): Promise<void> => runSingleFlight(inboxPollRef, fetchInbox),
    [fetchInbox],
  );

  const refreshInbox = useCallback(
    (): Promise<void> => runTrailingFlight(inboxPollRef, fetchInbox),
    [fetchInbox],
  );

  const refreshPendingTransition = useCallback(
    (phase: PendingTransitionPhase, id: string): Promise<void> =>
      refreshPendingTransitionOnce(pendingTransitionFlightsRef.current, phase, id, refreshStats),
    [refreshStats],
  );

  const loadEvents = useCallback(
    (): Promise<void> =>
      runSingleFlight(eventPollRef, async () => {
        try {
          const since = stateRef.current.stream.cursor;
          const result = await rpcRef.current.agentEvents(since, 200);
          dispatch({
            type: "stream/events",
            events: result.events as AgentEventWire[],
            cursor: result.cursor,
          });
        } catch (error) {
          if (isDisconnect(error)) fail(error, "agent.events");
        }
      }),
    [fail],
  );

  const initializeEvents = useCallback((): Promise<void> => {
    if (eventSnapshotLoadedRef.current) return loadEvents();
    return runSingleFlight(eventPollRef, async () => {
      try {
        const result = await rpcRef.current.recentLinkProposals(
          Date.now() - RECENT_DISCOVERY_WINDOW_MS,
          200,
        );
        eventSnapshotLoadedRef.current = true;
        dispatch({
          type: "stream/events",
          events: result.events as AgentEventWire[],
          cursor: result.cursor,
        });
      } catch (error) {
        if (isDisconnect(error)) fail(error, "agent.events");
      }
    });
  }, [fail, loadEvents]);

  const openNote = useCallback(
    async (
      notePath: string,
      selector?: NoteSelector,
      revision?: string,
      quote?: string,
      keepPane?: boolean,
    ): Promise<void> => {
      const request = ++noteRequestRef.current;
      const update: React.Dispatch<Action> = (action) => {
        if (noteRequestRef.current === request) dispatch(action);
      };
      dispatch({ type: "view/set", view: "explore" });
      dispatch({ type: "explore/open", notePath, keepPane });
      const rpc = rpcRef.current;
      try {
        const body = await rpc.noteBody(notePath, selector, revision);
        if (quote !== undefined && body.selected?.quote !== quote)
          throw new Error(
            "The recorded passage does not match this note. Open the current note to inspect it.",
          );
        update({
          type: "explore/body",
          body: body.body,
          selected: body.selected,
          structure: body.structure,
          revision: body.note.revision,
        });
      } catch (error) {
        if (noteRequestRef.current !== request) return;
        if (isDisconnect(error)) return fail(error, "notes.read");
        update({
          type: "explore/failed",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      // Extraction and neighbours are additive: a vault indexed only to
      // tier 1 has neither, and that is a legitimate state to render.
      if (noteRequestRef.current !== request) return;
      await loadExtraction(rpc, notePath, update, fail);
      if (noteRequestRef.current !== request) return;
      await loadNeighbors(rpc, notePath, update, fail);
    },
    [fail],
  );

  const openCitation = useCallback(
    async (target: string): Promise<void> => {
      try {
        const result = await rpcRef.current.resolveLink(target);
        if (!result.resolved) {
          // Do not dispatch view/set or explore/open here: both would replace
          // the last populated Explore before we know there is a note to read.
          dispatch({ type: "ask/citationUnresolved", target });
          return;
        }
        await openNote(result.path, result.selector ?? undefined);
      } catch (error) {
        fail(error, "vault.resolve_link");
      }
    },
    [fail, openNote],
  );

  /* ---------------------------------------------------------------- */
  /* Boot + polling                                                    */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    let cancelled = false;
    sessionFlightRef.current = true;
    dispatch({ type: "ask/busy", busy: true });
    void restoreConversation(rpcRef.current, vaultPath)
      .then(async (conversation) => {
        if (cancelled) return;
        await selectConversation(conversation);
        void loadStatus();
      })
      .catch((error) => {
        if (cancelled) return;
        fail(error, "Restoring conversation · Ctrl+O to choose, Ctrl+N for a new thread");
      })
      .finally(() => {
        sessionFlightRef.current = false;
        if (!cancelled) dispatch({ type: "ask/busy", busy: false });
      });
    return () => {
      cancelled = true;
    };
  }, [fail, loadStatus, selectConversation, vaultPath]);

  useEffect(() => {
    if (!state.connection.connected) return;
    void loadActiveView(state.view, {
      home: async () => {
        await Promise.all([loadStats(), initializeEvents()]);
      },
      inbox: loadInbox,
      stream: initializeEvents,
    });
  }, [initializeEvents, loadInbox, loadStats, state.connection.connected, state.view]);

  // The pending badge is global, so its sole authority must stay fresh in
  // every view rather than only while Home is visible.
  usePoll(state.connection.connected, STATS_POLL_MS, loadStats);
  usePoll(state.connection.connected, STATS_POLL_MS, loadStatus);
  usePoll(state.view === "inbox" && state.connection.connected, INBOX_POLL_MS, loadInbox);
  usePoll(
    (state.view === "stream" || state.view === "home") && state.connection.connected,
    EVENTS_POLL_MS,
    loadEvents,
  );

  /* ---------------------------------------------------------------- */
  /* Chat turn                                                         */
  /* ---------------------------------------------------------------- */

  const runCommand = useCallback(
    async (line: string): Promise<void> => {
      await runSlashCommand({
        line,
        context: {
          client: rpcRef.current.client,
          vaultPath,
          getLastAssistant: () => lastAssistantText(stateRef.current),
          openConversations,
          newConversation,
        },
        dispatch,
        onExit,
        refreshInbox,
        refreshStats,
        refreshResolved: (id) => refreshPendingTransition("resolved", id),
      });
    },
    [
      newConversation,
      openConversations,
      onExit,
      refreshInbox,
      refreshPendingTransition,
      refreshStats,
      vaultPath,
    ],
  );

  const submitAsk = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (trimmed.length === 0 || sessionFlightRef.current || stateRef.current.ask.busy) return;
      if (trimmed.startsWith("/")) {
        dispatch({ type: "ask/buffer", buffer: "" });
        await runCommand(trimmed);
        return;
      }
      if (!sessionReadyRef.current) {
        dispatch({
          type: "notice",
          text: "Choose a saved thread with Ctrl+O or start a new one with Ctrl+N.",
        });
        return;
      }
      sessionFlightRef.current = true;
      turnStopRef.current = false;
      dispatch({ type: "ask/busy", busy: true });
      try {
        let conversationId = stateRef.current.ask.conversationId;
        if (conversationId === null) {
          const { conversation } = await rpcRef.current.chatStart(
            trimmed.replace(/\s+/g, " ").slice(0, 80),
          );
          await selectConversation(conversation);
          conversationId = conversation.id;
        }
        if (turnStopRef.current) {
          dispatch({ type: "ask/buffer", buffer: trimmed });
          return;
        }
        dispatch({ type: "ask/buffer", buffer: "" });
        historyNavRef.current = historyAppend(historyNavRef.current, trimmed, HISTORY_MAX);
        appendHistoryToFile(historyPath, trimmed, HISTORY_MAX);
        dispatch({ type: "ask/line", line: { kind: "user", text: trimmed } });
        dispatch({ type: "ask/busy", busy: true });
        const assistant = await drainTurn(
          rpcRef.current.chatSend(conversationId, trimmed),
          dispatch,
          fail,
          refreshPendingTransition,
        );
        dispatch({
          type: "ask/turnDone",
          tokens: estimateTokens(assistant),
          citations: extractCitations(assistant),
        });
      } catch (error) {
        fail(error, "Conversation");
      } finally {
        sessionFlightRef.current = false;
        dispatch({ type: "ask/busy", busy: false });
        if (turnStopRef.current)
          dispatch({ type: "notice", text: "Turn ended. Your conversation is still here." });
      }
    },
    [fail, historyPath, refreshPendingTransition, runCommand, selectConversation],
  );

  /* ---------------------------------------------------------------- */
  /* Intents                                                           */
  /* ---------------------------------------------------------------- */

  const decideProposal = useCallback(
    async (id: string, approve: boolean): Promise<void> => {
      await runPendingDecisionTransition({
        id,
        context: approve ? "links.approve" : "links.reject",
        decide: async () => {
          if (approve) {
            const result = await rpcRef.current.proposalsApprove(id);
            return result.found ? `approved ${id}` : `${id} was already decided`;
          }
          const result = await rpcRef.current.proposalsReject(id);
          return result.found
            ? `rejected ${id} · reason: ${result.reason ?? "(none)"} · audit: ${result.historyId}`
            : `${id} was already decided`;
        },
        dispatch,
        fail,
        refreshInbox,
        refreshStats,
        refreshResolved: () => refreshPendingTransition("resolved", id),
      });
    },
    [fail, refreshInbox, refreshPendingTransition, refreshStats],
  );

  const decideApproval = useCallback(
    async (callId: string, approved: boolean): Promise<void> => {
      await runPendingDecisionTransition({
        id: callId,
        context: "chat.approve",
        decide: async () => {
          const result = await rpcRef.current.chatApprove(
            approved ? { callId, approved: true } : { callId, approved: false },
          );
          return approvalDecisionNotice(result);
        },
        dispatch,
        fail,
        refreshInbox,
        refreshStats,
        refreshResolved: () => refreshPendingTransition("resolved", callId),
      });
    },
    [fail, refreshInbox, refreshPendingTransition, refreshStats],
  );

  const reconnect = useCallback(async (): Promise<void> => {
    if (sessionFlightRef.current) return;
    sessionFlightRef.current = true;
    dispatch({ type: "conn/reconnecting" });
    try {
      const next = await connect();
      const prior = rpcRef.current.client;
      rpcRef.current = createRpc(next);
      await prior.close();
      pendingTransitionFlightsRef.current.clear();
      dispatch({ type: "conn/restored" });
      const draft = stateRef.current.ask.buffer;
      const path = stateRef.current.ask.notePath;
      const conversation =
        path === null
          ? await restoreConversation(rpcRef.current, vaultPath)
          : await loadOwnConversation(rpcRef.current, path);
      await selectConversation(conversation);
      dispatch({ type: "ask/buffer", buffer: draft });
      void loadStatus();
      dispatch({ type: "notice", text: "Reconnected. Conversation restored." });
    } catch (error) {
      dispatch({
        type: "conn/lost",
        reason: error instanceof Error ? error.message : "reconnect failed",
      });
    } finally {
      sessionFlightRef.current = false;
    }
  }, [connect, loadStatus, selectConversation, vaultPath]);

  const resumeConversation = useCallback(
    async (notePath: string) => {
      if (!canSwitchConversation()) return;
      sessionFlightRef.current = true;
      dispatch({ type: "ask/busy", busy: true });
      try {
        await selectConversation(await loadOwnConversation(rpcRef.current, notePath));
        dispatch({ type: "notice", text: "Conversation restored." });
      } catch (error) {
        fail(error, "Loading conversation");
      } finally {
        sessionFlightRef.current = false;
        dispatch({ type: "ask/busy", busy: false });
      }
    },
    [canSwitchConversation, fail, selectConversation],
  );

  const openPickedNote = useCallback(
    async (query: string, selected?: string) => {
      try {
        const chosen = selected ?? (await rpcRef.current.listNotes(query, 1)).notes[0]?.path;
        if (!chosen) throw new Error("No matching note. Try part of its name or path.");
        await openNote(chosen);
      } catch (error) {
        fail(error, "Finding notes");
      }
    },
    [fail, openNote],
  );

  const submitPrompt = useCallback(async (): Promise<void> => {
    const current = stateRef.current;
    const { kind, buffer, matches, cursor } = current.prompt;
    if (kind === "conversation-picker" && sessionFlightRef.current) {
      dispatch({
        type: "notice",
        text: "Loading conversations… Your filter is kept; Enter opens a loaded result.",
      });
      return;
    }
    dispatch({ type: "prompt/close" });
    switch (kind) {
      case "command":
        if (buffer.trim()) await runCommand(buffer.trim());
        break;
      case "note-picker": {
        await openPickedNote(buffer, matches[cursor]);
        break;
      }
      case "conversation-picker": {
        const chosen = conversationMatches(conversationsRef.current, buffer)[cursor];
        if (chosen) await resumeConversation(chosen.notePath);
        break;
      }
      case "navigation": {
        const chosen = navigationMatches(buffer)[cursor];
        if (chosen) intentRef.current(chosen.intent);
        break;
      }
    }
    // Filter prompts already mirrored the buffer into the view's filter.
  }, [openPickedNote, resumeConversation, runCommand]);

  const runIntent = useCallback(
    (intent: Intent): void => {
      if (intent.kind === "brief") {
        dispatch({ type: "prompt/close" });
        setBriefOpen(true);
        return;
      }
      if (intent.kind === "analysis") {
        dispatch({ type: "prompt/close" });
        setAnalysisOpen(intent.mode);
        return;
      }
      if (intent.kind === "history") {
        dispatch({ type: "prompt/close" });
        setHistoryOpen(true);
        return;
      }
      if (intent.kind === "settings") {
        dispatch({ type: "prompt/close" });
        setSettingsOpen(true);
        return;
      }
      if (intent.kind === "cancel-turn") {
        if (turnStopRef.current) return;
        turnStopRef.current = true;
        dispatch({ type: "notice", text: "Stopping this turn…" });
        void rpcRef.current.chatAbort().catch((error) => {
          turnStopRef.current = false;
          fail(error, "Stopping turn");
        });
        return;
      }
      if (intent.kind === "capture") {
        dispatch({ type: "writing/open", request: {} });
        return;
      }
      if (intent.kind === "edit-note") {
        const path = stateRef.current.explore.notePath;
        if (path) dispatch({ type: "writing/open", request: { path } });
        else dispatch({ type: "notice", text: "Open a note first, then press e to edit it." });
        return;
      }
      if (intent.kind === "save-answer") {
        const draft = lastPreparedDraft(stateRef.current.ask.lines);
        const text = draft?.markdown ?? lastAssistantText(stateRef.current);
        if (stateRef.current.ask.busy) {
          dispatch({ type: "notice", text: "Wait for the answer to finish before saving it." });
          return;
        }
        if (text) dispatch({ type: "writing/open", request: { text, title: draft?.title } });
        else
          dispatch({
            type: "notice",
            text: "There is no answer to save yet. Ctrl+B captures a new thought.",
          });
        return;
      }
      if (intent.kind === "navigation") {
        dispatch({ type: "prompt/open", kind: "navigation" });
        dispatch({
          type: "prompt/matches",
          matches: navigationMatches("").map((item) => item.label),
        });
        return;
      }
      if (intent.kind === "toggle-activity") {
        dispatch({ type: "ask/activity" });
        return;
      }
      if (intent.kind === "toggle-source") {
        dispatch({ type: "explore/raw" });
        return;
      }
      if (intent.kind === "full-note") {
        const explore = stateRef.current.explore;
        if (explore.error && explore.notePath) void openNote(explore.notePath);
        else dispatch({ type: "explore/full" });
        return;
      }
      if (intent.kind === "conversations") {
        void openConversations();
        return;
      }
      if (intent.kind === "new-conversation") {
        void newConversation();
        return;
      }
      const runtime: IntentRuntime = {
        current: stateRef.current,
        dispatch,
        askScrollRef,
        streamScrollRef,
        onExit,
        reconnect,
        submitPrompt,
        loadEvents,
        loadStats,
        decideProposal,
        decideApproval,
        openCitation,
        openNote,
        rpc: rpcRef.current,
        fail,
      };
      if (handleNavigationIntent(intent, runtime)) return;
      if (handleMovementIntent(intent, runtime)) return;
      handleOperationIntent(intent, runtime);
    },
    [
      decideApproval,
      decideProposal,
      fail,
      loadEvents,
      loadStats,
      onExit,
      openNote,
      openCitation,
      reconnect,
      submitPrompt,
      openConversations,
      newConversation,
    ],
  );

  /* ---------------------------------------------------------------- */
  /* Keyboard                                                          */
  /* ---------------------------------------------------------------- */

  intentRef.current = runIntent;

  useEffect(() => {
    if (state.prompt.kind !== "note-picker") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void rpcRef.current
        .listNotes(state.prompt.buffer, 30)
        .then((result) => {
          if (!cancelled)
            dispatch({ type: "prompt/matches", matches: result.notes.map((note) => note.path) });
        })
        .catch((error) => {
          if (!cancelled) fail(error, "Finding notes");
        });
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [fail, state.prompt.kind, state.prompt.buffer]);

  const updatePrompt = useCallback((next: string) => {
    promptBufferRef.current = next;
    dispatch({ type: "prompt/buffer", buffer: next });
    if (stateRef.current.prompt.kind === "navigation") {
      dispatch({
        type: "prompt/matches",
        matches: navigationMatches(next).map((item) => item.label),
      });
    }
    if (stateRef.current.prompt.kind === "conversation-picker") {
      dispatch({
        type: "prompt/matches",
        matches: conversationMatches(conversationsRef.current, next).map(conversationLabel),
      });
    }
  }, []);

  const handleKey = useCallback(
    (event: KeyEvent) => {
      if (settingsOpen || historyOpen || analysisOpen || briefOpen) return;
      if (stateRef.current.writing !== null) return;
      if (event.eventType !== "press" && event.eventType !== "repeat") return;
      const current = stateRef.current;
      if (current.view === "inbox" && current.prompt.kind === null) {
        if (reviewRequests && event.name === "tab") {
          event.preventDefault();
          setReviewRequests(false);
          return;
        }
        if (!reviewRequests && !event.ctrl && !event.meta) return;
      }
      const key = {
        name: event.name,
        ctrl: event.ctrl === true,
        shift: event.shift === true,
        meta: event.meta === true,
        sequence: readSequence(event),
        repeat: event.eventType === "repeat",
      };
      const intent = resolveKey(current, key);
      if (intent !== null) {
        event.preventDefault();
        // Commit focus changes before the next terminal key in the same batch.
        // Otherwise a fast menu query can land in the still-focused composer.
        flushSync(() => runIntent(intent));
        return;
      }
      if (current.prompt.kind !== null) {
        event.preventDefault();
        const next = editBuffer(promptBufferRef.current, key);
        if (next === null) return;
        flushSync(() => updatePrompt(next));
        return;
      }
      if (!isTyping(current)) event.preventDefault();
    },
    [runIntent, updatePrompt, reviewRequests, settingsOpen, historyOpen, analysisOpen, briefOpen],
  );
  useKeyboard(handleKey);

  if (briefOpen)
    return (
      <BriefView
        session={briefSession.current}
        initialPath={state.explore.notePath ?? ""}
        vaultPath={vaultPath}
        clientIdentity={
          rpcRef.current.client.principal.kind === "agent"
            ? rpcRef.current.client.principal.id
            : undefined
        }
        width={width}
        height={height}
        onClose={() => setBriefOpen(false)}
        onExit={onExit}
        onSource={(source) => {
          setBriefOpen(false);
          void openNote(
            source.path,
            { kind: "range", start: source.range.start, end: source.range.end },
            source.revision,
            source.quote,
          );
        }}
      />
    );
  if (analysisOpen)
    return (
      <AnalysisView
        session={analysisSessions.current[analysisOpen]}
        kind={analysisOpen}
        vaultPath={vaultPath}
        clientIdentity={
          rpcRef.current.client.principal.kind === "agent"
            ? rpcRef.current.client.principal.id
            : undefined
        }
        initialPath={state.explore.notePath ?? ""}
        rpc={() => rpcRef.current}
        width={width}
        height={height}
        onClose={() => setAnalysisOpen(null)}
        onExit={onExit}
        onSource={(source) => {
          setAnalysisOpen(null);
          void openNote(
            source.path,
            { kind: "range", start: source.range.start, end: source.range.end },
            source.revision,
            source.quote,
          );
        }}
      />
    );

  if (historyOpen)
    return (
      <HistoryView
        rpc={() => rpcRef.current}
        width={width}
        height={height}
        onClose={() => setHistoryOpen(false)}
        onExit={onExit}
      />
    );

  if (settingsOpen)
    return (
      <SettingsView
        rpc={() => rpcRef.current}
        width={width}
        height={height}
        onClose={() => setSettingsOpen(false)}
        onExit={onExit}
      />
    );

  if (state.writing)
    return (
      <WritingView
        vaultPath={vaultPath}
        identity={rpcRef.current.client.principal.id}
        request={state.writing}
        width={width}
        height={height}
        rpc={() => rpcRef.current}
        onClose={() => dispatch({ type: "writing/close" })}
        onExit={onExit}
        onReconnect={reconnect}
        onSaved={(path, historyId) => {
          dispatch({ type: "writing/close" });
          void openNote(path);
          dispatch({
            type: "notice",
            text: `Saved ${path}${historyId ? " · recorded in history" : ""}`,
          });
        }}
        onThink={(thought) => {
          if (stateRef.current.ask.buffer.trim() || stateRef.current.ask.busy)
            throw new Error(
              "Finish the current conversation draft first. Your thought is kept here.",
            );
          dispatch({ type: "writing/close" });
          dispatch({ type: "view/set", view: "ask" });
          dispatch({
            type: "ask/buffer",
            buffer: `Help me develop this thought. Preserve my meaning, connect it to relevant notes, and propose a clear Markdown draft. Do not write files yet.\n\n${thought}`,
          });
        }}
      />
    );

  return (
    <AppFrame
      state={state}
      layout={layout}
      hideViewHints={state.view === "inbox" && !reviewRequests}
    >
      {state.view === "home" ? <HomeView state={state} layout={viewLayout.home} /> : null}
      {state.view === "inbox" && reviewRequests ? (
        <InboxView state={state} layout={viewLayout.inbox} scrollRef={inboxScrollRef} />
      ) : null}
      {state.view === "inbox" && !reviewRequests ? (
        <ReviewView
          rpc={() => rpcRef.current}
          width={width}
          height={viewLayout.inbox.height}
          active={state.prompt.kind === null}
          onRequests={() => setReviewRequests(true)}
          onOpen={(source) => {
            void openNote(
              source.path,
              { kind: "range", start: source.range.start, end: source.range.end },
              source.revision,
            );
          }}
          onClose={() => dispatch({ type: "view/set", view: "ask" })}
        />
      ) : null}
      {state.view === "ask" ? (
        <AskView
          state={state}
          layout={viewLayout.ask}
          elapsedSeconds={elapsedSeconds}
          scrollRef={askScrollRef}
          onBufferChange={(next) => {
            dispatch({ type: "ask/buffer", buffer: next });
          }}
          onOpenCitation={(target) => {
            void openCitation(target);
          }}
          onOpenSource={(source) => {
            void openNote(
              source.path,
              { kind: "range", start: source.range.start, end: source.range.end },
              source.revision,
              source.quote,
            );
          }}
          onToggleActivity={() => dispatch({ type: "ask/activity" })}
          onSubmit={(final) => {
            void submitAsk(final);
          }}
        />
      ) : null}
      {state.view === "explore" ? (
        <ExploreView
          state={state}
          layout={viewLayout.explore}
          onOpenSection={(selector) => {
            const note = stateRef.current.explore;
            if (note.notePath && note.revision)
              void openNote(note.notePath, selector, note.revision);
          }}
          onPane={(pane) => {
            const panes = ["body", "view", "neighbors"];
            dispatch({
              type: "explore/pane",
              delta: panes.indexOf(pane) - panes.indexOf(stateRef.current.explore.pane),
            });
          }}
        />
      ) : null}
      {state.view === "stream" ? (
        <StreamView state={state} layout={viewLayout.stream} scrollRef={streamScrollRef} />
      ) : null}
    </AppFrame>
  );
}

/**
 * The chrome around whichever view is active.
 *
 * The root box paints `COLOR.bg` explicitly. The palette is a dark one and
 * every panel draws near-white text, so leaving the root transparent left
 * that text sitting on whatever the terminal's own background happened to
 * be. On a light profile the result was unreadable.
 */
export function AppFrame({
  state,
  layout,
  children,
  hideViewHints = false,
}: {
  state: AppState;
  layout: TuiLayout;
  children: React.ReactNode;
  hideViewHints?: boolean;
}): React.ReactNode {
  return (
    <box
      flexDirection="column"
      width={layout.terminal.width}
      height={layout.terminal.height}
      backgroundColor={COLOR.bg}
    >
      <TopBar state={state} layout={layout.chrome} />
      <DisconnectedBanner state={state} layout={layout.chrome} />
      <box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        width={layout.terminal.width}
      >
        {children}
      </box>
      <NoticeLine state={state} layout={layout.chrome} />
      <PromptLine state={state} layout={layout.chrome} />
      {hideViewHints ? (
        <text fg={COLOR.dim}> Ctrl+P menu · Ctrl+C exit</text>
      ) : (
        <KeyHintBar state={state} layout={layout.chrome} />
      )}
    </box>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

type ScrollRef = { readonly current: Pick<ScrollBoxRenderable, "scrollBy"> | null };

interface IntentRuntime {
  current: AppState;
  dispatch: React.Dispatch<Action>;
  askScrollRef: ScrollRef;
  streamScrollRef: ScrollRef;
  onExit: () => void;
  reconnect: () => Promise<void>;
  submitPrompt: () => Promise<void>;
  loadEvents: () => Promise<void>;
  loadStats: () => Promise<void>;
  decideProposal: (id: string, approved: boolean) => Promise<void>;
  decideApproval: (id: string, approved: boolean) => Promise<void>;
  openCitation: (target: string) => Promise<void>;
  openNote: (
    target: string,
    selector?: NoteSelector,
    revision?: string,
    quote?: string,
    keepPane?: boolean,
  ) => Promise<void>;
  rpc: NotientRpc;
  fail: (error: unknown, context: string) => void;
}

export function approvalDecisionNotice(result: ChatApproveResult): string {
  return result.approved
    ? `approved ${result.callId}`
    : `rejected ${result.callId}: ${result.reason}`;
}

function handleNavigationIntent(intent: Intent, runtime: IntentRuntime): boolean {
  switch (intent.kind) {
    case "quit":
      runtime.onExit();
      return true;
    case "reconnect":
      void runtime.reconnect();
      return true;
    case "view":
      runtime.dispatch({ type: "view/set", view: intent.view });
      return true;
    case "view-cycle":
      runtime.dispatch({ type: "view/cycle", delta: intent.delta });
      return true;
    case "prompt-open":
      openIntentPrompt(intent, runtime);
      return true;
    case "prompt-cancel":
      runtime.dispatch({ type: "prompt/close" });
      return true;
    case "prompt-submit":
      void runtime.submitPrompt();
      return true;
    case "prompt-move":
      runtime.dispatch({ type: "prompt/move", delta: intent.delta });
      return true;
    case "pane":
      runtime.dispatch({ type: "explore/pane", delta: intent.delta });
      return true;
    case "compose":
      runtime.dispatch({ type: "ask/composer", mode: "editing" });
      return true;
    case "blur":
      runtime.dispatch({ type: "ask/composer", mode: "navigation" });
      return true;
    default:
      return false;
  }
}

function openIntentPrompt(
  intent: Extract<Intent, { kind: "prompt-open" }>,
  runtime: IntentRuntime,
): void {
  if (intent.prompt === "command" || intent.prompt === "note-picker") {
    runtime.dispatch({ type: "prompt/open", kind: intent.prompt });
    return;
  }
  const stream = runtime.current.view === "stream";
  runtime.dispatch({
    type: "prompt/open",
    kind: stream ? "stream-filter" : "inbox-filter",
    buffer: stream ? runtime.current.stream.filter : runtime.current.inbox.filter,
  });
}

function handleMovementIntent(intent: Intent, runtime: IntentRuntime): boolean {
  if (intent.kind === "move") {
    moveSelection(runtime, intent.delta);
    return true;
  }
  if (intent.kind === "scroll") {
    scrollActiveView(runtime, intent.delta);
    return true;
  }
  return false;
}

function moveSelection(runtime: IntentRuntime, delta: number): void {
  const { current, dispatch } = runtime;
  if (current.view === "inbox") dispatch({ type: "inbox/move", delta });
  if (current.view === "ask") dispatch({ type: "ask/citationMove", delta });
  if (current.view === "stream") scrollBy(runtime.streamScrollRef, delta);
  if (current.view !== "explore") return;
  dispatch({
    type:
      current.explore.pane === "neighbors"
        ? "explore/move"
        : current.explore.pane === "view"
          ? "explore/outlineMove"
          : "explore/scroll",
    delta,
  });
}

function scrollActiveView(runtime: IntentRuntime, delta: number): void {
  if (runtime.current.view === "explore") {
    runtime.dispatch({ type: "explore/scroll", delta });
    return;
  }
  scrollBy(
    runtime.current.view === "stream" ? runtime.streamScrollRef : runtime.askScrollRef,
    delta,
  );
}

function handleOperationIntent(intent: Intent, runtime: IntentRuntime): boolean {
  switch (intent.kind) {
    case "refresh":
      refreshActiveView(runtime);
      return true;
    case "approve":
    case "reject":
      decideSelectedInboxEntry(runtime, intent.kind === "approve");
      return true;
    case "approve-group":
      approveSelectedInboxGroup(runtime);
      return true;
    case "open-in-explore":
      openSelectedTarget(runtime);
      return true;
    case "awaken":
      void runAwaken(intent.verb, runtime.rpc, runtime.dispatch, runtime.fail, runtime.loadStats);
      return true;
    default:
      return false;
  }
}

function refreshActiveView(runtime: IntentRuntime): void {
  if (runtime.current.view === "explore") {
    const path = runtime.current.explore.notePath;
    if (path) void runtime.openNote(path, undefined, undefined, undefined, true);
    return;
  }
  void (runtime.current.view === "stream"
    ? runtime.loadEvents()
    : Promise.all([runtime.loadStats(), runtime.loadEvents()]));
}

function selectedInbox(state: AppState) {
  return selectedInboxEntry(
    groupInbox(state.inbox.proposals, state.inbox.approvals, state.inbox.filter),
    state.inbox.cursor,
  );
}

function decideSelectedInboxEntry(runtime: IntentRuntime, approved: boolean): void {
  const entry = selectedInbox(runtime.current);
  if (entry === null) return;
  if (entry.kind === "proposal") void runtime.decideProposal(entry.id, approved);
  else void runtime.decideApproval(entry.id, approved);
}

function approveSelectedInboxGroup(runtime: IntentRuntime): void {
  const state = runtime.current.inbox;
  const group = inboxGroupIds(
    groupInbox(state.proposals, state.approvals, state.filter),
    state.cursor,
  );
  if (group === null || group.proposalIds.length === 0) return;
  void approveProposalIds(group.proposalIds, runtime.decideProposal);
}

async function approveProposalIds(
  ids: readonly string[],
  decide: (id: string, approved: boolean) => Promise<void>,
): Promise<void> {
  for (const id of ids) await decide(id, true);
}

function openSelectedTarget(runtime: IntentRuntime): void {
  const explore = runtime.current.explore;
  if (runtime.current.view === "explore" && explore.pane === "view") {
    const item = noteOutline(explore.structure)[explore.outlineCursor];
    if (item && explore.notePath && explore.revision)
      void runtime.openNote(explore.notePath, item.selector, explore.revision);
    return;
  }
  const target = exploreOpenTarget(runtime.current);
  if (target === null) return;
  if (target.kind === "source") {
    const { source } = target;
    void runtime.openNote(
      source.path,
      { kind: "range", start: source.range.start, end: source.range.end },
      source.revision,
      source.quote,
    );
  } else if (target.kind === "citation") void runtime.openCitation(target.target);
  else void runtime.openNote(target.target);
}

function usePoll(enabled: boolean, intervalMs: number, run: () => Promise<void>): void {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const tick = (): void => {
      if (cancelled) return;
      void run();
    };
    const timer = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, intervalMs, run]);
}

/** Coalesces every caller onto one request until that request settles. */
export function runSingleFlight(
  inFlight: { current: Promise<void> | null },
  task: () => Promise<void>,
): Promise<void> {
  if (inFlight.current !== null) return inFlight.current;
  const request = Promise.resolve().then(task);
  inFlight.current = request;
  void request.then(
    () => {
      if (inFlight.current === request) inFlight.current = null;
    },
    () => {
      if (inFlight.current === request) inFlight.current = null;
    },
  );
  return request;
}

/**
 * Queue an authoritative read behind any older poll. Replacing `current`
 * immediately prevents a new periodic poll from slipping between the barrier
 * and its trailing request.
 */
export function runTrailingFlight(
  inFlight: { current: Promise<void> | null },
  task: () => Promise<void>,
): Promise<void> {
  const prior = inFlight.current;
  const request = (prior ?? Promise.resolve()).catch(() => undefined).then(task);
  inFlight.current = request;
  void request.then(
    () => {
      if (inFlight.current === request) inFlight.current = null;
    },
    () => {
      if (inFlight.current === request) inFlight.current = null;
    },
  );
  return request;
}

export async function loadActiveView(
  view: ViewId,
  loaders: {
    home: () => Promise<void>;
    inbox: () => Promise<void>;
    stream: () => Promise<void>;
  },
): Promise<void> {
  if (view === "home") await loaders.home();
  if (view === "inbox") await loaders.inbox();
  if (view === "stream") await loaders.stream();
}

/** Re-read both the bounded Inbox page and its vault-wide count after a decision. */
export async function refreshPendingState(
  loadInbox: () => Promise<void>,
  loadStats: () => Promise<void>,
): Promise<void> {
  await Promise.all([loadInbox(), loadStats()]);
}

export type PendingTransitionPhase = "pending" | "resolved";

/** Coalesce concurrent observations without retaining settled transition ids. */
export async function refreshPendingTransitionOnce(
  inFlight: Map<string, Promise<void>>,
  phase: PendingTransitionPhase,
  id: string,
  refresh: () => Promise<void>,
): Promise<void> {
  const key = `${phase}:${id}`;
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing;

  const request = Promise.resolve().then(refresh);
  inFlight.set(key, request);
  try {
    await request;
  } finally {
    if (inFlight.get(key) === request) inFlight.delete(key);
  }
}

interface PendingDecisionTransitionOptions {
  id: string;
  context: string;
  decide: () => Promise<string>;
  dispatch: React.Dispatch<Action>;
  fail: (error: unknown, context: string) => void;
  refreshInbox: () => Promise<void>;
  refreshStats: () => Promise<void>;
  refreshResolved: () => Promise<void>;
}

/** Optimistically remove one row, decide it, then reconcile both count authorities. */
export async function runPendingDecisionTransition(
  options: PendingDecisionTransitionOptions,
): Promise<void> {
  options.dispatch({ type: "inbox/drop", id: options.id });
  let resolved = false;
  try {
    const notice = await options.decide();
    resolved = true;
    options.dispatch({ type: "notice", text: notice });
  } catch (error) {
    options.fail(error, options.context);
  }
  await refreshPendingState(
    options.refreshInbox,
    resolved ? options.refreshResolved : options.refreshStats,
  );
}

interface SlashCommandRuntimeOptions {
  line: string;
  context: SlashContext;
  dispatch: React.Dispatch<Action>;
  onExit: () => void;
  refreshInbox: () => Promise<void>;
  refreshStats: () => Promise<void>;
  refreshResolved: (id: string) => Promise<void>;
}

/** Execute one slash command and reconcile every possible pending-state mutation. */
export async function runSlashCommand(options: SlashCommandRuntimeOptions): Promise<SlashOutcome> {
  const outcome = await dispatchSlashCommand(
    options.line.startsWith("/") ? options.line : `/${options.line}`,
    options.context,
  );
  if (outcome.resetTranscript) {
    options.dispatch({
      type: "ask/reset",
      line: { kind: "system", text: "Transcript cleared." },
    });
  } else if (outcome.message.length > 0) {
    options.dispatch({ type: "command/output", text: outcome.message });
    options.dispatch({ type: "ask/line", line: { kind: "system", text: outcome.message } });
  }
  if (outcome.pendingTransition !== undefined) {
    const transition = outcome.pendingTransition;
    await refreshPendingState(
      options.refreshInbox,
      transition.state === "resolved"
        ? () => options.refreshResolved(transition.id)
        : options.refreshStats,
    );
  }
  if (outcome.exit) options.onExit();
  return outcome;
}

async function runAwaken(
  verb: "run" | "pause" | "resume" | "cancel",
  rpc: NotientRpc,
  dispatch: React.Dispatch<Action>,
  fail: (error: unknown, context: string) => void,
  loadStats: () => Promise<void>,
): Promise<void> {
  try {
    if (verb === "run") await rpc.awaken({ background: true });
    else await rpc.awakenControl(verb);
    dispatch({ type: "notice", text: `awaken ${verb} requested` });
  } catch (error) {
    fail(error, `awaken.${verb}`);
  }
  await loadStats();
}

function lastAssistantText(state: AppState): string | null {
  for (let index = state.ask.lines.length - 1; index >= 0; index -= 1) {
    const line = state.ask.lines[index];
    if (line !== undefined && line.kind === "assistant") return line.text;
  }
  return null;
}

export function scrollBy(
  ref: { readonly current: Pick<ScrollBoxRenderable, "scrollBy"> | null },
  delta: number,
): void {
  const scroll = ref.current;
  if (scroll === null) return;
  scroll.scrollBy({ x: 0, y: delta }, "absolute");
}

type InboxScrollRef = {
  readonly current: {
    readonly scrollTop: number;
    readonly viewport: { readonly height: number };
    scrollTo(position: number | { x: number; y: number }): void;
  } | null;
};

/** Keep the selected filtered/grouped row inside the Inbox viewport. */
export function revealInboxSelection(
  ref: InboxScrollRef,
  inbox: InboxState,
  viewportHeight: number,
): void {
  const scroll = ref.current;
  if (scroll === null) return;
  const groups = groupInbox(inbox.proposals, inbox.approvals, inbox.filter);
  const selectedRow = inboxSelectionVisualRow(groups, inbox.cursor);
  if (selectedRow === null) return;
  const viewportRows = Math.max(1, Math.min(viewportHeight, Math.floor(scroll.viewport.height)));
  const firstVisible = scroll.scrollTop;
  const lastVisible = firstVisible + viewportRows - 1;
  if (selectedRow < firstVisible) {
    scroll.scrollTo({ x: 0, y: selectedRow });
  } else if (selectedRow > lastVisible) {
    scroll.scrollTo({ x: 0, y: selectedRow - viewportRows + 1 });
  }
}

/** A new Inbox filter starts from its first group and selected row. */
export function resetInboxScroll(ref: InboxScrollRef): void {
  ref.current?.scrollTo({ x: 0, y: 0 });
}

function readSequence(event: KeyEvent): string | undefined {
  const raw = (event as unknown as { sequence?: unknown }).sequence;
  return typeof raw === "string" ? raw : undefined;
}

/** Single-line editing for the prompt buffer; the store owns the value. */
export function editBuffer(
  buffer: string,
  key: { name: string; ctrl?: boolean; meta?: boolean; sequence?: string },
): string | null {
  if (key.ctrl === true) {
    if (key.name === "u") return "";
    if (key.name === "w") return buffer.replace(/\S*\s*$/, "");
    return null;
  }
  if (key.name === "backspace") return buffer.slice(0, -1);
  if (key.name === "space") return `${buffer} `;
  const char = key.sequence ?? (key.name.length === 1 ? key.name : "");
  if (char.length !== 1) return null;
  const code = char.charCodeAt(0);
  if (code < 32 || code === 127) return null;
  return buffer + char;
}

/**
 * Applies one `chat.send` event frame to the store. Returns the assistant
 * text this frame contributed so the caller can accumulate the turn's full
 * answer for the token estimate and the citation scan.
 */
export function handleStreamEvent(
  detail: Record<string, unknown>,
  dispatch: React.Dispatch<Action>,
): string {
  const event = readCanonicalEventName(detail.event);
  if (!Object.hasOwn(STREAM_EVENT_HANDLERS, event)) {
    throw streamIntegrity(event, "event", "is not a supported event");
  }
  const handler = STREAM_EVENT_HANDLERS[event];
  if (handler === undefined) throw streamIntegrity(event, "event", "is not a supported event");
  return handler(detail, dispatch);
}

type StreamEventHandler = (
  detail: Record<string, unknown>,
  dispatch: React.Dispatch<Action>,
) => string;

const STREAM_EVENT_HANDLERS: Readonly<Record<string, StreamEventHandler>> = {
  "turn:usage": (detail) => {
    assertExactEvent(detail, "turn:usage", ["attempts", "durationMs"]);
    z.array(inferenceAttemptSchema).max(128).parse(detail.attempts);
    z.number().int().nonnegative().parse(detail.durationMs);
    return "";
  },
  "turn:start": handleTurnStart,
  "turn:complete": handleTurnComplete,
  "turn:aborted": handleTurnAborted,
  "loop:assistant_delta": handleAssistantDelta,
  "loop:reasoning_delta": handleReasoningDelta,
  "loop:tool_call_started": handleToolCallStarted,
  "loop:tool_call_result": handleToolCallResult,
  "loop:tool_call_error": handleToolCallError,
  "loop:approval_pending": handleApprovalPending,
  "loop:approval_resolved": handleApprovalResolved,
  "loop:context_summarized": handleContextSummarized,
  "loop:context_overflow_warning": handleContextOverflow,
  "loop:tool_mode_probed": handleToolModeProbed,
  "loop:done": handleLoopDone,
  "loop:error": handleLoopError,
};

function handleTurnStart(detail: Record<string, unknown>): string {
  assertExactEvent(detail, "turn:start", ["conversationId", "userMessage"]);
  readCanonicalWireString(detail.conversationId, "turn:start", "conversationId");
  readRecord(detail.userMessage, "turn:start", "userMessage");
  return "";
}

function handleTurnComplete(
  detail: Record<string, unknown>,
  dispatch: React.Dispatch<Action>,
): string {
  assertExactEvent(detail, "turn:complete", ["conversation"]);
  const conversation = conversationSchema.parse(detail.conversation);
  dispatch({ type: "ask/sources", sources: conversationSources(conversation.messages) });
  const lastUser = conversation.messages.map((message) => message.role).lastIndexOf("user");
  for (const draft of preparedDrafts(conversation.messages.slice(lastUser + 1)))
    dispatch({ type: "ask/line", line: { kind: "draft", draft } });
  return "";
}

function handleTurnAborted(detail: Record<string, unknown>): string {
  assertExactEvent(detail, "turn:aborted", ["reason"]);
  readCanonicalWireString(detail.reason, "turn:aborted", "reason");
  return "";
}

function handleAssistantDelta(
  detail: Record<string, unknown>,
  dispatch: React.Dispatch<Action>,
): string {
  assertExactEvent(detail, "loop:assistant_delta", ["contentDelta"]);
  const text = readNonemptyWireText(detail.contentDelta, "loop:assistant_delta", "contentDelta");
  dispatch({ type: "ask/assistantDelta", text });
  return text;
}

function handleReasoningDelta(detail: Record<string, unknown>): string {
  assertExactEvent(detail, "loop:reasoning_delta", ["reasoningDelta"]);
  readNonemptyWireText(detail.reasoningDelta, "loop:reasoning_delta", "reasoningDelta");
  return "";
}

function handleToolCallStarted(
  detail: Record<string, unknown>,
  dispatch: React.Dispatch<Action>,
): string {
  const event = "loop:tool_call_started";
  assertExactEvent(detail, event, ["callId", "tool", "args"]);
  readCanonicalWireString(detail.callId, event, "callId");
  const tool = readCanonicalWireString(detail.tool, event, "tool");
  readRecord(detail.args, event, "args");
  dispatch({ type: "ask/line", line: { kind: "tool", text: tool } });
  return "";
}

function handleToolCallResult(
  detail: Record<string, unknown>,
  dispatch: React.Dispatch<Action>,
): string {
  const event = "loop:tool_call_result";
  assertExactEvent(detail, event, ["callId", "durationMs"], ["result"]);
  const callId = readCanonicalWireString(detail.callId, event, "callId");
  readNonNegativeInteger(detail.durationMs, event, "durationMs");
  if (Object.hasOwn(detail, "result") && !isJsonValue(detail.result)) {
    throw streamIntegrity(event, "result", "must be a JSON value when present");
  }
  dispatch({
    type: "ask/line",
    line: { kind: "tool", text: `done ${callId.slice(0, 8)}` },
  });
  return "";
}

function handleToolCallError(
  detail: Record<string, unknown>,
  dispatch: React.Dispatch<Action>,
): string {
  const event = "loop:tool_call_error";
  assertExactEvent(detail, event, ["callId", "error", "durationMs"]);
  readCanonicalWireString(detail.callId, event, "callId");
  const error = readCanonicalWireString(detail.error, event, "error");
  readNonNegativeInteger(detail.durationMs, event, "durationMs");
  dispatch({ type: "ask/line", line: { kind: "error", text: `tool error: ${error}` } });
  return "";
}

function handleApprovalPending(
  detail: Record<string, unknown>,
  dispatch: React.Dispatch<Action>,
): string {
  const event = "loop:approval_pending";
  assertExactEvent(detail, event, ["callId", "tool", "args", "preview"]);
  const callId = readCanonicalWireString(detail.callId, event, "callId");
  const tool = readCanonicalWireString(detail.tool, event, "tool");
  readRecord(detail.args, event, "args");
  readNonemptyWireText(detail.preview, event, "preview");
  dispatch({ type: "ask/approvalPending", callId, tool });
  dispatch({
    type: "ask/line",
    line: {
      kind: "approval",
      text: `pending: ${tool} (callId=${callId})`,
      callId,
    },
  });
  return "";
}

function handleApprovalResolved(
  detail: Record<string, unknown>,
  dispatch: React.Dispatch<Action>,
): string {
  const event = "loop:approval_resolved";
  if (detail.approved === true) {
    assertExactEvent(detail, event, ["callId", "approved"]);
  } else if (detail.approved === false) {
    assertExactEvent(detail, event, ["callId", "approved", "reason"]);
    readCanonicalWireString(detail.reason, event, "reason");
  } else {
    throw streamIntegrity(event, "approved", "must be a boolean decision");
  }
  const callId = readCanonicalWireString(detail.callId, event, "callId");
  dispatch({ type: "ask/approvalResolved", callId });
  return "";
}

function handleContextSummarized(
  detail: Record<string, unknown>,
  dispatch: React.Dispatch<Action>,
): string {
  const event = "loop:context_summarized";
  assertExactEvent(detail, event, [
    "conversationId",
    "model",
    "originalTokens",
    "summarizedTokens",
  ]);
  readCanonicalWireString(detail.conversationId, event, "conversationId");
  const model = readCanonicalWireString(detail.model, event, "model");
  const originalTokens = readPositiveInteger(detail.originalTokens, event, "originalTokens");
  const summarizedTokens = readNonNegativeInteger(
    detail.summarizedTokens,
    event,
    "summarizedTokens",
  );
  if (summarizedTokens > originalTokens) {
    throw streamIntegrity(event, "summarizedTokens", "cannot exceed originalTokens");
  }
  dispatch({ type: "ask/model", model });
  dispatch({
    type: "ask/line",
    line: {
      kind: "system",
      text: `context summarized (${originalTokens} → ${summarizedTokens} tokens)`,
    },
  });
  return "";
}

function handleContextOverflow(
  detail: Record<string, unknown>,
  dispatch: React.Dispatch<Action>,
): string {
  const event = "loop:context_overflow_warning";
  assertExactEvent(detail, event, [
    "conversationId",
    "model",
    "configuredTokens",
    "estimatedTokens",
  ]);
  readCanonicalWireString(detail.conversationId, event, "conversationId");
  const model = readCanonicalWireString(detail.model, event, "model");
  const configuredTokens = readPositiveInteger(detail.configuredTokens, event, "configuredTokens");
  const estimatedTokens = readPositiveInteger(detail.estimatedTokens, event, "estimatedTokens");
  if (estimatedTokens <= configuredTokens) {
    throw streamIntegrity(event, "estimatedTokens", "must exceed configuredTokens");
  }
  dispatch({ type: "ask/model", model });
  dispatch({
    type: "ask/line",
    line: {
      kind: "system",
      text: `warning: configured modelContextTokens=${configuredTokens} but turn estimates ${estimatedTokens} tokens.`,
    },
  });
  return "";
}

function handleToolModeProbed(
  detail: Record<string, unknown>,
  dispatch: React.Dispatch<Action>,
): string {
  const event = "loop:tool_mode_probed";
  assertExactEvent(detail, event, ["model", "mode", "attempts"]);
  const model = readCanonicalWireString(detail.model, event, "model");
  if (detail.mode !== "native" && detail.mode !== "disabled") {
    throw streamIntegrity(event, "mode", "must be native or disabled");
  }
  if (detail.attempts !== 1 && detail.attempts !== 2) {
    throw streamIntegrity(event, "attempts", "must be 1 or 2");
  }
  dispatch({ type: "ask/model", model });
  dispatch({
    type: "ask/line",
    line: {
      kind: "system",
      text: `tool-mode for ${model}: ${detail.mode} (attempts=${detail.attempts})`,
    },
  });
  return "";
}

function handleLoopDone(detail: Record<string, unknown>, dispatch: React.Dispatch<Action>): string {
  const event = "loop:done";
  assertExactEvent(detail, event, ["finalMessage", "truncated"]);
  const parsed = conversationMessageSchema.safeParse(detail.finalMessage);
  if (!parsed.success || parsed.data.role !== "assistant")
    throw streamIntegrity(event, "finalMessage", "must be a valid assistant message");
  if (typeof detail.truncated !== "boolean") {
    throw streamIntegrity(event, "truncated", "must be a boolean");
  }
  dispatch({ type: "ask/assistantFinal", text: parsed.data.content });
  if (detail.truncated) {
    dispatch({
      type: "ask/line",
      line: {
        kind: "error",
        text: "This turn reached its tool-round limit. You can ask to continue from the evidence gathered.",
      },
    });
  }
  return parsed.data.content;
}

function handleLoopError(
  detail: Record<string, unknown>,
  dispatch: React.Dispatch<Action>,
): string {
  const event = "loop:error";
  assertExactEvent(detail, event, ["message"]);
  const message = readCanonicalWireString(detail.message, event, "message");
  dispatch({ type: "ask/line", line: { kind: "error", text: message } });
  return "";
}

const EVENT_ENVELOPE_FIELDS = ["id", "type", "event"] as const;

function assertExactEvent(
  detail: Record<string, unknown>,
  event: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  if (detail.type !== "event" || detail.event !== event) {
    throw streamIntegrity(event, "envelope", "must be an event frame with the matching name");
  }
  readCanonicalWireString(detail.id, event, "id");
  const allowed = new Set([...EVENT_ENVELOPE_FIELDS, ...required, ...optional]);
  const unsupported = Object.keys(detail).find((field) => !allowed.has(field));
  if (unsupported !== undefined) {
    throw streamIntegrity(event, unsupported, "is not part of the canonical event shape");
  }
  const missing = required.find((field) => !Object.hasOwn(detail, field));
  if (missing !== undefined) throw streamIntegrity(event, missing, "is required");
}

function readCanonicalEventName(value: unknown): string {
  return readCanonicalWireString(value, "unknown", "event");
}

function readCanonicalWireString(value: unknown, event: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    containsWireControlCharacter(value)
  ) {
    throw streamIntegrity(event, field, "must be a canonical nonblank string");
  }
  return value;
}

function readNonemptyWireText(value: unknown, event: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw streamIntegrity(event, field, "must be a nonempty string");
  }
  return value;
}

function containsWireControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code < 32 || code === 127)) return true;
  }
  return false;
}

function readRecord(value: unknown, event: string, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw streamIntegrity(event, field, "must be an object");
  }
  return value as Record<string, unknown>;
}

function readNonNegativeInteger(value: unknown, event: string, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw streamIntegrity(event, field, "must be a non-negative integer");
  }
  return value as number;
}

function readPositiveInteger(value: unknown, event: string, field: string): number {
  const integer = readNonNegativeInteger(value, event, field);
  if (integer === 0) throw streamIntegrity(event, field, "must be positive");
  return integer;
}

function isJsonValue(value: unknown, seen: Set<object> = new Set(), depth = 0): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (typeof value !== "object" || value === null || seen.has(value) || depth > 64) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, seen, depth + 1));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((entry) => isJsonValue(entry, seen, depth + 1));
}

export class ChatStreamIntegrityError extends Error {
  constructor(event: string, field: string, reason: string) {
    super(`chat.send event integrity error at ${event}.${field}: ${reason}`);
    this.name = "ChatStreamIntegrityError";
  }
}

function streamIntegrity(event: string, field: string, reason: string): ChatStreamIntegrityError {
  return new ChatStreamIntegrityError(event, field, reason);
}

async function loadExtraction(
  rpc: NotientRpc,
  notePath: string,
  dispatch: React.Dispatch<Action>,
  fail: (error: unknown, context: string) => void,
): Promise<void> {
  try {
    const extraction = await rpc.extraction(notePath);
    dispatch({
      type: "explore/extraction",
      concepts: extraction.concepts,
      claims: extraction.claims,
      questions: extraction.questions,
    });
  } catch (error) {
    if (isDisconnect(error)) fail(error, "vault.extraction");
  }
}

async function loadNeighbors(
  rpc: NotientRpc,
  notePath: string,
  dispatch: React.Dispatch<Action>,
  fail: (error: unknown, context: string) => void,
): Promise<void> {
  try {
    const neighbors = await rpc.neighbors(notePath, true);
    dispatch({
      type: "explore/neighbors",
      connections: neighbors,
      neighbors: neighbors.connections.map((row) => ({
        connectionId: row.id,
        notePath: row.note.path,
        table: row.relation,
        direction: row.direction,
        confidence: row.assessment ?? 1,
        agent: row.author,
        proposed: row.state === "proposed",
      })),
    });
  } catch (error) {
    dispatch({
      type: "explore/connectionsFailed",
      message: error instanceof Error ? error.message : String(error),
    });
    if (isDisconnect(error)) fail(error, "graph.neighbors");
  }
}

/**
 * Consumes one `chat.send` stream, applying each event to the store, and
 * returns the assistant text the turn produced.
 */
async function consumeTurnEvent(
  frame: Record<string, unknown>,
  dispatch: React.Dispatch<Action>,
  refreshPendingStats: (phase: PendingTransitionPhase, id: string) => Promise<void>,
): Promise<string> {
  const assistantDelta = handleStreamEvent(frame, dispatch);
  if (frame.event === "loop:approval_pending" || frame.event === "loop:approval_resolved") {
    const phase = frame.event === "loop:approval_pending" ? "pending" : "resolved";
    await refreshPendingStats(phase, readCanonicalWireString(frame.callId, frame.event, "callId"));
  }
  return assistantDelta;
}

export async function drainTurn(
  frames: AsyncIterable<{ type: string; [key: string]: unknown }>,
  dispatch: React.Dispatch<Action>,
  fail: (error: unknown, context: string) => void,
  refreshPendingStats: (phase: PendingTransitionPhase, id: string) => Promise<void>,
): Promise<string> {
  let assistant = "";
  try {
    for await (const frame of frames) {
      if (frame.type === "event") {
        const text = await consumeTurnEvent(
          frame as Record<string, unknown>,
          dispatch,
          refreshPendingStats,
        );
        assistant = frame.event === "loop:done" ? text : assistant + text;
        continue;
      }
      if (frame.type === "error") {
        dispatch({
          type: "ask/line",
          line: frameToErrorLine(frame as { type: "error"; message?: unknown }),
        });
        break;
      }
      if (frame.type === "result") break;
    }
  } catch (error) {
    reportTurnFailure(error, dispatch, fail);
  }
  return assistant;
}

function reportTurnFailure(
  error: unknown,
  dispatch: React.Dispatch<Action>,
  fail: (error: unknown, context: string) => void,
): void {
  if (isDisconnect(error)) fail(error, "chat.send");
  else
    dispatch({
      type: "ask/line",
      line: {
        kind: "error",
        text: `rpc error: ${error instanceof Error ? error.message : String(error)}`,
      },
    });
}

export function frameToErrorLine(frame: { type: "error"; message?: unknown }): ChatLine {
  const message = readCanonicalWireString(frame.message, "rpc:error", "message");
  return { kind: "error", text: `rpc error: ${message}` };
}

function useTurnElapsed(busy: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    if (!busy) return;
    const start = performance.now();
    const timer = setInterval(
      () => setElapsed(Math.floor((performance.now() - start) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [busy]);
  return elapsed;
}
