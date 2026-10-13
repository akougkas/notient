import { Menu, Notice, Platform, setIcon } from "obsidian";
import { ReplyBuffer } from "./replyBuffer";
import { createPresence } from "./presence";
import { createSurfaceViews } from "./surfaceViews";
import { projectToolSurfaces, type SurfaceToolResult, type NotientSurface } from "../../../src/api/surfaces";
import { NotientApiError, type NotientClient } from "../../../src/api/client";
import { type Conversation, type ConversationSummary, summarizeConversation } from "../../../src/api/chat";
import type { GraphNeighbors } from "../../../src/api/graph";
import { sourceReferenceSchema, type SourceReference } from "../../../src/api/schema";
import {
  isCanonicalConversationPath,
  isCanonicalOrdinaryNotePath,
} from "../../../src/core/vault/publicPath";
import { message } from "./host";

type ChatMessage = Conversation["messages"][number];
type ToolCall = NonNullable<ChatMessage["toolCalls"]>[number];
type ToolResult = NonNullable<ChatMessage["toolResults"]>[number];
type ToolTranscriptMessage = ChatMessage & { role: "tool"; toolCallId: string };

export type ChatDestination = "note" | "capture" | "search" | "review" | "activity";

export interface ChatPanelPersistedState {
  conversationId: string | null;
  conversationPath: string | null;
  draft: string;
  attachedNotePath: string | null;
  scrollTop: number | null;
}

export interface ChatToolActivity {
  callId: string;
  tool: string;
  state: "running" | "complete" | "error" | "approval-pending" | "approved" | "rejected";
  preview?: string;
  error?: string;
  durationMs?: number;
  result?: unknown;
}

export interface ChatActionResult {
  kind: "search" | "connections";
  title: string;
  status: string;
  surfaces?: NotientSurface[];
  hits: Array<{
    title: string;
    path: string;
    detail: string;
    evidence: SourceReference | null;
    state?: string;
  }>;
}

export interface ChatPanelState extends ChatPanelPersistedState {
  conversation: Conversation | null;
  conversations: ConversationSummary[];
  historyLoaded: boolean;
  loading: boolean;
  sending: boolean;
  activeTurnId: string | null;
  streamedAssistant: string;
  displayedAssistant: string;
  tools: ChatToolActivity[];
  notice: string | null;
  noticeError: boolean;
  actionResult: ChatActionResult | null;
  scrollTop: number;
  scrollPositionKnown: boolean;
  scrollToBottom: boolean;
  listeners: Set<() => void>;
}

export type ChatPanelClient = NotientClient;

export interface ChatPanelOptions {
  parent: HTMLElement;
  state: ChatPanelState;
  client: ChatPanelClient;
  signal: AbortSignal;
  active: () => Promise<{ path: string | null; dirty: boolean }>;
  markdown: (parent: HTMLElement, text: string, path: string) => Promise<void>;
  source: (parent: HTMLElement, evidence: SourceReference) => void;
  openNote?: (path: string) => Promise<void>;
  navigate: (destination: ChatDestination) => void;
  persist?: (state: ChatPanelPersistedState) => void;
}

const idleHint = "Enter to send · Shift+Enter for a new line · / for commands";

const slashCommands = [
  { command: "/new", detail: "Start a new conversation" },
  { command: "/summarize", detail: "Summarize the attached note" },
  { command: "/connections", detail: "Inspect saved note connections" },
  { command: "/search", detail: "Search saved notes" },
  { command: "/review", detail: "Open proposed changes" },
] as const;

export function createChatPanelState(saved?: unknown): ChatPanelState {
  const value = typeof saved === "object" && saved !== null ? (saved as Record<string, unknown>) : {};
  return {
    conversationId: cleanStoredText(value.conversationId, 512),
    conversationPath: cleanConversationPath(value.conversationPath),
    draft: typeof value.draft === "string" ? value.draft.slice(0, 8192) : "",
    attachedNotePath: cleanPath(value.attachedNotePath),
    conversation: null,
    conversations: [],
    historyLoaded: false,
    loading: false,
    sending: false,
    activeTurnId: null,
    streamedAssistant: "",
    displayedAssistant: "",
    tools: [],
    notice: null,
    noticeError: false,
    actionResult: null,
    scrollTop:
      typeof value.scrollTop === "number" && Number.isFinite(value.scrollTop) && value.scrollTop >= 0
        ? value.scrollTop
        : 0,
    scrollPositionKnown:
      typeof value.scrollTop === "number" && Number.isFinite(value.scrollTop) && value.scrollTop >= 0,
    scrollToBottom: false,
    listeners: new Set(),
  };
}

