/**
 * Rich Chat View
 *
 * Enhanced chat interface with markdown rendering, thinking tokens,
 * activity trail, and full developer statistics.
 *
 * Layout:
 * 1. Context Bar - current note context
 * 2. Activity Trail - action breadcrumbs (during streaming)
 * 3. Message Stream - scrollable chat history
 * 4. Stats Summary - aggregate statistics
 * 5. Chat Input - text input with send button
 */

import type { Signal } from "@preact/signals";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Icon } from "../Icon";
import { type ActivityItem, ActivityTrail, createActivityItem } from "./ActivityTrail";
import { DelegationBanner } from "./DelegationBanner";
import {
  type MessageAction,
  MessageBubble,
  type RichChatMessage,
  StreamingBubble,
} from "./MessageBubble";

export interface ChatContext {
  notePath: string | null;
  noteTitle: string | null;
}

export interface DelegationState {
  active: boolean;
  agent?: string;
  workflow?: string;
  progress?: number;
}

interface RichChatViewProps {
  context: Signal<ChatContext>;
  messages: Signal<RichChatMessage[]>;
  isStreaming: Signal<boolean>;
  streamingContent: Signal<string>;
  streamingThinking: Signal<string>;
  isThinking: Signal<boolean>;
  activities: Signal<ActivityItem[]>;
  delegation: Signal<DelegationState | null>;
  onSendMessage: (message: string) => void;
  onClearContext: () => void;
  onOpenNote: (path: string) => void;
  onAction?: (action: MessageAction) => void;
  showStats?: boolean;
}

/** Workflow definitions for suggestion chips */
const WORKFLOW_SUGGESTIONS = [
  { command: "/classify", label: "Classify", match: ["classif", "para", "categoriz", "tag"] },
  { command: "/enrich", label: "Enhance", match: ["enhanc", "improv", "expand", "enrich"] },
  { command: "/link", label: "Find Related", match: ["connect", "related", "similar", "link"] },
];

