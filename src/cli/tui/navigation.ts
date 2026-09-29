import type { Intent } from "./keymap";

export interface NavigationAction {
  readonly label: string;
  readonly intent: Intent;
  readonly keys?: string;
  readonly slash?: string;
}

export const NAVIGATION_ACTIONS: ReadonlyArray<NavigationAction> = [
  {
    label: "Vault intelligence — findings and background work",
    intent: { kind: "intelligence" },
    slash: "developments",
  },
  {
    label: "Discuss this note — bring it into your conversation",
    intent: { kind: "discuss-note" },
    keys: "a in Notes",
    slash: "discuss",
  },
  {
    label: "Capture a thought — write or resume your draft",
    intent: { kind: "capture" },
    keys: "Ctrl+B or Alt+C",
    slash: "capture",
  },
  {
    label: "Save this answer as a note — preview is optional",
    intent: { kind: "save-answer" },
    keys: "Ctrl+S or Alt+S",
    slash: "save",
  },
  {
    label: "Keep this answer on the open note — review the addition first",
    intent: { kind: "keep-answer" },
    slash: "keep",
  },
  {
    label: "Edit the open note — review before saving",
    intent: { kind: "edit-note" },
    keys: "e in Notes",
    slash: "edit",
  },
  {
    label: "Delete the open note — review, then move it to Trash",
    intent: { kind: "delete-note" },
    keys: "Ctrl+D in editor",
    slash: "delete",
  },
  {
    label: "Chat — return to your conversation",
    intent: { kind: "view", view: "ask" },
    keys: "Esc in Notes",
    slash: "chat",
  },
  {
    label: "Find a note — search names and saved text",
    intent: { kind: "prompt-open", prompt: "note-picker" },
    keys: "Alt+O",
    slash: "find",
  },
  {
    label: "Conversations — continue a saved thread",
    intent: { kind: "conversations" },
    keys: "Ctrl+O",
    slash: "threads",
  },
  {
    label: "New conversation — start a fresh thread",
    intent: { kind: "new-conversation" },
    keys: "Ctrl+N",
    slash: "new",
  },
  {
    label: "Review changes — proposals and approvals",
    intent: { kind: "view", view: "inbox" },
    slash: "review",
  },
  {
    label: "Compare notes — understand their differences",
    intent: { kind: "analysis", mode: "compare" },
    slash: "compare",
  },
  {
    label: "Find connections — explore one note’s ideas",
    intent: { kind: "analysis", mode: "correlate" },
    slash: "connections",
  },
  {
    label: "Methodology suggestions — study organization and recurring conventions",
    intent: { kind: "methodology" },
    slash: "methodology",
  },
  {
    label: "Brief me — get up to speed with source evidence",
    intent: { kind: "brief" },
    slash: "brief",
  },
  {
    label: "Change history — inspect earlier versions and undo",
    intent: { kind: "history" },
    slash: "changes",
  },
  {
    label: "Vault status — indexing and connections",
    intent: { kind: "view", view: "home" },
    slash: "status",
  },
  {
    label: "Pause cultivation — stop background work now",
    intent: { kind: "pause-background", paused: true },
    slash: "pause",
  },
  {
    label: "Resume cultivation — continue within your scope and budget",
    intent: { kind: "pause-background", paused: false },
    slash: "unpause",
  },
  {
    label: "Preferences — background work, scope and resources",
    intent: { kind: "settings" },
    slash: "preferences",
  },
  {
    label: "Activity — see what happened",
    intent: { kind: "view", view: "stream" },
    slash: "activity",
  },
  {
    label: "Help — every action and its keys",
    intent: { kind: "help" },
    slash: "help",
  },
  {
    label: "Command — run a slash command",
    intent: { kind: "prompt-open", prompt: "command" },
    keys: ":",
  },
];

const ACTIONS = NAVIGATION_ACTIONS;

/**
 * A name match outranks a description match, and a name that starts with the
 * query comes first: "review" opens Review changes, not an action whose
 * description merely mentions reviewing. Menu order breaks ties.
 */
export function navigationMatches(query: string) {
  const text = query.toLowerCase().trim();
  const terms = text.split(/\s+/);
  const rank = (label: string): number => {
    const name = label.toLowerCase().split(" — ")[0];
    if (text && name.startsWith(text)) return 0;
    return terms.every((term) => name.includes(term)) ? 1 : 2;
  };
  return ACTIONS.filter((action) =>
    terms.every((term) => action.label.toLowerCase().includes(term)),
  )
    .map((action, index) => ({ action, index, rank: rank(action.label) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.action);
}
