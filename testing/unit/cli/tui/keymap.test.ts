import { describe, expect, test } from "bun:test";
import { type KeyPress, keyHints, resolveKey } from "../../../../src/cli/tui/keymap";
import {
  type Action,
  type AppState,
  VIEW_IDS,
  type ViewId,
  initialState,
  reducer,
} from "../../../../src/cli/tui/store";

function stateFor(view: ViewId, extra: Action[] = []): AppState {
  return [{ type: "view/set", view } as Action, ...extra].reduce(
    reducer,
    initialState("/tmp/vault"),
  );
}

function press(name: string, modifiers: Partial<KeyPress> = {}): KeyPress {
  return { name, ...modifiers };
}

describe("global bindings", () => {
  test("Escape stops a busy turn while an open picker still owns Escape", () => {
    const busy = stateFor("ask", [{ type: "ask/busy", busy: true }]);
    expect(resolveKey(busy, press("escape"))).toEqual({ kind: "cancel-turn" });
    expect(keyHints(busy)[0]).toEqual({ keys: "Esc", label: "stop turn" });
    const picker = reducer(busy, { type: "prompt/open", kind: "navigation" });
    expect(resolveKey(picker, press("escape"))).toEqual({ kind: "prompt-cancel" });
  });
  test("Ctrl+C quits from every view, even mid-composition", () => {
    for (const view of ["home", "inbox", "ask", "explore", "stream"] as ViewId[]) {
      expect(resolveKey(stateFor(view), press("c", { ctrl: true }))).toEqual({ kind: "quit" });
    }
  });

  test("digits 1-5 select a view", () => {
    expect(resolveKey(stateFor("home"), press("2"))).toEqual({ kind: "view", view: "inbox" });
    expect(resolveKey(stateFor("home"), press("5"))).toEqual({ kind: "view", view: "stream" });
  });

  test("a digit outside 1-5 is not a view key", () => {
    expect(resolveKey(stateFor("home"), press("7"))).toBeNull();
  });

  test("Tab cycles forwards and Shift+Tab backwards", () => {
    expect(resolveKey(stateFor("home"), press("tab"))).toEqual({ kind: "view-cycle", delta: 1 });
    expect(resolveKey(stateFor("home"), press("tab", { shift: true }))).toEqual({
      kind: "view-cycle",
      delta: -1,
    });
  });

  test("colon opens the command line", () => {
    expect(resolveKey(stateFor("home"), press(":"))).toEqual({
      kind: "prompt-open",
      prompt: "command",
    });
    expect(resolveKey(stateFor("stream"), press("unknown", { sequence: ":" }))).toEqual({
      kind: "prompt-open",
      prompt: "command",
    });
  });

  test("j/k move in navigate mode", () => {
    expect(resolveKey(stateFor("inbox"), press("j"))).toEqual({ kind: "move", delta: 1 });
    expect(resolveKey(stateFor("inbox"), press("k"))).toEqual({ kind: "move", delta: -1 });
  });
});

describe("disconnected state", () => {
  const offline = stateFor("home", [{ type: "conn/lost", reason: "socket closed" }]);

  test("any key reconnects while the daemon is gone", () => {
    expect(resolveKey(offline, press("j"))).toEqual({ kind: "reconnect" });
    expect(resolveKey(offline, press("2"))).toEqual({ kind: "reconnect" });
  });

  test("Ctrl+C still quits rather than reconnecting", () => {
    expect(resolveKey(offline, press("c", { ctrl: true }))).toEqual({ kind: "quit" });
  });

  test("no second reconnect fires while one is already in flight", () => {
    const reconnecting = reducer(offline, { type: "conn/reconnecting" });
    expect(resolveKey(reconnecting, press("j"))).not.toEqual({ kind: "reconnect" });
  });
});

describe("Inbox bindings", () => {
  const inbox = stateFor("inbox");

  test("a approves, r rejects, Shift+A approves the whole note", () => {
    expect(resolveKey(inbox, press("a"))).toEqual({ kind: "approve" });
    expect(resolveKey(inbox, press("r"))).toEqual({ kind: "reject" });
    expect(resolveKey(inbox, press("a", { shift: true }))).toEqual({ kind: "approve-group" });
  });

  test("o and Enter open the selected row in Explore", () => {
    expect(resolveKey(inbox, press("o"))).toEqual({ kind: "open-in-explore" });
    expect(resolveKey(inbox, press("return"))).toEqual({ kind: "open-in-explore" });
  });

  test("slash opens the filter prompt", () => {
    expect(resolveKey(inbox, press("/"))).toEqual({ kind: "prompt-open", prompt: "filter" });
  });

  test("auto-repeat does not approve or reject, so holding a cannot drain the queue", () => {
    expect(resolveKey(inbox, press("a", { repeat: true }))).toBeNull();
    expect(resolveKey(inbox, press("r", { repeat: true }))).toBeNull();
    expect(resolveKey(inbox, press("a", { shift: true, repeat: true }))).toBeNull();
  });

  test("auto-repeat still moves the cursor and switches views", () => {
    expect(resolveKey(inbox, press("j", { repeat: true }))).toEqual({ kind: "move", delta: 1 });
    expect(resolveKey(inbox, press("2", { repeat: true }))).toEqual({
      kind: "view",
      view: "inbox",
    });
  });
});

describe("Home bindings", () => {
  const home = stateFor("home");

  test("awaken control keys map to their verbs", () => {
    expect(resolveKey(home, press("w"))).toEqual({ kind: "awaken", verb: "run" });
    expect(resolveKey(home, press("p"))).toEqual({ kind: "awaken", verb: "pause" });
    expect(resolveKey(home, press("u"))).toEqual({ kind: "awaken", verb: "resume" });
    expect(resolveKey(home, press("x"))).toEqual({ kind: "awaken", verb: "cancel" });
  });

  test("r refreshes", () => {
    expect(resolveKey(home, press("r"))).toEqual({ kind: "refresh" });
  });
});

