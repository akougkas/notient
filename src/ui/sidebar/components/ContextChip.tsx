import { chatActions, pinnedContext } from "../chat-state";

/**
 * Inline chip rendered above the chat input that lists the pinned-context
 * notes for the active conversation. Each chip exposes a single-click unpin.
 * When the list is empty, an empty-state hint nudges the user to pin a note.
 */
export function ContextChip() {
  const actions = chatActions.value;
  const pinned = pinnedContext.value;
  if (pinned.length === 0) {
    return (
      <div class="notient-chat-context notient-chat-context--empty">
        <span class="notient-chat-context__hint">Pin a note for context.</span>
      </div>
    );
  }
  return (
    <ul class="notient-chat-context">
      {pinned.map((notePath) => (
        <li key={notePath} class="notient-chat-context__chip" data-note-path={notePath}>
          <span class="notient-chat-context__label">{notePath}</span>
          <button
            type="button"
            class="notient-chat-context__remove"
            aria-label={`Unpin ${notePath}`}
            onClick={() => actions?.unpinNote(notePath)}
          >
            x
          </button>
        </li>
      ))}
    </ul>
  );
}
