import {
  type ConversationSummary,
  chatActions,
  conversationsList,
  drawerOpen,
} from "../chat-state";

/**
 * Overlay panel listing the recorded conversations grouped by relative date
 * bucket (Today / Yesterday / Earlier). Most-recent first. Click an entry to
 * load it through {@link ChatActions.loadConversation}; the drawer closes
 * itself once a conversation is requested.
 */
export function ConversationsDrawer() {
  const actions = chatActions.value;
  const entries = conversationsList.value;
  const groups = groupByRelativeDate(entries);
  return (
    <aside class="notient-drawer notient-chat-drawer" role="dialog" aria-label="Conversations">
      <div class="notient-drawer__head notient-chat-drawer__header">
        <span>Conversations</span>
        <span class="notient-chat-drawer__actions">
          <button
            type="button"
            class="notient-button notient-chat-drawer__new"
            data-emphasis="ghost"
            onClick={() => {
              drawerOpen.value = false;
              void actions?.newConversation();
            }}
          >
            New chat
          </button>
          <button
            type="button"
            class="notient-button notient-chat-drawer__close"
            data-emphasis="ghost"
            aria-label="Close conversations"
            onClick={() => {
              drawerOpen.value = false;
            }}
          >
            {"×"}
          </button>
        </span>
      </div>
      {entries.length === 0 ? (
        <p class="notient-chat-drawer__empty">No prior conversations.</p>
      ) : (
        <ul class="notient-drawer__list notient-chat-drawer__list">
          {groups.map((group) => (
            <li key={group.label} class="notient-chat-drawer__group">
              <h4 class="notient-chat-drawer__group-label">{group.label}</h4>
              <ul class="notient-chat-drawer__group-items">
                {group.entries.map((entry) => (
                  <li key={entry.id} class="notient-drawer__item notient-chat-drawer__item">
                    <button
                      type="button"
                      class="notient-chat-drawer__entry"
                      onClick={() => {
                        drawerOpen.value = false;
                        void actions?.loadConversation(entry.notePath);
                      }}
                    >
                      <span class="notient-drawer__topic notient-chat-drawer__topic">
                        {entry.topic || "Untitled"}
                      </span>
                      <span class="notient-drawer__date notient-chat-drawer__path">
                        {formatShortDate(entry.updatedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

interface DateGroup {
  label: string;
  entries: ConversationSummary[];
}

const DAY_MILLIS = 24 * 60 * 60 * 1000;

function groupByRelativeDate(entries: ConversationSummary[]): DateGroup[] {
  if (entries.length === 0) return [];
  const sorted = [...entries].sort((left, right) => right.updatedAt - left.updatedAt);
  const today = startOfDay(Date.now());
  const yesterday = today - DAY_MILLIS;
  const buckets = new Map<string, ConversationSummary[]>();
  const order: string[] = [];
  for (const entry of sorted) {
    const stamp = startOfDay(entry.updatedAt);
    let label: string;
    if (stamp === today) label = "Today";
    else if (stamp === yesterday) label = "Yesterday";
    else label = formatDate(stamp);
    let bucket = buckets.get(label);
    if (!bucket) {
      bucket = [];
      buckets.set(label, bucket);
      order.push(label);
    }
    bucket.push(entry);
  }
  return order.map((label) => ({ label, entries: buckets.get(label) ?? [] }));
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function formatShortDate(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const today = startOfDay(Date.now());
  const stamp = startOfDay(timestamp);
  if (stamp === today) {
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
  }
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}-${day}`;
}