describe("Explore bindings", () => {
  const explore = stateFor("explore");

  test("o opens the note picker", () => {
    expect(resolveKey(explore, press("o"))).toEqual({
      kind: "prompt-open",
      prompt: "note-picker",
    });
  });

  test("h/l and the arrows switch column", () => {
    expect(resolveKey(explore, press("h"))).toEqual({ kind: "pane", delta: -1 });
    expect(resolveKey(explore, press("right"))).toEqual({ kind: "pane", delta: 1 });
  });

  test("Enter jumps to the selected neighbour", () => {
    expect(resolveKey(explore, press("return"))).toEqual({ kind: "open-in-explore" });
  });
});

describe("Ask composer mode", () => {
  const composing = stateFor("ask");

  test("printable keys reach the composer, not the app", () => {
    expect(resolveKey(composing, press("a"))).toBeNull();
    expect(resolveKey(composing, press("2"))).toBeNull();
    expect(resolveKey(composing, press("tab"))).toBeNull();
  });

  test("Esc hands the keyboard back to navigation", () => {
    expect(resolveKey(composing, press("escape"))).toEqual({ kind: "blur" });
  });

  test("PgUp/PgDn still scroll the transcript while composing", () => {
    expect(resolveKey(composing, press("pageup"))).toEqual({ kind: "scroll", delta: -10 });
    expect(resolveKey(composing, press("pagedown"))).toEqual({ kind: "scroll", delta: 10 });
  });

  test("after Esc the navigation keys are live again", () => {
    const navigating = reducer(composing, { type: "ask/composer", mode: "navigation" });
    expect(resolveKey(navigating, press("2"))).toEqual({ kind: "view", view: "inbox" });
    expect(resolveKey(navigating, press("i"))).toEqual({ kind: "compose" });
    expect(resolveKey(navigating, press("o"))).toEqual({ kind: "open-in-explore" });
  });
});

describe("Ask input after a completed answer", () => {
  const completed = stateFor("ask", [{ type: "ask/turnDone", tokens: 12, citations: ["a.md"] }]);
  test("numbers and punctuation start a message instead of unexpectedly switching views", () => {
    expect(completed.ask.composerMode).toBe("editing");
    for (const key of ["1", "2", "3", "4", "5", ":", "tab"])
      expect(resolveKey(completed, press(key))).toBeNull();
  });
  test("navigation is explicit and the menu works while composing", () => {
    expect(resolveKey(completed, press("escape"))).toEqual({ kind: "blur" });
    expect(resolveKey(completed, press("p", { ctrl: true }))).toEqual({ kind: "navigation" });
    expect(resolveKey(completed, press("t", { ctrl: true }))).toEqual({ kind: "toggle-activity" });
  });
});

describe("Stream bindings", () => {
  const stream = stateFor("stream");

  test("j/k and arrow keys scroll the visible event list", () => {
    expect(resolveKey(stream, press("j"))).toEqual({ kind: "move", delta: 1 });
    expect(resolveKey(stream, press("k"))).toEqual({ kind: "move", delta: -1 });
    expect(resolveKey(stream, press("down"))).toEqual({ kind: "move", delta: 1 });
    expect(resolveKey(stream, press("up"))).toEqual({ kind: "move", delta: -1 });
  });
});

describe("prompt mode", () => {
  const prompt = stateFor("inbox", [{ type: "prompt/open", kind: "inbox-filter" }]);

  test("printable keys belong to the prompt", () => {
    expect(resolveKey(prompt, press("a"))).toBeNull();
    expect(resolveKey(prompt, press("3"))).toBeNull();
  });

  test("Enter submits and Esc cancels", () => {
    expect(resolveKey(prompt, press("return"))).toEqual({ kind: "prompt-submit" });
    expect(resolveKey(prompt, press("escape"))).toEqual({ kind: "prompt-cancel" });
  });

  test("arrows move through the candidate list", () => {
    expect(resolveKey(prompt, press("up"))).toEqual({ kind: "prompt-move", delta: -1 });
    expect(resolveKey(prompt, press("down"))).toEqual({ kind: "prompt-move", delta: 1 });
  });
});

describe("keyHints", () => {
  test("each view advertises its own keys plus the global ones", () => {
    const inbox = keyHints(stateFor("inbox"));
    expect(inbox.map((hint) => hint.keys)).toContain("a/r");
    expect(inbox.map((hint) => hint.keys)).toContain("Ctrl+P");
  });

  test("an open prompt advertises only run and cancel", () => {
    const hints = keyHints(stateFor("inbox", [{ type: "prompt/open", kind: "inbox-filter" }]));
    expect(hints.map((hint) => hint.label)).toEqual(["open", "cancel"]);
  });

  test("the note picker adds a candidate hint", () => {
    const hints = keyHints(stateFor("explore", [{ type: "prompt/open", kind: "note-picker" }]));
    expect(hints.map((hint) => hint.label)).toEqual(["open", "cancel", "candidate"]);
  });

  test("the Ask composer advertises Esc rather than the letter keys", () => {
    const hints = keyHints(stateFor("ask"));
    expect(hints.map((hint) => hint.label)).toContain("navigate");
    expect(hints.map((hint) => hint.keys)).not.toContain("1-5/Tab");
  });

  test("a completed turn keeps the menu discoverable", () => {
    const state = stateFor("ask", [{ type: "ask/turnDone", tokens: 1, citations: [] }]);
    expect(keyHints(state).map((hint) => hint.keys)).toContain("Ctrl+P");
  });
});
