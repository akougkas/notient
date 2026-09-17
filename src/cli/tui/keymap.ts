/**
 * The keyboard contract.
 *
 * `resolveKey` is a pure function from (state, keypress) to an intent name.
 * The runtime is the only thing that knows how to execute an intent; the
 * mapping itself is data, so the bottom-bar hints and the bindings can never
 * drift apart — `keyHints` reads the same table.
 *
 * Two modes, decided by `isTyping(state)`:
 *   - typing: the open prompt or the Ask composer owns every printable key,
 *     and only Esc / Enter / Ctrl-chords reach the app.
 *   - navigating: single letters are commands.
 */

import type { AppState } from "./store";
import { VIEW_IDS, isTyping } from "./store";

export interface KeyPress {
  readonly name: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
  /** The character the terminal delivered, when it is a printable key. */
  readonly sequence?: string;
  /** True when the terminal auto-repeated a held key rather than a fresh press. */
  readonly repeat?: boolean;
}

export type Intent =
  | { readonly kind: "brief" }
  | { readonly kind: "analysis"; readonly mode: "compare" | "correlate" }
  | { readonly kind: "settings" }
  | { readonly kind: "history" }
  | { readonly kind: "cancel-turn" }
  | { readonly kind: "capture" }
  | { readonly kind: "edit-note" }
  | { readonly kind: "save-answer" }
  | { readonly kind: "navigation" }
  | { readonly kind: "toggle-activity" }
  | { readonly kind: "toggle-source" }
  | { readonly kind: "full-note" }
  | { readonly kind: "conversations" }
  | { readonly kind: "new-conversation" }
  | { readonly kind: "quit" }
  | { readonly kind: "reconnect" }
  | { readonly kind: "view"; readonly view: (typeof VIEW_IDS)[number] }
  | { readonly kind: "view-cycle"; readonly delta: number }
  | { readonly kind: "prompt-open"; readonly prompt: "command" | "filter" | "note-picker" }
  | { readonly kind: "prompt-cancel" }
  | { readonly kind: "prompt-submit" }
  | { readonly kind: "prompt-move"; readonly delta: number }
  | { readonly kind: "move"; readonly delta: number }
  | { readonly kind: "scroll"; readonly delta: number }
  | { readonly kind: "approve" }
  | { readonly kind: "reject" }
  | { readonly kind: "approve-group" }
  | { readonly kind: "open-in-explore" }
  | { readonly kind: "refresh" }
  | { readonly kind: "pane"; readonly delta: number }
  | { readonly kind: "compose" }
  | { readonly kind: "blur" }
  | { readonly kind: "awaken"; readonly verb: "run" | "pause" | "resume" | "cancel" };

/** One row of the bottom hint bar. */
export interface KeyHint {
  readonly keys: string;
  readonly label: string;
}

const GLOBAL_HINTS: KeyHint[] = [
  { keys: "Ctrl+P", label: "menu" },
  { keys: "Ctrl+O", label: "threads" },
];

const VIEW_HINTS: Record<AppState["view"], KeyHint[]> = {
  home: [
    { keys: "r", label: "refresh" },
    { keys: "w", label: "awaken" },
    { keys: "p/u", label: "pause/resume" },
    { keys: "x", label: "cancel run" },
  ],
  inbox: [
    { keys: "j/k", label: "move" },
    { keys: "a/r", label: "approve/reject" },
    { keys: "A", label: "approve note" },
    { keys: "o", label: "open" },
    { keys: "/", label: "filter" },
  ],
  ask: [
    { keys: "Enter", label: "send" },
    { keys: "Ctrl+P", label: "menu" },
    { keys: "Ctrl+B", label: "capture" },
    { keys: "Ctrl+S", label: "save answer" },
    { keys: "Esc", label: "navigate" },
  ],
  explore: [
    { keys: "Esc", label: "chat" },
    { keys: "o", label: "find note" },
    { keys: "e", label: "edit" },
    { keys: "r", label: "source/preview" },
    { keys: "Ctrl+R", label: "refresh" },
  ],
  stream: [
    { keys: "/", label: "filter" },
    { keys: "j/k", label: "scroll" },
    { keys: "r", label: "refresh" },
  ],
};

export function keyHints(state: AppState): KeyHint[] {
  if (state.prompt.kind !== null) {
    return [
      { keys: "Enter", label: "open" },
      { keys: "Esc", label: "cancel" },
      ...(["note-picker", "conversation-picker", "navigation"].includes(state.prompt.kind)
        ? [{ keys: "Up/Dn", label: "candidate" }]
        : []),
    ];
  }
  if (state.view === "ask" && state.ask.busy)
    return [
      { keys: "Esc", label: "stop turn" },
      { keys: "Ctrl+T", label: "activity" },
      { keys: "Ctrl+B", label: "capture" },
    ];
  if (state.view === "ask" && state.ask.composerMode === "editing") {
    return VIEW_HINTS.ask;
  }
  if (state.view === "ask" && state.ask.composerMode === "navigation") {
    return [
      { keys: "i", label: "write" },
      { keys: "o", label: "source" },
      { keys: "j/k", label: "select" },
      ...GLOBAL_HINTS,
    ];
  }
  return [...VIEW_HINTS[state.view], ...GLOBAL_HINTS];
}

function digitView(name: string): (typeof VIEW_IDS)[number] | null {
  const index = Number(name);
  if (!Number.isInteger(index) || index < 1 || index > VIEW_IDS.length) return null;
  return VIEW_IDS[index - 1] ?? null;
}

/**
 * Keys that stay live regardless of mode: quitting, and — while the daemon
 * is gone — any key at all, because the visible disconnected state tells the
 * operator that a keypress reconnects.
 */
