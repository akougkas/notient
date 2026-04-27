import type { JSX } from "preact";
import {
  type ChatActions,
  activeConversation,
  chatActions,
  chatError,
  contextUsage,
  dispatchChat,
  draftInput,
  drawerOpen,
  liveAssistantBuffer,
  liveReasoningBuffer,
  pendingApprovals,
  persistReasoning,
  turnInFlight,
} from "../chat-state";
import { ApprovalCard } from "./ApprovalCard";
import { ContextChip } from "./ContextChip";
import { ConversationsDrawer } from "./ConversationsDrawer";
import { MessageBubble } from "./MessageBubble";
import { ReasoningBlock } from "./ReasoningBlock";

interface EmptyChatProps {
  actions: ChatActions | null;
  errorMessage: string | null;
}

function EmptyChat({ actions, errorMessage }: EmptyChatProps): JSX.Element {
  return (
    <section class="notient-tab-body notient-tab-body--chat">
      <div class="notient-empty">
        <span class="notient-empty__dot" />
        <h3 class="notient-empty__title">Your second brain is listening.</h3>
        <p class="notient-empty__hint">Ask a question. Pin a note. The vault answers.</p>
        <button
          type="button"
          class="notient-button"
          data-emphasis="primary"
          onClick={() => {
            void actions?.newConversation();
          }}
        >
          Start new conversation
        </button>
        {errorMessage ? <p class="notient-composer__error">{errorMessage}</p> : null}
      </div>
    </section>
  );
}

interface ChatComposerProps {
  draft: string;
  inFlight: boolean;
  actions: ChatActions | null;
  send: () => void;
  onKey: (keyEvent: KeyboardEvent) => void;
}

function ChatComposer({ draft, inFlight, actions, send, onKey }: ChatComposerProps): JSX.Element {
  return (
    <form
      class="notient-composer notient-chat-input"
      onSubmit={(formEvent) => {
        formEvent.preventDefault();
        send();
      }}
    >
      <textarea
        class="notient-composer__field notient-chat-input__textarea"
        value={draft}
        placeholder={
          inFlight
            ? "Notient is thinking. Press Esc to abort."
            : "Ask about your vault. Press Cmd or Ctrl plus Enter to send."
        }
        onInput={(input) => {
          const target = input.currentTarget as HTMLTextAreaElement;
          draftInput.value = target.value;
        }}
        onKeyDown={onKey}
        disabled={inFlight}
      />
      <div class="notient-composer__row notient-chat-input__actions">
        <span class="notient-composer__hint">Cmd or Ctrl + Enter to send</span>
        <span class="notient-composer__buttons">
          {inFlight ? (
            <button
              type="button"
              class="notient-button notient-chat-input__abort"
              data-emphasis="ghost"
              data-tone="danger"
              onClick={() => actions?.abort()}
            >
              Abort
            </button>
          ) : null}
          <button
            type="submit"
            class="notient-button notient-chat-input__send"
            data-emphasis="primary"
            disabled={inFlight || draft.trim().length === 0}
            onClick={(clickEvent) => {
              clickEvent.preventDefault();
              send();
            }}
          >
            Send
          </button>
        </span>
      </div>
    </form>
  );
}

/**
 * The ChatTab is the flagship Phosphor Garden surface. It hosts the streaming
 * assistant tokens, inline tool cards, write-tool approvals, the pinned
 * context chips, and the conversations drawer. Cmd/Ctrl+Enter sends; Esc
 * aborts a turn in flight.
 */
export function ChatTab() {
  const conversation = activeConversation.value;
  const actions = chatActions.value;
  const inFlight = turnInFlight.value;
  const usage = contextUsage.value;
  const errorMessage = chatError.value;
  const drawerVisible = drawerOpen.value;
  const persistReasoningOn = persistReasoning.value;
  const liveAssistant = liveAssistantBuffer.value;
  const liveReasoning = liveReasoningBuffer.value;
  const approvals = pendingApprovals.value;
  const draft = draftInput.value;

  if (!conversation) {
    return <EmptyChat actions={actions} errorMessage={errorMessage} />;
  }

  const usagePercent = usage.budget > 0 ? Math.round((usage.used / usage.budget) * 100) : 0;

  const send = (): void => {
    const text = draft.trim();
    if (text.length === 0 || inFlight) return;
    draftInput.value = "";
    void dispatchChat(text);
  };

  const handleKey = (keyEvent: KeyboardEvent): void => {
    if (keyEvent.key === "Enter" && (keyEvent.metaKey || keyEvent.ctrlKey)) {
      keyEvent.preventDefault();
      send();
      return;
    }
    if (keyEvent.key === "Escape" && inFlight) {
      keyEvent.preventDefault();
      actions?.abort();
    }
  };

  const liveAssistantStreaming = inFlight && liveAssistant.length > 0;

  return (
    <section class="notient-tab-body notient-tab-body--chat notient-chat">
      <header class="notient-chat__head notient-chat-header" aria-label="Conversation header">
        <button
          type="button"
          class="notient-button notient-chat-header__menu"
          data-emphasis="ghost"
          aria-label="Conversations"
          onClick={() => {
            drawerOpen.value = !drawerOpen.value;
          }}
        >
          Menu
        </button>
        <h3 class="notient-chat__topic notient-chat-header__title">
          {conversation.topic || "Untitled"}
        </h3>
        <span
          class="notient-chat-header__usage notient-pip notient-pip--num"
          aria-label="Context usage"
        >
          {usagePercent}%
        </span>
        <span
          class={`notient-chat__mode notient-chat-header__mode notient-chat-header__mode--${conversation.approvalMode}`}
          data-mode={conversation.approvalMode}
          role="button"
          tabIndex={0}
          onClick={() => {
            void actions?.toggleYolo();
          }}
          onKeyDown={(keyEvent) => {
            if (keyEvent.key === "Enter" || keyEvent.key === " ") {
              keyEvent.preventDefault();
              void actions?.toggleYolo();
            }
          }}
        >
          {conversation.approvalMode === "yolo" ? "Yolo" : "Safe"}
        </span>
        <button
          type="button"
          class="notient-button notient-chat-header__new"
          data-emphasis="ghost"
          aria-label="New chat"
          onClick={() => {
            void actions?.newConversation();
          }}
        >
          New
        </button>
      </header>
      {drawerVisible ? <ConversationsDrawer /> : null}
      <div class="notient-chat__pinned">
        <ContextChip />
      </div>
      {errorMessage ? (
        <p class="notient-composer__error notient-chat-error">{errorMessage}</p>
      ) : null}
      <main class="notient-chat__messages notient-chat-messages" aria-label="Conversation messages">
        {conversation.messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        {liveAssistantStreaming ? (
          <article
            class="notient-msg notient-chat-message notient-chat-message--assistant notient-chat-message--live"
            data-role="assistant"
            data-streaming="true"
          >
            <div class="notient-msg__body notient-chat-message__content">{liveAssistant}</div>
          </article>
        ) : null}
        {inFlight && persistReasoningOn ? (
          <ReasoningBlock reasoning={liveReasoning} streaming />
        ) : null}
        {approvals.map((pending) => (
          <ApprovalCard key={pending.callId} pending={pending} />
        ))}
      </main>
      <ChatComposer
        draft={draft}
        inFlight={inFlight}
        actions={actions}
        send={send}
        onKey={handleKey}
      />
    </section>
  );
}