export function renderChatPanel(options: ChatPanelOptions): void {
  const { parent, state, signal } = options;
  let initialHistoryStarted = false;
  parent.empty();
  const root = parent.createDiv({ cls: "notient-chat notient-chat-room" });
  const toolbar = root.createDiv({ cls: "notient-chat-toolbar" });
  const history = toolbar.createEl("select", {
    cls: "notient-chat-history",
    attr: { "aria-label": "Conversation history", title: "Conversation history" },
  });
  const newConversation = toolbar.createEl("button", {
    text: "New",
    cls: "notient-chat-new",
    attr: { type: "button", "aria-label": "Start a new conversation", title: "Start a new conversation" },
  });
  const doc = parent.ownerDocument;
  const win = doc.defaultView ?? window;
  const modKey = Platform.isMacOS ? "⌘" : "Ctrl";
  let motionPaused = false;
  try { motionPaused = win.localStorage.getItem("notient-motion-paused") === "true"; } catch {}
  root.dataset.motion = motionPaused ? "paused" : "running";
  const motion = toolbar.createEl("button", { cls: "notient-icon-button", attr: { type: "button" } });
  const refreshMotion = () => {
    motion.setAttribute("aria-label", motionPaused ? "Resume ambient motion" : "Pause ambient motion");
    motion.title = motion.getAttribute("aria-label")!;
    setIcon(motion, motionPaused ? "play" : "pause");
    root.dataset.motion = motionPaused ? "paused" : "running";
  };
  motion.addEventListener("click", () => {
    motionPaused = !motionPaused;
    try { win.localStorage.setItem("notient-motion-paused", String(motionPaused)); } catch {}
    refreshMotion();
  });
  refreshMotion();
  const stage = root.createDiv({ cls: "notient-canvas-stage" });
  const presenceSlot = stage;
  const presence = createPresence(presenceSlot, { motionAllowed: () => !motionPaused });
  const transcript = root.createDiv({
    cls: "notient-transcript",
    attr: { role: "log", "aria-live": "off", "aria-label": "Conversation", tabindex: "0" },
  });
  transcript.scrollTop = state.scrollTop;
  let scrollTimer: ReturnType<typeof setTimeout> | null = null;
  transcript.addEventListener("scroll", () => {
    state.scrollTop = transcript.scrollTop;
    state.scrollPositionKnown = true;
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => persist(), 120);
  });
  const notice = root.createDiv({
    cls: "notient-chat-notice",
    attr: { role: "status", "aria-live": "polite" },
  });
  const announcer = root.createDiv({
    cls: "notient-sr-only",
    attr: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
  });
  const composer = root.createEl("form", { cls: "notient-chat-composer" });
  const contextRow = composer.createDiv({ cls: "notient-chat-context" });
  const slashMenu = composer.createDiv({
    cls: "notient-slash-menu",
    attr: { role: "listbox", "aria-label": "Chat commands" },
  });
  slashMenu.hide();
  const textarea = composer.createEl("textarea", {
    cls: "notient-chat-input",
    text: state.draft,
    attr: {
      "aria-label": "Message Notient",
      placeholder: "Ask, explore, or capture a thought…",
      rows: "1",
      maxlength: "8192",
      spellcheck: "true",
    },
  });
  const controls = composer.createDiv({ cls: "notient-chat-controls" });
  const hintRow = composer.createDiv({ cls: "notient-chat-hint" });
  const hint = hintRow.createSpan({ text: idleHint });
  const shortcutsToggle = hintRow.createEl("button", {
    text: "Shortcuts",
    cls: "notient-shortcuts-toggle",
    attr: { type: "button", "aria-expanded": "false", "aria-haspopup": "true", title: "Keyboard and copy shortcuts" },
  });
  const shortcuts = composer.createDiv({
    cls: "notient-shortcuts",
    attr: { role: "region", "aria-label": "Keyboard and copy shortcuts" },
  });
  shortcuts.hidden = true;
  const shortcutList = shortcuts.createEl("dl");
  for (const [keys, action] of [
    ["Enter", "Send"],
    ["Shift+Enter", "New line"],
    ["/", "Commands · Tab completes · ↑↓ choose"],
    [`${modKey}+C`, "Copy selected text"],
    [`${modKey}+A`, "In the conversation: select the focused message, or everything"],
    ["Right-click", "Copy an answer, passage or selection"],
  ] as const) {
    const term = shortcutList.createEl("dt");
    for (const [index, key] of keys.split("+").entries()) {
      if (index) term.appendText("+");
      term.createEl("kbd", { text: key });
    }
    shortcutList.createEl("dd", { text: action });
  }
  shortcuts.createEl("p", {
    text: "Command palette: “Notient: Copy the latest conversation answer” and “Notient: Focus the conversation input”. Assign keys in Settings → Hotkeys.",
  });
  const setShortcutsOpen = (open: boolean) => {
    shortcuts.hidden = !open;
    shortcutsToggle.setAttribute("aria-expanded", String(open));
    if (open) slashMenu.hide();
  };
  const attachButton = controls.createEl("button", {
    text: "Attach current note",
    cls: "notient-chat-attach",
    attr: { type: "button", "aria-label": "Attach the current saved note" },
  });
  const stopButton = controls.createEl("button", {
    text: "Stop",
    cls: "notient-chat-stop",
    attr: { type: "button", "aria-label": "Stop this conversation turn" },
  });
  stopButton.hide();
  const sendButton = controls.createEl("button", {
    text: "Send",
    cls: "notient-chat-send",
    attr: { type: "submit", "aria-label": "Send message" },
  });

  let commandSelection = -1;
  let finishingReply = false;
  const expandedReplies = new Set<string>();
  const replyBuffer = new ReplyBuffer((text) => {
    state.displayedAssistant = text;
    const body = transcript.querySelector<HTMLElement>(".notient-message.is-streaming .notient-message-body");
    if (!signal.aborted && body) {
      paintReply(body);
      body.hidden = !text;
      if (text) {
        body.closest<HTMLElement>(".notient-message")!.hidden = false;
        presence.layout("dock", () => root.removeClass("is-quiet"));
      }
      if (state.sending && text && !state.tools.some((tool) => tool.state === "running" || tool.state === "approval-pending"))
        presence.update({ state: "responding", label: "Gathering the answer" });
    }
    else if (signal.aborted) notify();
  }, parent.ownerDocument);
  let transcriptWork = 0;
  let previousTranscriptKey = "";
  let previousStreamText = "";
  let previousLiveKey = "";
  let fullRenderPending = false;
  let firstLayout = true;

  const persist = () =>
    options.persist?.({
      conversationId: state.conversationId,
      conversationPath: state.conversationPath,
      draft: state.draft,
      attachedNotePath: state.attachedNotePath,
      scrollTop: state.scrollPositionKnown ? state.scrollTop : null,
    });

  const refreshHistory = () => {
    const selected = state.conversationId ?? "";
    history.empty();
    history.createEl("option", { value: "", text: state.loading ? "Loading conversations…" : "Conversation history" });
    for (const conversation of state.conversations) {
      const label = conversation.topic.trim() || conversation.summary.trim() || "Conversation";
      history.createEl("option", {
        value: conversation.id,
        text: `${label} · ${conversation.updatedAt ? new Date(conversation.updatedAt).toLocaleDateString() : conversation.notePath}`,
        attr: { title: conversation.notePath },
      });
    }
    history.value = selected;
    history.disabled = state.loading || state.sending || !state.conversations.length;
    newConversation.disabled = state.loading || state.sending;
  };

  const refreshContext = () => {
    contextRow.empty();
    if (state.attachedNotePath) {
      const chip = contextRow.createDiv({ cls: "notient-chat-context-chip" });
      chip.createSpan({ text: "Note · " });
      chip.createSpan({
        text: shortPath(state.attachedNotePath),
        attr: { title: state.attachedNotePath },
      });
      const remove = chip.createEl("button", {
        text: "×",
        cls: "notient-chat-context-remove",
        attr: { type: "button", "aria-label": `Remove ${state.attachedNotePath} attachment` },
      });
      remove.addEventListener("click", () => {
        state.attachedNotePath = null;
        persist();
        refreshContext();
      });
    }
    attachButton.hidden = !!state.attachedNotePath;
  };

  const setNotice = (text: string | null, error = false) => {
    state.notice = text;
    state.noticeError = !!text && error;
    notice.empty();
    notice.toggleClass("is-error", state.noticeError);
    if (text) notice.setText(text);
    notice.hidden = !text;
    hint.setText(state.sending ? "The conversation continues if you inspect a note." : idleHint);
  };

  const announce = (text: string) => {
    announcer.setText("");
    win.setTimeout(() => {
      if (!signal.aborted) announcer.setText(text);
    }, 60);
  };

  const copyTimers = new WeakMap<HTMLElement, number>();
  const showCopyResult = (button: HTMLElement, result: "copied" | "failed") => {
    const icon = button.querySelector<HTMLElement>(".notient-copy-icon");
    const label = button.querySelector<HTMLElement>(".notient-copy-label");
    button.dataset.state = result;
    if (icon) setIcon(icon, result === "copied" ? "check" : "alert-circle");
    label?.setText(result === "copied" ? "Copied" : "Copy failed");
    const previous = copyTimers.get(button);
    if (previous) win.clearTimeout(previous);
    copyTimers.set(
      button,
      win.setTimeout(() => {
        delete button.dataset.state;
        if (icon) setIcon(icon, "copy");
        label?.setText("Copy");
      }, 2000),
    );
  };

  const copyWithFeedback = async (
    text: string,
    done: string,
    button: HTMLElement | null = null,
    toast = false,
  ) => {
    try {
      await copyToClipboard(doc, text);
      if (toast) new Notice(done);
      if (signal.aborted) return;
      if (button) showCopyResult(button, "copied");
      announce(done);
      if (state.noticeError && state.notice?.startsWith("Could not copy")) setNotice(null);
      return true;
    } catch (error) {
      const failure = `Could not copy to the clipboard (${message(error)}). Select the text and press ${modKey}+C instead.`;
      if (toast) new Notice(failure, 8000);
      if (signal.aborted) return;
      if (button) showCopyResult(button, "failed");
      setNotice(failure, true);
      announce(failure);
      return false;
    }
  };

  const copySources = new WeakMap<Element, { label: string; done: string; text: string }>();
  const createCopyButton = (
    target: HTMLElement,
    text: string,
    copy: { label: string; done: string; replyId?: string; compact?: boolean },
  ) => {
    const button = target.createEl("button", {
      cls: `notient-copy${copy.compact ? " is-compact" : ""}`,
      attr: { type: "button", "aria-label": copy.label, title: copy.label },
    });
    if (copy.replyId) button.dataset.replyId = copy.replyId;
    setIcon(button.createSpan({ cls: "notient-copy-icon", attr: { "aria-hidden": "true" } }), "copy");
    button.createSpan({ text: "Copy", cls: "notient-copy-label" });
    button.addEventListener("click", () => void copyWithFeedback(text, copy.done, button));
    return button;
  };

  const renderMarkdown = async (target: HTMLElement, text: string, path: string) => {
    await options.markdown(target, text, path);
    bindInternalNoteLinks(target, options.openNote, (value) => setNotice(value, true));
  };

  const selectContents = (element: HTMLElement) => {
    const selection = doc.getSelection();
    if (!selection) return;
    const range = doc.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const transcriptSelection = () => {
    const selection = doc.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return "";
    return transcript.contains(selection.getRangeAt(0).commonAncestorContainer) ? selection.toString() : "";
  };

  const openNote = (path: string) => {
    if (!isCanonicalOrdinaryNotePath(path) || !options.openNote) return;
    void options.openNote(path).catch((error) => setNotice(message(error), true));
  };

  const appendExactSources = (target: HTMLElement, sources: SourceReference[]) => {
    const unique = new Map<string, SourceReference>();
    for (const source of sources) {
      const parsed = sourceReferenceSchema.safeParse(source);
      if (!parsed.success) continue;
      const item = parsed.data;
      unique.set(
        `${item.path}\0${item.revision}\0${item.range.start}\0${item.range.end}`,
        item,
      );
    }
    if (!unique.size) return;
    const details = target.createEl("details", { cls: "notient-chat-sources" });
    details.createEl("summary", { text: `Sources · ${unique.size}` });
    for (const source of unique.values()) {
      const item = details.createDiv({ cls: "notient-chat-source" });
      const head = item.createDiv({ cls: "notient-chat-source-head" });
      options.source(head, source);
      const copy = {
        label: `Copy passage from ${shortPath(source.path)}`,
        done: "Passage copied.",
        text: source.quote,
      };
      createCopyButton(head, source.quote, { ...copy, compact: true });
      copySources.set(item, copy);
      const quote = item.createDiv({ cls: "notient-chat-source-quote" });
      void renderMarkdown(quote, source.quote, source.path);
    }
  };

  const renderTools = (
    container: HTMLElement,
    calls: ToolCall[],
    results: ToolResult[],
    toolMessages: ToolTranscriptMessage[] = [],
  ) => {
    if (!calls.length) return;
    const details = container.createEl("details", { cls: "notient-chat-tools" });
    details.createEl("summary", { text: "Execution record" });
    for (const result of results.filter((item) => item.status === "error")) {
      container.createDiv({ text: result.error ?? "A requested operation failed.", cls: "notient-error", attr: { role: "status" } });
    }
    for (const call of calls) {
      const result = results.find((item) => item.callId === call.id);
      const savedToolMessage = toolMessages.some((item) => item.toolCallId === call.id);
      const row = details.createDiv({ cls: `notient-tool-row${result || savedToolMessage ? "" : " is-running"}` });
      row.createSpan({ text: call.name.replaceAll("_", " ") });
      if (result) {
        row.createSpan({ text: result.status === "ok" ? "Done" : "Failed", cls: "notient-tool-state" });
        if (result.durationMs > 0)
          row.createSpan({ text: `${(result.durationMs / 1000).toFixed(1)}s`, cls: "notient-muted" });
      } else if (savedToolMessage) row.createSpan({ text: "Result saved", cls: "notient-muted" });
      else row.createSpan({ text: "No result recorded", cls: "notient-muted" });
    }
  };

  const renderActionResult = (container: HTMLElement, result: ChatActionResult) => {
    const section = container.createDiv({ cls: "notient-chat-action-result" });
    section.createEl("h3", { text: result.title });
    section.createEl("p", { text: result.status, cls: "notient-muted" });
    if (result.surfaces) {
      surfacesFor(section).update(result.surfaces);
      return;
    }
    for (const hit of result.hits) {
      const row = section.createDiv({ cls: "notient-chat-action-hit" });
      const title = row.createEl("button", {
        text: hit.title,
        cls: "notient-chat-action-title",
        attr: { type: "button", title: hit.path },
      });
      title.addEventListener("click", () => openNote(hit.path));
      if (hit.state) row.createSpan({ text: hit.state, cls: "notient-chat-action-state" });
      row.createDiv({ text: hit.detail, cls: "notient-muted" });
      if (hit.evidence) {
        options.source(row, hit.evidence);
        const passage = row.createEl("details", { cls: "notient-chat-action-passage" });
        passage.createEl("summary", { text: "Read passage" });
        const quote = passage.createDiv({ cls: "notient-chat-source-quote" });
        const copy = {
          label: `Copy passage from ${shortPath(hit.evidence.path)}`,
          done: "Passage copied.",
          text: hit.evidence.quote,
        };
        copySources.set(passage, copy);
        void renderMarkdown(quote, hit.evidence.quote, hit.evidence.path);
        createCopyButton(passage.createDiv({ cls: "notient-message-actions" }), hit.evidence.quote, {
          ...copy,
          compact: true,
        });
      }
    }
  };

  const renderLiveTools = (container: HTMLElement) => {
    if (!state.tools.length) return;
    const details = container.createEl("details", { cls: "notient-chat-tools" });
    details.createEl("summary", { text: "Execution record" });
    for (const activity of state.tools) {
      const attention = activity.state === "approval-pending" || activity.state === "error";
      const row = (attention ? container : details).createDiv({
        cls: `notient-tool-row${activity.state === "running" ? " is-running" : ""}`,
      });
      row.createSpan({ text: activity.tool.replaceAll("_", " ") });
      row.createSpan({ text: liveToolState(activity.state), cls: "notient-tool-state" });
      if (activity.durationMs !== undefined)
        row.createSpan({ text: `${(activity.durationMs / 1000).toFixed(1)}s`, cls: "notient-muted" });
      if (activity.error) row.createDiv({ text: activity.error, cls: "notient-error" });
      if (activity.preview) row.createDiv({ text: activity.preview, cls: "notient-chat-approval-preview" });
      if (activity.state === "approval-pending") {
        const buttons = row.createDiv({ cls: "notient-chat-approval-actions" });
        const approve = buttons.createEl("button", { text: "Approve", attr: { type: "button" } });
        const reject = buttons.createEl("button", { text: "Reject", attr: { type: "button" } });
        approve.addEventListener("click", () => void decideApproval(activity, true, approve, reject));
        reject.addEventListener("click", () => void decideApproval(activity, false, approve, reject));
      }
    }
  };

  const liveKey = () =>
    [
      state.sending,
      ...state.tools.map((item) => `${item.callId}:${item.state}:${item.error ?? ""}:${item.preview ?? ""}`),
    ].join("|");

  const surfaceRenderers = new Map<HTMLElement, ReturnType<typeof createSurfaceViews>>();
  const surfacesFor = (bubble: HTMLElement) => {
    let renderer = surfaceRenderers.get(bubble);
    if (!renderer) {
      const slot = bubble.createDiv({ cls: "notient-canvas-results" });
      renderer = createSurfaceViews(slot, {
        source: options.source,
        openNote: options.openNote,
        copy: (text, label) => copyWithFeedback(text, label),
        onError: (error) => setNotice(message(error), true),
      });
      surfaceRenderers.set(bubble, renderer);
    }
    return renderer;
  };
  const liveResults = (): SurfaceToolResult[] => state.tools
    .filter((tool) => tool.state === "complete" || tool.state === "error")
    .map((tool) => ({ callId: tool.callId, tool: tool.tool,
      status: tool.state === "error" ? "error" : "ok", data: tool.result, error: tool.error }));
  const appendStreaming = () => {
    let bubble = transcript.querySelector<HTMLElement>(".notient-message.is-streaming");
    if (!bubble) {
      bubble = transcript.createDiv({
        cls: "notient-message is-assistant is-streaming",
        attr: { role: "article", "aria-label": "Notient is replying", "aria-busy": "true" },
      });
      bubble.createDiv({ text: "Notient", cls: "notient-message-label" });
      bubble.createDiv({ cls: "notient-message-body" });
      bubble.createDiv({ cls: "notient-turn-record" });
    }
    const body = bubble.querySelector<HTMLElement>(".notient-message-body")!;
    paintReply(body);
    body.hidden = !state.displayedAssistant;
    const record = bubble.querySelector<HTMLElement>(".notient-turn-record")!;
    const wasOpen = record.querySelector<HTMLDetailsElement>("details")?.open ?? false;
    record.empty();
    renderLiveTools(record);
    const details = record.querySelector<HTMLDetailsElement>("details");
    if (details) details.open = wasOpen;
    const surfaces = projectToolSurfaces(liveResults());
    surfacesFor(bubble).update(surfaces, { animate: !motionPaused });
    bubble.hidden = !state.displayedAssistant && !surfaces.length &&
      !state.tools.some((tool) => tool.state === "error" || tool.state === "approval-pending");
  };
  const turnRecords = new Map<string, { bubble: HTMLElement; fingerprint: string }>();
  let renderedConversationId: string | null = null;

  const renderTranscript = async () => {
    if (signal.aborted) return;
    const conversation = state.conversation;
    const showWelcome = !conversation?.messages.length && !state.streamedAssistant && !state.sending;
    const transcriptKey = [
      conversation?.id ?? "",
      conversation?.updatedAt ?? 0,
      conversation?.messageCount ?? 0,
      ...(conversation?.messages.map((item) => `${item.id}:${item.role}:${item.content.length}`) ?? []),
      state.actionResult
        ? JSON.stringify(state.actionResult)
        : "",
      state.conversationId ?? "",
      state.historyLoaded,
      showWelcome,
    ].join("|");
    if (transcriptKey === previousTranscriptKey) {
      if (fullRenderPending) return;
      const live = liveKey();
      if (live !== previousLiveKey) {
        previousLiveKey = live;
        previousStreamText = state.displayedAssistant;
        const follow =
          state.scrollToBottom || transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 72;
        if (state.sending) appendStreaming();
        else transcript.querySelector(".notient-message.is-streaming")?.remove();
        if (follow) transcript.scrollTop = transcript.scrollHeight;
        return;
      }
      if (state.sending && state.displayedAssistant !== previousStreamText) {
        previousStreamText = state.displayedAssistant;
        const body = transcript.querySelector<HTMLElement>(".notient-message.is-streaming .notient-message-body");
        if (body) {
          paintReply(body);
        }
      }
      return;
    }
    previousTranscriptKey = transcriptKey;
    previousStreamText = state.displayedAssistant;
    const work = ++transcriptWork;
    fullRenderPending = true;
    transcript.setAttribute("aria-busy", "true");
    try {
      await paintHistory(work, conversation, showWelcome);
    } catch (error) {
      if (work === transcriptWork && !signal.aborted) {
        previousTranscriptKey = "";
        setNotice(`The conversation could not be displayed completely: ${message(error)}`, true);
      }
    } finally {
      if (work === transcriptWork) {
        fullRenderPending = false;
        transcript.removeAttribute("aria-busy");
      }
    }
  };

  const paintHistory = async (work: number, conversation: Conversation | null, showWelcome: boolean) => {
    const waitingForConversation =
      !conversation && !!(state.conversationId || state.conversationPath) && !state.historyLoaded;
    const emptyTranscript = transcript.childElementCount === 0;
    const follow =
      state.scrollToBottom ||
      (emptyTranscript && !state.scrollPositionKnown) ||
      (!emptyTranscript && transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 72);
    const oldTop = emptyTranscript ? state.scrollTop : transcript.scrollTop;
    const forceScroll = state.scrollToBottom;
    const currentId = conversation?.id ?? state.conversationId;
    if (renderedConversationId !== currentId) {
      for (const renderer of surfaceRenderers.values()) renderer.dispose();
      surfaceRenderers.clear();
      turnRecords.clear();
      transcript.empty();
      renderedConversationId = currentId;
    }
    transcript.querySelectorAll(".notient-ephemeral").forEach((node) => {
      for (const [bubble, renderer] of surfaceRenderers) {
        if (node.contains(bubble)) { renderer.dispose(); surfaceRenderers.delete(bubble); }
      }
      node.remove();
    });
    if (state.actionResult) {
      const local = transcript.createDiv({ cls: "notient-ephemeral" });
      renderActionResult(local, state.actionResult);
    }
    if (!conversation && state.conversationId && !state.historyLoaded) {
      transcript.createEl("p", { text: "Restoring your last conversation…", cls: "notient-muted notient-ephemeral" });
    }
    let cursor: ChildNode | null = transcript.firstChild;
    const mount = (bubble: HTMLElement) => {
      if (cursor === bubble) cursor = bubble.nextSibling;
      else transcript.insertBefore(bubble, cursor);
    };
    const retained = new Set<string>();
    let userTurn = 0;
    if (conversation) {
      let assistantMessages: ChatMessage[] = [];
      let toolMessages: ToolTranscriptMessage[] = [];
      const renderAssistantTurn = async () => {
        const messages = assistantMessages;
        const transcriptMessages = toolMessages;
        assistantMessages = [];
        toolMessages = [];
        if (!messages.length || signal.aborted || work !== transcriptWork) return;

        const key = `assistant:${userTurn}`;
        retained.add(key);
        const calls = messages.flatMap((item) => item.toolCalls ?? []);
        const results = messages.flatMap((item) => item.toolResults ?? []);
        const fingerprint = JSON.stringify([answerText(messages), calls, results, transcriptMessages.map((item) => item.content)]);
        const existing = turnRecords.get(key);
        if (existing?.fingerprint === fingerprint) { mount(existing.bubble); return; }
        const totalUserTurns = conversation.messages.filter((item) => item.role === "user").length;
        const streaming = userTurn === totalUserTurns
          ? transcript.querySelector<HTMLElement>(".notient-message.is-streaming") : null;
        const bubble = existing?.bubble ?? streaming ?? transcript.createDiv({
          cls: "notient-message is-assistant",
          attr: { role: "article", "aria-label": "Notient" },
        });
        bubble.classList.remove("is-streaming");
        bubble.hidden = false;
        bubble.removeAttribute("aria-busy");
        bubble.setAttribute("aria-label", "Notient");
        bubble.querySelectorAll(".notient-message-label, .notient-message-actions, .notient-turn-record, .notient-turn-sources").forEach((node) => node.remove());
        mount(bubble);
        const label = bubble.createDiv({ text: "Notient", cls: "notient-message-label" });
        bubble.prepend(label);
        const body = bubble.querySelector<HTMLElement>(".notient-message-body") ?? bubble.createDiv({ cls: "notient-message-body" });
        body.hidden = false;
        body.empty();
        body.removeClass("is-collapsed");
        const answer = answerText(messages);
        if (answer) {
          const replyId = messages.at(-1)?.id ?? answer;
          const copy = { label: "Copy answer as Markdown", done: "Answer copied as Markdown.", text: answer };
          copySources.set(bubble, copy);
          await renderMarkdown(body, answer, conversation.notePath);
          if (signal.aborted || work !== transcriptWork) return;
          const actions = bubble.createDiv({ cls: "notient-message-actions" });
          body.after(actions);
          createCopyButton(actions, answer, { ...copy, replyId });
          if (answer.length > 1500) {
            const expanded = expandedReplies.has(replyId);
            body.toggleClass("is-collapsed", !expanded);
            const expand = actions.createEl("button", { text: expanded ? "Show less" : "Read full response", cls: "notient-reply-expand", attr: { type: "button", "aria-expanded": String(expanded) } });
            expand.addEventListener("click", () => {
              const next = !expandedReplies.has(replyId);
              if (next) expandedReplies.add(replyId); else expandedReplies.delete(replyId);
              body.toggleClass("is-collapsed", !next);
              expand.setText(next ? "Show less" : "Read full response");
              expand.setAttribute("aria-expanded", String(next));
            });
          }
        }
        if (signal.aborted || work !== transcriptWork) return;

        const callIds = new Set(calls.map((call) => call.id));
        const relatedToolMessages = transcriptMessages.filter((item) => callIds.has(item.toolCallId));
        const record = bubble.createDiv({ cls: "notient-turn-record" });
        if (calls.length) renderTools(record, calls, results, relatedToolMessages);
        else {
          const context = record.createEl("details", { cls: "notient-chat-tools" });
          context.createEl("summary", { text: "Reply context" });
          context.createDiv({ text: "No tools executed in this turn. This reply may use supplied source context.", cls: "notient-muted" });
        }
        const projected: SurfaceToolResult[] = results.map((result) => ({
          ...result, tool: calls.find((call) => call.id === result.callId)?.name,
        }));
        for (const toolMessage of relatedToolMessages) {
          if (projected.some((result) => result.callId === toolMessage.toolCallId)) continue;
          try {
            projected.push({ callId: toolMessage.toolCallId, tool: calls.find((call) => call.id === toolMessage.toolCallId)?.name,
              status: "ok", data: JSON.parse(toolMessage.content) });
          } catch {}
        }
        surfacesFor(bubble).update(projectToolSurfaces(projected));
        bubble.append(record);
        const sources = [
          ...collectSourceReferences(results),
          ...transcriptMessages.flatMap((item) => collectSourceReferences(item.content)),
        ];
        if (sources.length) {
          const sourceRecord = bubble.createEl("details", { cls: "notient-turn-sources" });
          sourceRecord.createEl("summary", { text: "Source evidence" });
          appendExactSources(sourceRecord, sources);
        }
        turnRecords.set(key, { bubble, fingerprint });
      };

      for (const item of conversation.messages) {
        if (signal.aborted || work !== transcriptWork) return;
        if (item.role === "system") continue;
        if (item.role === "tool") {
          toolMessages.push(item as ToolTranscriptMessage);
          continue;
        }
        if (item.role === "assistant") {
          assistantMessages.push(item);
          continue;
        }
        await renderAssistantTurn();
        if (signal.aborted || work !== transcriptWork) return;
        userTurn++;
        const key = `user:${userTurn}`;
        retained.add(key);
        const existing = turnRecords.get(key);
        if (existing?.fingerprint === item.content) { mount(existing.bubble); continue; }
        const bubble = existing?.bubble ?? transcript.createDiv({
          cls: "notient-message is-user",
          attr: { role: "article", "aria-label": "You" },
        });
        bubble.empty();
        mount(bubble);
        bubble.createDiv({ text: "You", cls: "notient-message-label" });
        const body = bubble.createDiv({ cls: "notient-message-body" });
        if (item.content) {
          copySources.set(bubble, { label: "Copy message", done: "Message copied.", text: item.content });
          await renderMarkdown(body, item.content, conversation.notePath);
        }
        turnRecords.set(key, { bubble, fingerprint: item.content });
      }
      await renderAssistantTurn();
    }
    for (const [key, record] of turnRecords) {
      if (!retained.has(key)) {
        surfaceRenderers.get(record.bubble)?.dispose();
        surfaceRenderers.delete(record.bubble);
        record.bubble.remove();
        turnRecords.delete(key);
      }
    }
    if (state.sending) appendStreaming();
    previousLiveKey = liveKey();
    if (follow || forceScroll) transcript.scrollTop = transcript.scrollHeight;
    else transcript.scrollTop = oldTop;
    const nextScrollTop = transcript.scrollTop;
    if (!waitingForConversation && (state.scrollTop !== nextScrollTop || !state.scrollPositionKnown)) {
      state.scrollTop = nextScrollTop;
      state.scrollPositionKnown = true;
      persist();
    }
    state.scrollToBottom = false;
  };

  const refresh = () => {
    refreshHistory();
    refreshContext();
    setNotice(state.notice, state.noticeError);
    const approval = state.tools.find((tool) => tool.state === "approval-pending");
    const running = state.tools.find((tool) => tool.state === "running");
    presenceSlot.hidden = false;
    const hasAnswer = !!state.conversation?.messages.some((item) => item.role === "assistant" && item.content.trim());
    const hasSurfaces = state.tools.some((tool) => tool.state === "complete" && tool.result !== undefined &&
      ["vault.search_notes", "vault.read_note", "vault.list_neighbors", "graph.find_path"].includes(tool.tool));
    const docked = hasAnswer || !!state.displayedAssistant || hasSurfaces || !!state.actionResult ||
      !!approval || state.tools.some((tool) => tool.state === "error");
    presence.layout(docked ? "dock" : "center", () => root.toggleClass("is-quiet", !docked), !firstLayout && !state.loading);
    firstLayout = false;
    presence.update(approval
      ? { state: "review", label: "Your decision is needed", detail: "A proposed action is waiting for approval." }
      : running
        ? { state: "reading", label: running.tool.includes("search") ? "Searching your notes" : "Working with your notes", detail: undefined }
        : state.sending
          ? { state: state.displayedAssistant ? "responding" : "waiting", label: state.displayedAssistant ? "Gathering the answer" : "Considering your question" }
          : state.loading
            ? { state: "waiting", label: "Opening your knowledge" }
            : state.noticeError
              ? { state: "error", label: "Needs your attention" }
              : { state: "idle", label: "" });
    stopButton.hidden = !state.sending;
    sendButton.disabled = state.loading || state.sending || !state.draft.trim();
    textarea.disabled = false;
    if (doc.activeElement !== textarea) textarea.value = state.draft;
    void renderTranscript();
    if (!initialHistoryStarted && !state.historyLoaded && !state.loading && !state.sending)
      void loadHistory();
  };

  const subscriber = () => refresh();
  state.listeners.add(subscriber);
  signal.addEventListener(
    "abort",
    () => {
      state.listeners.delete(subscriber);
      replyBuffer.dispose();
      presence.dispose();
      for (const renderer of surfaceRenderers.values()) renderer.dispose();
      surfaceRenderers.clear();
      if (scrollTimer) clearTimeout(scrollTimer);
      transcriptWork++;
    },
    { once: true },
  );

  const notify = () => {
    for (const listener of state.listeners) listener();
  };

  const updatePersistedConversation = (conversation: Conversation) => {
    state.conversation = conversation;
    state.conversationId = conversation.id;
    state.conversationPath = conversation.notePath;
    persist();
  };

  const loadHistory = async (selectPath?: string) => {
    if (state.loading || signal.aborted) return;
    initialHistoryStarted = true;
    state.loading = true;
    setNotice(null);
    notify();
    try {
      const page = await options.client.chatList(signal);
      if (signal.aborted) return;
      state.conversations = [...page.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
      state.historyLoaded = true;
      let selected = selectPath
        ? state.conversations.find((item) => item.notePath === selectPath)
        : state.conversations.find((item) => item.id === state.conversationId) ??
          state.conversations.find((item) => item.notePath === state.conversationPath);
      if (selectPath && !selected) throw new Error("That conversation is no longer in history.");
      if (!selected && !state.conversationId && !state.conversationPath) {
        state.conversation = null;
        return;
      }
      if (!selected) {
        state.conversation = null;
        state.conversationId = null;
        state.conversationPath = null;
        persist();
        throw new Error("The saved conversation could not be found. Start a new conversation or choose from history.");
      }
      if (!isCanonicalConversationPath(selected.notePath))
        throw new Error("The selected history entry is not a stored Notient conversation.");
      const loaded = await options.client.chatLoad(selected.notePath, signal);
      if (signal.aborted) return;
      if (loaded.conversation.id !== selected.id)
        throw new Error("Conversation history changed while it was loading. Select it again to refresh.");
      updatePersistedConversation(loaded.conversation);
      state.actionResult = null;
      state.tools = [];
    } catch (error) {
      if (!signal.aborted) setNotice(message(error), true);
    } finally {
      state.loading = false;
      notify();
    }
  };

  const startConversation = async () => {
    if (state.sending || state.loading || signal.aborted) return false;
    state.loading = true;
    state.notice = null;
    notify();
    try {
      const result = await options.client.chatStart({ topic: "Conversation" });
      if (signal.aborted) return;
      state.actionResult = null;
      state.tools = [];
      state.streamedAssistant = "";
      state.scrollToBottom = true;
      updatePersistedConversation(result.conversation);
      state.conversations = [summarizeConversation(result.conversation), ...state.conversations.filter((c) => c.id !== result.conversation.id)];
      setNotice("New conversation ready.");
      return true;
    } catch (error) {
      if (!signal.aborted) setNotice(message(error), true);
      return false;
    } finally {
      state.loading = false;
      notify();
    }
  };

  const attachCurrentNote = async () => {
    if (signal.aborted) return;
    try {
      const current = await options.active();
      if (!current.path || !isCanonicalOrdinaryNotePath(current.path))
        throw new Error("Open a Markdown note before attaching it.");
      if (current.dirty)
        throw new Error("Save the note first. Only the saved version can be attached to a conversation.");
      state.attachedNotePath = current.path;
      persist();
      setNotice(null);
      notify();
    } catch (error) {
      setNotice(message(error), true);
    }
  };

  const ensureAttachmentCurrent = async () => {
    if (!state.attachedNotePath) return;
    const current = await options.active();
    if (current.path === state.attachedNotePath && current.dirty)
      throw new Error("Save the attached note before sending. Unsaved editor text is not included.");
  };

  const paintReply = (element: HTMLElement) => {
    const follow = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 72;
    element.setText(state.displayedAssistant);
    if (follow) transcript.scrollTop = transcript.scrollHeight;
  };

  const submitTurn = async (rawText = state.draft) => {
    if (state.sending || state.loading || signal.aborted) return;
    let text = rawText.trim();
    if (!text) return;
    const command = parseSlashCommand(text);
    if (command) {
      if (await runSlashCommand(command.name, command.argument)) return;
      if (signal.aborted) return;
      text = command.prompt ?? text;
    }
    const originalDraft = state.draft;
    state.loading = true;
    state.notice = null;
    notify();
    try {
      await ensureAttachmentCurrent();
      if (!state.conversation) {
        const started = await options.client.chatStart({ topic: conversationTopic(text) });
        if (signal.aborted) return;
        updatePersistedConversation(started.conversation);
        state.conversations = [summarizeConversation(started.conversation), ...state.conversations.filter((c) => c.id !== started.conversation.id)];
      }
      const conversation = state.conversation;
      if (!conversation) throw new Error("The conversation could not be started.");
      const attached = state.attachedNotePath ? `@"${state.attachedNotePath}"\n` : "";
      const userMessage = `${attached}${text}`;
      const turnId = crypto.randomUUID();
      state.loading = false;
      state.sending = true;
      state.activeTurnId = turnId;
      state.streamedAssistant = "";
      state.displayedAssistant = "";
      replyBuffer.reset();
      state.tools = [];
      state.scrollToBottom = true;
      state.draft = "";
      persist();
      textarea.value = "";
      fitTextarea(textarea);
      notify();
      let accepted = false;
      let completed = false;
      try {
        for await (const frame of options.client.chatSend(
          { conversationId: conversation.id, userMessage, turnId },
          {},
        )) {
          if (frame.event === "turn:start") {
            accepted = true;
            state.scrollToBottom = true;
            const acceptedMessage = asChatMessage(frame.userMessage);
            if (acceptedMessage && state.conversation) {
              state.conversation = appendMessage(state.conversation, acceptedMessage);
              state.conversationId = frame.conversationId as string;
              state.conversationPath = state.conversation.notePath;
              persist();
            }
          } else if (frame.event === "loop:assistant_delta") {
            state.streamedAssistant += frame.contentDelta;
            replyBuffer.push(state.streamedAssistant.length > 1600 ? `${state.streamedAssistant.slice(0, 1600)}…` : state.streamedAssistant);
            continue;
          } else if (frame.event === "loop:tool_call_started") {
            upsertTool(state, {
              callId: frame.callId,
              tool: frame.tool,
              state: "running",
            });
          } else if (frame.event === "loop:tool_call_result") {
            const activity = findTool(state, frame.callId);
            if (activity) {
              activity.state = "complete";
              activity.durationMs = frame.durationMs;
              activity.result = frame.result;
            }
          } else if (frame.event === "loop:tool_call_error") {
            const activity = findTool(state, frame.callId);
            if (activity) {
              activity.state = "error";
              activity.error = frame.error;
              activity.durationMs = frame.durationMs;
            }
          } else if (frame.event === "loop:approval_pending") {
            upsertTool(state, {
              callId: frame.callId,
              tool: frame.tool,
              preview: frame.preview,
              state: "approval-pending",
            });
          } else if (frame.event === "loop:approval_resolved") {
            const activity = findTool(state, frame.callId);
            if (activity) activity.state = frame.approved === true ? "approved" : "rejected";
          } else if (frame.event === "turn:complete") {
            const completedConversation = asConversation(frame.conversation);
            if (!completedConversation)
              throw new Error("The chat service did not return a valid saved conversation.");
            finishingReply = true;
            await replyBuffer.finish();
            finishingReply = false;
            updatePersistedConversation(completedConversation);
            state.conversations = [
              summarizeConversation(completedConversation),
              ...state.conversations.filter((item) => item.id !== completedConversation.id),
            ];
            state.streamedAssistant = "";
            state.sending = false;
            state.activeTurnId = null;
            completed = true;
            announce("Notient replied. Use Copy below the answer to copy it as Markdown.");
          } else if (frame.event === "turn:aborted") {
            const reason = frame.reason || "The turn was stopped.";
            setNotice(`Turn stopped: ${reason}`, true);
          } else if (frame.event === "turn:usage") {
            state.notice = null;
          } else if (frame.event === "loop:context_summarized") {
            state.notice = "Earlier conversation context was summarized to continue this turn.";
          } else if (frame.event === "loop:context_overflow_warning") {
            state.notice = "The available context is near its configured limit; some earlier context may not fit.";
          } else if (frame.event === "loop:error") {
            setNotice(frame.message || "The assistant reported an error.", true);
          }
          notify();
        }
        if (!completed && state.conversationPath) {
          const loaded = await options.client.chatLoad(state.conversationPath);
          updatePersistedConversation(loaded.conversation);
          const lastMessage = loaded.conversation.messages.at(-1);
          if (lastMessage?.role === "user" && lastMessage.content === userMessage)
            accepted = true;
        }
        if (completed) setNotice(state.notice, state.noticeError);
        else if (accepted) {
          if (!state.draft) state.draft = originalDraft;
          persist();
          setNotice("Your message is saved in this conversation. The reply did not finish; Notient will not resend it automatically.", true);
        }
      } catch (error) {
        if (accepted && state.conversationPath) {
          try {
            const loaded = await options.client.chatLoad(state.conversationPath);
            updatePersistedConversation(loaded.conversation);
          } catch {}
        }
        if (!state.draft) state.draft = originalDraft;
        persist();
        setNotice(
          accepted
            ? `The message was saved, but the reply did not finish: ${message(error)}. It was not resent.`
            : message(error),
          true,
        );
      } finally {
        state.loading = false;
        state.sending = false;
        state.activeTurnId = null;
        state.streamedAssistant = "";
        state.displayedAssistant = "";
        replyBuffer.reset();
        if (!completed && accepted && !state.draft) state.draft = originalDraft;
        persist();
        notify();
      }
    } catch (error) {
      setNotice(message(error), true);
      if (!state.draft) state.draft = originalDraft;
      persist();
    } finally {
      state.loading = false;
      notify();
    }
  };

  async function runSlashCommand(name: string, argument: string): Promise<boolean> {
    if (name === "new") {
      const started = await startConversation();
      if (started) {
        state.draft = "";
        textarea.value = "";
        persist();
        notify();
      }
      return true;
    }
    if (name === "summarize") {
      const prompt = argument || "Summarize the attached note. Preserve the note's uncertainty and cite the exact saved source passages.";
      if (!state.attachedNotePath) {
        try {
          const current = await options.active();
          if (!current.path || !isCanonicalOrdinaryNotePath(current.path))
            throw new Error("Attach a saved note first, or open a note and use Attach current note.");
          if (current.dirty) throw new Error("Save the current note before summarizing it.");
          state.attachedNotePath = current.path;
          persist();
          refreshContext();
        } catch (error) {
          setNotice(message(error), true);
          return true;
        }
      }
      state.draft = prompt;
      textarea.value = prompt;
      persist();
      refreshContext();
      await submitTurn(prompt);
      return true;
    }
    if (name === "search") {
      if (!argument) {
        setNotice("Use /search followed by a few words to find.", true);
        return true;
      }
      await runSearch(argument);
      if (state.actionResult?.kind === "search") {
        state.draft = "";
        textarea.value = "";
        persist();
        notify();
      }
      return true;
    }
    if (name === "connections") {
      await runConnections();
      if (state.actionResult?.kind === "connections") {
        state.draft = "";
        textarea.value = "";
        persist();
        notify();
      }
      return true;
    }
    if (name === "review") {
      try {
        const page = await options.client.call("proposals.list", { limit: 50, state: "pending" }, signal);
        setNotice(`${page.proposals.length} change${page.proposals.length === 1 ? "" : "s"} awaiting review.`);
      } catch (error) {
        setNotice(`Could not refresh the review count: ${message(error)}`, true);
      }
      state.draft = "";
      textarea.value = "";
      persist();
      notify();
      options.navigate("review");
      return true;
    }
    return false;
  }

  const runSearch = async (query: string) => {
    state.loading = true;
    state.actionResult = null;
    notify();
    try {
      const result = await options.client.call(
        "search.run",
        { query, mode: "hybrid", scope: {}, limit: 8 },
        signal,
      );
      state.actionResult = {
        kind: "search",
        surfaces: projectToolSurfaces([{ callId: "local-search", status: "ok", data: result }]),
        title: `Search · ${query}`,
        status:
          result.coverage.state === "current"
            ? `${result.hits.length} saved notes · ${Math.round(result.durationMs)} ms`
            : `${result.hits.length} results · ${result.coverage.message ?? "Index coverage may be incomplete."}`,
        hits: result.hits.map((hit) => ({
          title: shortPath(hit.note.path),
          path: hit.note.path,
          detail: `${hit.freshness.state}${hit.evidence ? ` · ${hit.evidence.range.startLine}–${hit.evidence.range.endLine}` : " · no current quotation"}`,
          evidence: hit.evidence,
        })),
      };
      setNotice(null);
    } catch (error) {
      setNotice(message(error), true);
    } finally {
      state.loading = false;
      notify();
    }
  };

  const runConnections = async () => {
    let path = state.attachedNotePath;
    if (!path) {
      try {
        const current = await options.active();
        if (!current.path || !isCanonicalOrdinaryNotePath(current.path))
          throw new Error("Attach a note or open one before checking its connections.");
        if (current.dirty) throw new Error("Save the current note before checking its connections.");
        path = current.path;
      } catch (error) {
        setNotice(message(error), true);
        return;
      }
    }
    state.loading = true;
    state.actionResult = null;
    notify();
    try {
      const result = (await options.client.call(
        "graph.neighbors",
        { path, includeProposed: true, limit: 50 },
        signal,
      )) as GraphNeighbors;
      state.actionResult = {
        kind: "connections",
        surfaces: projectToolSurfaces([{ callId: "local-connections", status: "ok", data: result }]),
        title: `Connections · ${shortPath(path)}`,
        status:
          result.coverage.state !== "current"
            ? result.coverage.message ?? "Connection coverage is incomplete."
            : `${result.connections.length} connection${result.connections.length === 1 ? "" : "s"}`,
        hits: result.connections.map((edge) => ({
          title: shortPath(edge.note.path),
          path: edge.note.path,
          detail: `${edge.direction === "incoming" ? "Backlink" : "Outgoing"} · ${edge.relation.replaceAll("_", " ")}${edge.rationale ? ` · ${edge.rationale}` : ""}`,
          evidence: edge.evidence[0] ?? null,
          state: `${edge.state}${edge.evidenceState !== "current" ? ` · ${edge.evidenceState} evidence` : ""}`,
        })),
      };
      setNotice(null);
    } catch (error) {
      setNotice(message(error), true);
    } finally {
      state.loading = false;
      notify();
    }
  };

  const decideApproval = async (
    activity: ChatToolActivity,
    approved: boolean,
    approve: HTMLButtonElement,
    reject: HTMLButtonElement,
  ) => {
    approve.disabled = true;
    reject.disabled = true;
    try {
      if (approved) await options.client.chatApprove({ callId: activity.callId, approved: true });
      else
        await options.client.chatApprove({
          callId: activity.callId,
          approved: false,
          reason: "Declined in the Obsidian conversation.",
        });
      activity.state = approved ? "approved" : "rejected";
      setNotice(approved ? "Approval recorded." : "Tool call declined.");
    } catch (error) {
      approve.disabled = false;
      reject.disabled = false;
      setNotice(
        (error instanceof NotientApiError && error.code === "FORBIDDEN")
          ? "This paired Obsidian connection cannot approve agent tool calls. Review this request with an authorized human client."
          : message(error),
        true,
      );
    }
    notify();
  };

  const stopTurn = async () => {
    if (finishingReply) {
      replyBuffer.flush();
      return;
    }
    const turnId = state.activeTurnId;
    if (!turnId) return;
    stopButton.disabled = true;
    setNotice("Stopping this turn…");
    try {
      const result = await options.client.chatAbort({ turnId });
      setNotice(
        result.aborted
          ? "Stop requested. Waiting for the conversation to save its final state."
          : "This turn has already finished.",
      );
    } catch (error) {
      setNotice(`Could not stop the turn: ${message(error)}`, true);
    } finally {
      stopButton.disabled = false;
    }
  };

  const updateSlashMenu = () => {
    const value = textarea.value;
    const match = /^\/(\S*)$/.exec(value.trim());
    const query = match?.[1]?.toLowerCase() ?? "";
    const available = match ? slashCommands.filter((item) => item.command.slice(1).startsWith(query)) : [];
    slashMenu.empty();
    if (!available.length) {
      slashMenu.hide();
      commandSelection = -1;
      return;
    }
    slashMenu.show();
    setShortcutsOpen(false);
    available.forEach((item, index) => {
      const button = slashMenu.createEl("button", {
        cls: "notient-slash-option",
        attr: { type: "button", role: "option", tabindex: "-1", "aria-selected": String(index === commandSelection) },
      });
      button.createSpan({ text: item.command });
      button.createSpan({ text: item.detail, cls: "notient-muted" });
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        state.draft = item.command === "/search" ? "/search " : `${item.command} `;
        textarea.value = state.draft;
        persist();
        slashMenu.hide();
        textarea.focus();
        fitTextarea(textarea);
      });
    });
  };

  const resizeInput = () => fitTextarea(textarea);

  history.addEventListener("change", () => {
    const selected = state.conversations.find((item) => item.id === history.value);
    if (selected) void loadHistory(selected.notePath);
  });
  newConversation.addEventListener("click", () => void startConversation());
  attachButton.addEventListener("click", () => void attachCurrentNote());
  stopButton.addEventListener("click", () => void stopTurn());
  textarea.addEventListener("input", () => {
    state.draft = textarea.value.slice(0, 8192);
    commandSelection = -1;
    persist();
    fitTextarea(textarea);
    updateSlashMenu();
    sendButton.disabled = state.loading || state.sending || !state.draft.trim();
  });
  textarea.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (slashMenu.isShown()) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const buttons = [...slashMenu.querySelectorAll<HTMLButtonElement>("button")];
        if (!buttons.length) return;
        commandSelection = (commandSelection + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons.forEach((button, index) => button.setAttribute("aria-selected", String(index === commandSelection)));
        buttons[commandSelection]?.scrollIntoView({ block: "nearest" });
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        slashMenu.hide();
        commandSelection = -1;
        return;
      }
      if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        const buttons = slashMenu.querySelectorAll<HTMLButtonElement>("button");
        buttons[Math.max(commandSelection, 0)]?.click();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && commandSelection >= 0) {
        event.preventDefault();
        const button = slashMenu.querySelectorAll<HTMLButtonElement>("button")[commandSelection];
        button?.click();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });
  composer.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || shortcuts.hidden || event.isComposing) return;
    event.preventDefault();
    const inside = shortcuts.contains(doc.activeElement);
    setShortcutsOpen(false);
    if (inside) shortcutsToggle.focus();
  });
  shortcutsToggle.addEventListener("click", () => setShortcutsOpen(shortcuts.hidden));
  doc.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target as Node | null;
      if (!shortcuts.hidden && target && !shortcuts.contains(target) && !shortcutsToggle.contains(target))
        setShortcutsOpen(false);
    },
    { capture: true, signal },
  );

  transcript.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.("textarea, input, select, [contenteditable]")) return;
    const modifier = Platform.isMacOS ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (!modifier || event.altKey || event.shiftKey || event.key.toLowerCase() !== "a") return;
    event.preventDefault();
    const focusedMessage =
      target && target !== transcript
        ? target.closest(".notient-message")?.querySelector<HTMLElement>(".notient-message-body")
        : null;
    selectContents(focusedMessage ?? transcript);
  });

  transcript.addEventListener("contextmenu", (event) => {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (!target?.closest || target.closest("textarea, input, select")) return;
    const selected = transcriptSelection();
    const entries: Array<{ label: string; done: string; text: string }> = [];
    for (let element: Element | null = target; element && element !== transcript; element = element.parentElement) {
      const entry = copySources.get(element);
      if (entry) entries.push(entry);
    }
    const body = target.closest(".notient-message")?.querySelector<HTMLElement>(".notient-message-body");
    const menu = new Menu();
    if (selected)
      menu.addItem((item) =>
        item.setTitle("Copy").setIcon("copy").onClick(() => void copyWithFeedback(selected, "Selection copied.", null, true)),
      );
    for (const entry of entries)
      menu.addItem((item) =>
        item
          .setTitle(entry.label)
          .setIcon("clipboard-copy")
          .onClick(() => void copyWithFeedback(entry.text, entry.done, null, true)),
      );
    if (body?.textContent?.trim())
      menu.addItem((item) => item.setTitle("Select message text").setIcon("text-cursor").onClick(() => selectContents(body)));
    if (transcript.querySelector(".notient-message"))
      menu.addItem((item) =>
        item.setTitle("Select entire conversation").setIcon("text-cursor").onClick(() => selectContents(transcript)),
      );
    if (!selected && !entries.length && !body && !transcript.querySelector(".notient-message")) return;
    event.preventDefault();
    if (event.clientX === 0 && event.clientY === 0) {
      const rect = target.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left + 12, y: rect.top + 12 }, doc);
    } else menu.showAtMouseEvent(event);
  });

  const copyLatestAnswer = async () => {
    const latest = state.conversation
      ? assistantTurns(state.conversation).reverse().find((turn) => turn.text.trim())
      : undefined;
    if (!latest) {
      const text = "There is no completed answer to copy yet.";
      new Notice(text);
      announce(text);
      return;
    }
    const button =
      [...transcript.querySelectorAll<HTMLElement>(".notient-copy[data-reply-id]")].find(
        (item) => item.dataset.replyId === latest.id,
      ) ?? null;
    await copyWithFeedback(latest.text, "Latest answer copied as Markdown.", button, true);
  };
  const workspace = parent.closest<HTMLElement>(".notient-workspace") ?? parent;
  workspace.addEventListener("notient:copy-last-answer", () => void copyLatestAnswer(), { signal });
  workspace.addEventListener(
    "notient:focus-composer",
    () => {
      textarea.focus();
      textarea.scrollIntoView({ block: "nearest" });
    },
    { signal },
  );
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.draft.trim()) void submitTurn();
  });

  textarea.value = state.draft;
  fitTextarea(textarea);
  refresh();
}