function resolveAlwaysOn(state: AppState, key: KeyPress): Intent | null {
  if (
    state.view === "explore" &&
    state.prompt.kind === null &&
    key.ctrl === true &&
    key.name === "r" &&
    !key.repeat
  )
    return { kind: "refresh" };
  if (state.view === "ask" && state.ask.busy && state.prompt.kind === null && key.name === "escape")
    return key.repeat ? null : { kind: "cancel-turn" };
  if (key.ctrl === true && !key.repeat && key.name === "b") return { kind: "capture" };
  if (key.ctrl === true && !key.repeat && key.name === "s" && state.view === "ask")
    return { kind: "save-answer" };
  if (key.ctrl === true && key.name === "c") return { kind: "quit" };
  if (!state.connection.connected && !state.connection.reconnecting) return { kind: "reconnect" };
  if (key.ctrl === true && !key.repeat && key.name === "p") return { kind: "navigation" };
  if (key.ctrl === true && !key.repeat && key.name === "t" && state.view === "ask")
    return { kind: "toggle-activity" };
  if (key.ctrl === true && !key.repeat && key.name === "o") return { kind: "conversations" };
  if (key.ctrl === true && !key.repeat && key.name === "n") return { kind: "new-conversation" };
  return null;
}

function resolveTyping(state: AppState, key: KeyPress): Intent | null {
  if (state.prompt.kind !== null) {
    if (key.name === "escape") return { kind: "prompt-cancel" };
    if (key.name === "return" && key.shift !== true) return { kind: "prompt-submit" };
    if (key.name === "up") return { kind: "prompt-move", delta: -1 };
    if (key.name === "down") return { kind: "prompt-move", delta: 1 };
    return null;
  }
  // Ask composer.
  if (key.name === "escape") return { kind: "blur" };
  if (key.name === "pageup") return { kind: "scroll", delta: -10 };
  if (key.name === "pagedown") return { kind: "scroll", delta: 10 };
  return null;
}

type ViewResolver = (key: KeyPress) => Intent | null;

const VIEW_KEYS: Record<AppState["view"], ViewResolver> = {
  home: (key) => {
    if (key.name === "r") return { kind: "refresh" };
    if (key.name === "w") return { kind: "awaken", verb: "run" };
    if (key.name === "p") return { kind: "awaken", verb: "pause" };
    if (key.name === "u") return { kind: "awaken", verb: "resume" };
    if (key.name === "x") return { kind: "awaken", verb: "cancel" };
    return null;
  },
  inbox: (key) => {
    if (key.name === "a" && key.shift === true) return { kind: "approve-group" };
    if (key.name === "a") return { kind: "approve" };
    if (key.name === "r") return { kind: "reject" };
    if (key.name === "o" || key.name === "return") return { kind: "open-in-explore" };
    if (isSlash(key)) return { kind: "prompt-open", prompt: "filter" };
    return null;
  },
  ask: (key) => {
    if (key.name === "i" || key.name === "return") return { kind: "compose" };
    if (key.name === "o") return { kind: "open-in-explore" };
    return null;
  },
  explore: (key) => {
    if (key.name === "f") return { kind: "full-note" };
    if (key.name === "e") return { kind: "edit-note" };
    if (key.name === "escape") return { kind: "view", view: "ask" };
    if (key.name === "r") return { kind: "toggle-source" };
    if (key.name === "o") return { kind: "prompt-open", prompt: "note-picker" };
    if (key.name === "h" || key.name === "left") return { kind: "pane", delta: -1 };
    if (key.name === "l" || key.name === "right") return { kind: "pane", delta: 1 };
    if (key.name === "return") return { kind: "open-in-explore" };
    return null;
  },
  stream: (key) => {
    if (isSlash(key)) return { kind: "prompt-open", prompt: "filter" };
    if (key.name === "r") return { kind: "refresh" };
    return null;
  },
};

function isSlash(key: KeyPress): boolean {
  return key.name === "/" || key.sequence === "/";
}

/** Bindings that mean the same thing in every view. */
function resolveShared(key: KeyPress): Intent | null {
  const digit = digitView(key.name);
  if (digit !== null) return { kind: "view", view: digit };
  if (key.name === "tab") return { kind: "view-cycle", delta: key.shift === true ? -1 : 1 };
  if (key.name === ":" || key.sequence === ":") return { kind: "prompt-open", prompt: "command" };
  if (key.name === "j" || key.name === "down") return { kind: "move", delta: 1 };
  if (key.name === "k" || key.name === "up") return { kind: "move", delta: -1 };
  if (key.name === "pageup") return { kind: "scroll", delta: -10 };
  if (key.name === "pagedown") return { kind: "scroll", delta: 10 };
  return null;
}

function resolveNavigating(state: AppState, key: KeyPress): Intent | null {
  if (key.ctrl === true || key.meta === true) return null;
  return resolveShared(key) ?? VIEW_KEYS[state.view](key);
}

/**
 * Intents that commit a decision and must come from a deliberate press.
 *
 * The Inbox advances the cursor to the next entry after a decision, so an
 * auto-repeating `a` would walk the whole pending queue and approve it while
 * the operator merely held the key down. Repeats stay live for navigation and
 * view switching, where repeating is the point.
 */
const PRESS_ONLY_INTENTS: ReadonlySet<Intent["kind"]> = new Set([
  "approve",
  "reject",
  "approve-group",
]);

export function resolveKey(state: AppState, key: KeyPress): Intent | null {
  const always = resolveAlwaysOn(state, key);
  if (always !== null) return always;
  const intent = isTyping(state) ? resolveTyping(state, key) : resolveNavigating(state, key);
  if (intent !== null && key.repeat === true && PRESS_ONLY_INTENTS.has(intent.kind)) return null;
  return intent;
}