export function RichChatView({
  context,
  messages,
  isStreaming,
  streamingContent,
  streamingThinking,
  isThinking,
  activities,
  delegation,
  onSendMessage,
  onClearContext,
  onOpenNote,
  onAction,
  showStats = true,
}: RichChatViewProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [inputValue, setInputValue] = useState("");

  // Auto-scroll to bottom when new messages arrive
  // biome-ignore lint/correctness/useExhaustiveDependencies: signals auto-subscribe, scroll triggers on content change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.value.length, streamingContent.value, streamingThinking.value]);

  // Detect workflow suggestions as user types
  const suggestedWorkflows = useMemo(() => {
    const lower = inputValue.toLowerCase().trim();
    if (!lower || lower.length < 2) return [];

    return WORKFLOW_SUGGESTIONS.filter(
      (w) =>
        w.match.some((m) => lower.includes(m)) ||
        lower.startsWith(w.command.slice(0, Math.max(1, lower.length + 1))),
    ).slice(0, 3); // Max 3 suggestions
  }, [inputValue]);

  const handleSend = () => {
    const input = inputRef.current;
    if (!input || !input.value.trim() || isStreaming.value) return;

    onSendMessage(input.value.trim());
    input.value = "";
    setInputValue("");
    input.style.height = "auto";
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const input = inputRef.current;
    if (input) {
      setInputValue(input.value);
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    }
  };

  const handleWorkflowChipClick = (command: string) => {
    if (inputRef.current) {
      inputRef.current.value = `${command} `;
      setInputValue(`${command} `);
      inputRef.current.focus();
    }
  };

  const hasContext = !!context.value.noteTitle;
  const hasMessages = messages.value.length > 0;
  const hasActivities = activities.value.length > 0;
  const hasDelegation = delegation.value?.active;

  return (
    <section class="nv2-chat-view nv2-chat-view--rich" aria-label="Chat with Notient">
      {/* Section 1: Context Bar */}
      <header class="nv2-chat-context">
        {hasContext ? (
          <>
            <Icon name="file-text" className="nv2-chat-context-icon" />
            <button
              type="button"
              class="nv2-chat-context-note"
              onClick={() => context.value.notePath && onOpenNote(context.value.notePath)}
              title={`Open ${context.value.notePath}`}
            >
              {context.value.noteTitle}
            </button>
            <button
              type="button"
              class="nv2-chat-context-clear"
              onClick={onClearContext}
              title="Clear context"
              aria-label="Clear note context"
            >
              ×
            </button>
          </>
        ) : (
          <span class="nv2-chat-context-empty">
            <Icon name="file-text" className="nv2-chat-context-icon" />
            <span>Open a note to chat about it</span>
          </span>
        )}
      </header>

      {/* Section 2: Activity Trail (visible during streaming) */}
      {isStreaming.value && hasActivities && (
        <ActivityTrail activities={activities.value} isStreaming={isStreaming.value} />
      )}

      {/* Section 2b: Delegation Banner (visible during delegation) */}
      {hasDelegation && delegation.value && (
        <DelegationBanner
          agent={delegation.value.agent || "agent"}
          workflow={delegation.value.workflow}
          progress={delegation.value.progress}
        />
      )}

      {/* Section 3: Message Stream */}
      {/* biome-ignore lint/a11y/useSemanticElements: role="log" is valid ARIA for live regions */}
      <main class="nv2-chat-messages" role="log" aria-live="polite">
        {!hasMessages && !isStreaming.value ? (
          <EmptyState hasContext={hasContext} onSendMessage={onSendMessage} />
        ) : (
          <>
            {messages.value.map((msg) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                onOpenNote={onOpenNote}
                onAction={onAction}
                showStats={showStats}
              />
            ))}
            {isStreaming.value && (
              <StreamingBubble
                content={streamingContent.value}
                thinking={streamingThinking.value}
                isThinking={isThinking.value}
              />
            )}
            <div ref={messagesEndRef} />
          </>
        )}
      </main>

      {/* Section 4: Workflow Suggestions */}
      {suggestedWorkflows.length > 0 && !isStreaming.value && (
        <div class="nv2-workflow-suggestions">
          {suggestedWorkflows.map((w) => (
            <button
              key={w.command}
              type="button"
              class="nv2-workflow-chip"
              onClick={() => handleWorkflowChipClick(w.command)}
            >
              {w.label}
            </button>
          ))}
        </div>
      )}

      {/* Section 5: Input */}
      <footer class="nv2-chat-input-area">
        <textarea
          ref={inputRef}
          class="nv2-chat-input"
          placeholder={hasContext ? `Ask about "${context.value.noteTitle}"...` : "Ask Notient..."}
          rows={1}
          disabled={isStreaming.value}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          aria-label="Chat message input"
        />
        <button
          type="button"
          class="nv2-chat-send"
          onClick={handleSend}
          disabled={isStreaming.value || !hasContext}
          title={isStreaming.value ? "Generating..." : "Send message (Enter)"}
          aria-label="Send message"
        >
          {isStreaming.value ? <span class="nv2-chat-send-spinner" /> : <Icon name="arrow-up" />}
        </button>
      </footer>
    </section>
  );
}

/**
 * Empty state when no messages
 */
function EmptyState({
  hasContext,
  onSendMessage,
}: {
  hasContext: boolean;
  onSendMessage: (msg: string) => void;
}) {
  return (
    <div class="nv2-chat-empty">
      <Icon name="bot" className="nv2-chat-empty-avatar" />
      <div class="nv2-chat-empty-title">Chat with Notient</div>
      <div class="nv2-chat-empty-text">
        {hasContext ? "Ask me anything about this note" : "Open a note to get started"}
      </div>
      {hasContext && (
        <div class="nv2-chat-suggestions">
          <SuggestionChip
            text="Summarize this note"
            onClick={() => onSendMessage("Summarize this note")}
          />
          <SuggestionChip
            text="Find related notes"
            onClick={() => onSendMessage("Find notes related to this")}
          />
          <SuggestionChip
            text="Suggest improvements"
            onClick={() => onSendMessage("What improvements would you suggest for this note?")}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Suggestion chip for empty state
 */
function SuggestionChip({ text, onClick }: { text: string; onClick: () => void }) {
  return (
    <button type="button" class="nv2-chat-suggestion" onClick={onClick}>
      {text}
    </button>
  );
}

// Re-export for convenience
export { createActivityItem };
export type { ActivityItem };