export async function copyToClipboard(doc: Document, text: string): Promise<void> {
  const clipboard = (doc.defaultView ?? window).navigator.clipboard;
  let failure: unknown = null;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return;
    } catch (error) {
      failure = error;
    }
  }
  const selection = doc.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
    : [];
  const active = doc.activeElement as HTMLElement | null;
  const area = doc.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";
  doc.body.append(area);
  let copied = false;
  try {
    area.select();
    copied = doc.execCommand("copy");
  } catch (error) {
    failure ??= error;
  } finally {
    area.remove();
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
    active?.focus?.({ preventScroll: true });
  }
  if (!copied)
    throw new Error(failure ? message(failure) : "the clipboard did not accept the text");
}

function answerText(messages: ChatMessage[]): string {
  return messages.map((item) => item.content).filter((content) => content.length > 0).join("\n\n");
}

function assistantTurns(conversation: Conversation): Array<{ id: string; text: string }> {
  const turns: Array<{ id: string; text: string }> = [];
  let group: ChatMessage[] = [];
  const close = () => {
    if (!group.length) return;
    const text = answerText(group);
    turns.push({ id: group.at(-1)?.id ?? text, text });
    group = [];
  };
  for (const item of conversation.messages) {
    if (item.role === "assistant") group.push(item);
    else if (item.role === "user") close();
  }
  close();
  return turns;
}

