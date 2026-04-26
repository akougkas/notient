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
    <aside class="notient-chat-drawer" role="dialog" aria-label="Conversations">
      <header class="notient-chat-drawer__header">
        <button
          type="button"
          class="notient-chat-drawer__new"
          onClick={() => {
            drawerOpen.value = false;
            void actions?.newConversation();
          }}
        >
          New chat
        </button>
        <button
          type="button"
          class="notient-chat-drawer__close"
          aria-label="Close conversations"
          onClick={() => {
            drawerOpen.value = false;
          }}
        >
          x
        </button>
      </header>
      {entries.length === 0 ? (
        <p class="notient-chat-drawer__empty">No prior conversations.</p>
      ) : (
        <ul class="notient-chat-drawer__list">
          {groups.map((group) => (
            <li key={group.label} class="notient-chat-drawer__group">
              <h4 class="notient-chat-drawer__group-label">{group.label}</h4>
              <ul class="notient-chat-drawer__group-items">
                {group.entries.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      class="notient-chat-drawer__item"
                      onClick={() => {
                        drawerOpen.value = false;
                        void actions?.loadConversation(entry.notePath);
                      }}
                    >
                      <span class="notient-chat-drawer__topic">{entry.topic || "Untitled"}</span>
                      <span class="notient-chat-drawer__path">{entry.notePath}</span>
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
