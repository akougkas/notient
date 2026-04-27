import { chatActions, pinnedContext } from "../chat-state";

export interface ContextChipProps {
  /** Display label override; defaults to the path itself. */
  label?: string;
  /** Override the chip kind so memory and context chips can share the component. */
  kind?: "pinned" | "memory" | "context";
  notePath?: string;
  onRemove?: () => void;
}

/**
 * Inline chip rendered above the chat input that lists the pinned-context
 * notes for the active conversation. When called without props it reads the
 * `pinnedContext` signal and renders one chip per note path. Calling it with
 * an explicit `notePath` and `onRemove` lets parents reuse the same shape for
 * memory or one-off context chips.
 */
export function ContextChip(props: ContextChipProps = {}) {
  const actions = chatActions.value;

  if (props.notePath) {
    const removeHandler = props.onRemove ?? (() => actions?.unpinNote(props.notePath as string));
    const chipKind = props.kind ?? "pinned";
    return (
      <span
        class="notient-chip notient-chat-context__chip"
        data-kind={chipKind}
        data-note-path={props.notePath}
      >
        <span class="notient-chat-context__label">{props.label ?? props.notePath}</span>
        <button
          type="button"
          class="notient-chip__remove notient-chat-context__remove"
          aria-label={`Remove ${props.label ?? props.notePath}`}
          onClick={removeHandler}
        >
          {"×"}
        </button>
      </span>
    );
  }

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
        <li
          key={notePath}
          class="notient-chip notient-chat-context__chip"
          data-kind="pinned"
          data-note-path={notePath}
        >
          <span class="notient-chat-context__label">{notePath}</span>
          <button
            type="button"
            class="notient-chip__remove notient-chat-context__remove"
            aria-label={`Unpin ${notePath}`}
            onClick={() => actions?.unpinNote(notePath)}
          >
            {"×"}
          </button>
        </li>
      ))}
    </ul>
  );
}