function cleanStoredText(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}

function cleanPath(value: unknown): string | null {
  return typeof value === "string" && isCanonicalOrdinaryNotePath(value) ? value : null;
}

function cleanConversationPath(value: unknown): string | null {
  return typeof value === "string" && isCanonicalConversationPath(value) ? value : null;
}

function shortPath(path: string): string {
  return (path.replace(/\.md$/i, "").split("/").pop() ?? path).replace(/[-_]+/g, " ");
}

function bindInternalNoteLinks(
  container: HTMLElement,
  openNote: ((path: string) => Promise<void>) | undefined,
  report: (text: string) => void,
): void {
  if (!openNote) return;
  for (const anchor of container.querySelectorAll<HTMLAnchorElement>("a.internal-link, a[data-href]")) {
    if (anchor.dataset.notientBound === "true") continue;
    anchor.dataset.notientBound = "true";
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      const raw = anchor.dataset.href ?? anchor.getAttribute("href") ?? "";
      const path = raw.split("|")[0]?.split("#")[0]?.trim() ?? "";
      if (!isCanonicalOrdinaryNotePath(path)) {
        report("This link is not an ordinary Markdown note path.");
        return;
      }
      void openNote(path).catch((error) => report(message(error)));
    });
  }
}

function fitTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
}

