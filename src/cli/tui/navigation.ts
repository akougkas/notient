import type { Intent } from "./keymap";

const ACTIONS: ReadonlyArray<{ label: string; intent: Intent }> = [
  { label: "Capture a thought — write or resume your draft", intent: { kind: "capture" } },
  { label: "Save this answer — review it as a note", intent: { kind: "save-answer" } },
  { label: "Edit the open note — review before saving", intent: { kind: "edit-note" } },
  { label: "Chat — return to your conversation", intent: { kind: "view", view: "ask" } },
  {
    label: "Find a note — browse your vault",
    intent: { kind: "prompt-open", prompt: "note-picker" },
  },
  { label: "Conversations — continue a saved thread", intent: { kind: "conversations" } },
  { label: "New conversation — start a fresh thread", intent: { kind: "new-conversation" } },
  { label: "Review changes — proposals and approvals", intent: { kind: "view", view: "inbox" } },
  {
    label: "Compare notes — understand their differences",
    intent: { kind: "analysis", mode: "compare" },
  },
  {
    label: "Find connections — explore one note’s ideas",
    intent: { kind: "analysis", mode: "correlate" },
  },
  { label: "Brief me — get up to speed with source evidence", intent: { kind: "brief" } },
  { label: "Change history — inspect earlier versions and undo", intent: { kind: "history" } },
  { label: "Vault status — indexing and connections", intent: { kind: "view", view: "home" } },
  { label: "Preferences — background work, scope and resources", intent: { kind: "settings" } },
  { label: "Activity — see what happened", intent: { kind: "view", view: "stream" } },
  { label: "Command — run a slash command", intent: { kind: "prompt-open", prompt: "command" } },
];

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
