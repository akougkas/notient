import {
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

/**
 * The ChatTab is the flagship surface from Q6. It hosts the streaming
 * assistant tokens, inline tool cards, write-tool approvals, the pinned
 * context chip, and the conversations drawer. Cmd/Ctrl+Enter sends; Esc
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
    return (
      <section class="notient-tab-body notient-tab-body--chat">
        <div class="notient-chat-empty">
          <h3 class="notient-chat-empty__title">Talk to your second brain</h3>
          <p class="notient-chat-empty__hint">Try: "What notes contradict my view on X?"</p>
          <button
            type="button"
            class="notient-chat-empty__cta"
            onClick={() => {
              void actions?.newConversation();
            }}
          >
            Start new conversation
          </button>
          {errorMessage ? <p class="notient-chat-error">{errorMessage}</p> : null}
        </div>
      </section>
    );
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

  return (
    <section class="notient-tab-body notient-tab-body--chat">
      <header class="notient-chat-header">
        <button
          type="button"
          class="notient-chat-header__menu"
          aria-label="Conversations"
          onClick={() => {
            drawerOpen.value = !drawerOpen.value;
          }}
        >
          Menu
        </button>
        <h3 class="notient-chat-header__title">{conversation.topic || "Untitled"}</h3>
        <span class="notient-chat-header__usage" aria-label="Context usage">
          {usagePercent}%
        </span>
        <button
          type="button"
          class={`notient-chat-header__mode notient-chat-header__mode--${conversation.approvalMode}`}
          aria-label="Toggle chat approval mode"
          onClick={() => {
            void actions?.toggleYolo();
          }}
        >
          {conversation.approvalMode === "yolo" ? "Yolo" : "Safe"}
        </button>
        <button
          type="button"
          class="notient-chat-header__new"
          aria-label="New chat"
          onClick={() => {
            void actions?.newConversation();
          }}
        >
          New
        </button>
      </header>
      {drawerVisible ? <ConversationsDrawer /> : null}
      <ContextChip />
      {errorMessage ? <p class="notient-chat-error">{errorMessage}</p> : null}
      <main class="notient-chat-messages">
        {conversation.messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        {inFlight && liveAssistant.length > 0 ? (
          <article class="notient-chat-message notient-chat-message--assistant notient-chat-message--live">
            <div class="notient-chat-message__content">{liveAssistant}</div>
          </article>
        ) : null}
        {inFlight && persistReasoningOn ? (
          <ReasoningBlock reasoning={liveReasoning} streaming />
        ) : null}
        {approvals.map((pending) => (
          <ApprovalCard key={pending.callId} pending={pending} />
        ))}
      </main>
      <footer class="notient-chat-input">
        <textarea
          class="notient-chat-input__textarea"
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
          onKeyDown={handleKey}
          disabled={inFlight}
        />
        <div class="notient-chat-input__actions">
          <button
            type="button"
            class="notient-chat-input__send"
            disabled={inFlight || draft.trim().length === 0}
            onClick={send}
          >
            Send
          </button>
          {inFlight ? (
            <button
              type="button"
              class="notient-chat-input__abort"
              onClick={() => actions?.abort()}
            >
              Abort
            </button>
          ) : null}
        </div>
      </footer>
    </section>
  );
}