function parseSlashCommand(value: string): { name: string; argument: string; prompt?: string } | null {
  const match = /^\/(new|summarize|connections|search|review)(?:\s+([\s\S]*))?$/i.exec(value);
  if (!match) return null;
  return { name: match[1].toLowerCase(), argument: (match[2] ?? "").trim() };
}

function conversationTopic(value: string): string {
  const topic = value.replace(/\s+/g, " ").trim().slice(0, 200).trim();
  return topic || "Conversation";
}

function asChatMessage(value: unknown): ChatMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as ChatMessage;
  return ["user", "assistant", "system", "tool"].includes(candidate.role) ? candidate : null;
}

function asConversation(value: unknown): Conversation | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Conversation;
  return typeof candidate.id === "string" &&
    isCanonicalConversationPath(candidate.notePath) &&
    Array.isArray(candidate.messages)
    ? candidate
    : null;
}

function appendMessage(conversation: Conversation, message: ChatMessage): Conversation {
  if (conversation.messages.some((item) => item.id === message.id)) return conversation;
  return {
    ...conversation,
    messages: [...conversation.messages, message],
    messageCount: Math.max(conversation.messageCount + 1, conversation.messages.length + 1),
    updatedAt: message.createdAt,
  };
}

function upsertTool(state: ChatPanelState, activity: ChatToolActivity): void {
  const index = state.tools.findIndex((item) => item.callId === activity.callId);
  if (index < 0) state.tools.push(activity);
  else state.tools[index] = { ...state.tools[index], ...activity };
}

function findTool(state: ChatPanelState, callId: string): ChatToolActivity | undefined {
  return state.tools.find((item) => item.callId === callId);
}

function liveToolState(state: ChatToolActivity["state"]): string {
  switch (state) {
    case "running":
      return "Running";
    case "complete":
      return "Complete";
    case "error":
      return "Failed";
    case "approval-pending":
      return "Waiting for human review";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
  }
}

function collectSourceReferences(value: unknown, depth = 0, found: SourceReference[] = []): SourceReference[] {
  if (depth > 8 || found.length >= 50) return found;
  if (typeof value === "string") {
    try {
      return collectSourceReferences(JSON.parse(value), depth + 1, found);
    } catch {
      return found;
    }
  }
  const parsed = sourceReferenceSchema.safeParse(value);
  if (parsed.success) {
    found.push(parsed.data);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSourceReferences(item, depth + 1, found);
    return found;
  }
  if (typeof value === "object" && value !== null)
    for (const item of Object.values(value)) collectSourceReferences(item, depth + 1, found);
  return found;
}
