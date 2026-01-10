/**
 * ChatView - Sidebar chat interface (View 3)
 *
 * Per spec layout:
 * 1. Context Bar - current note context with change/clear
 * 2. Message Stream - scrollable chat messages
 * 3. Chat Input - text input with send button
 */

import type { Signal } from "@preact/signals";
import { setIcon } from "obsidian";
import { useEffect, useRef } from "preact/hooks";

// Icon component for Lucide icons in Preact
function Icon({ name, className }: { name: string; className?: string }) {
  const iconRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (iconRef.current) {
      setIcon(iconRef.current, name);
    }
  }, [name]);
  return <span ref={iconRef} class={className} aria-hidden="true" />;
}

export interface ChatContext {
  notePath: string | null;
  noteTitle: string | null;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  citations?: string[];
  actions?: ChatAction[];
}

export interface ChatAction {
  label: string;
  type: "apply-links" | "apply-tags" | "create-note" | "open-note";
  payload?: unknown;
}

interface ChatViewProps {
  context: Signal<ChatContext>;
  messages: Signal<ChatMessage[]>;
  isStreaming: Signal<boolean>;
  streamingContent: Signal<string>;
  onSendMessage: (message: string) => void;
  onClearContext: () => void;
  onOpenNote: (path: string) => void;
}

export function ChatView({
  context,
  messages,
  isStreaming,
  streamingContent,
  onSendMessage,
  onClearContext,
  onOpenNote,
}: ChatViewProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.value.length, streamingContent.value]);

  const handleSend = () => {
    const input = inputRef.current;
    if (!input || !input.value.trim() || isStreaming.value) return;

    onSendMessage(input.value.trim());
    input.value = "";
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
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    }
  };

  const hasContext = !!context.value.noteTitle;
  const hasMessages = messages.value.length > 0;

  return (
    <div class="nv2-chat-view" role="region" aria-label="Chat with Notient">
      {/* Section 1: Context Bar */}
      <header class="nv2-chat-context" role="status">
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

      {/* Section 2: Message Stream */}
      <main class="nv2-chat-messages" role="log" aria-live="polite">
        {!hasMessages && !isStreaming.value ? (
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
              </div>
            )}
          </div>
        ) : (
          <>
            {messages.value.map((msg) => (
              <MessageBubble key={msg.id} message={msg} onOpenNote={onOpenNote} />
            ))}
            {isStreaming.value && <StreamingBubble content={streamingContent.value} />}
            <div ref={messagesEndRef} />
          </>
        )}
      </main>

      {/* Section 3: Input */}
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
    </div>
  );
}

// Suggestion chip for empty state
function SuggestionChip({ text, onClick }: { text: string; onClick: () => void }) {
  return (
    <button type="button" class="nv2-chat-suggestion" onClick={onClick}>
      {text}
    </button>
  );
}

// Streaming message bubble
function StreamingBubble({ content }: { content: string }) {
  return (
    <div class="nv2-chat-bubble nv2-chat-bubble--assistant nv2-chat-bubble--streaming">
      <Icon name="bot" className="nv2-chat-bubble-avatar" />
      <div class="nv2-chat-bubble-body">
        {content ? (
          <div class="nv2-chat-bubble-content">
            {content}
            <span class="nv2-typing-cursor" />
          </div>
        ) : (
          <div class="nv2-chat-typing">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
    </div>
  );
}

interface MessageBubbleProps {
  message: ChatMessage;
  onOpenNote: (path: string) => void;
}

function MessageBubble({ message, onOpenNote }: MessageBubbleProps) {
  const isUser = message.role === "user";

  return (
    <div
      class={`nv2-chat-bubble nv2-chat-bubble--${message.role}`}
      role="article"
      aria-label={`${isUser ? "You" : "Notient"} said`}
    >
      {/* Avatar for assistant messages */}
      {!isUser && <Icon name="bot" className="nv2-chat-bubble-avatar" />}

      <div class="nv2-chat-bubble-wrapper">
        <div class="nv2-chat-bubble-header">
          <span class="nv2-chat-bubble-role">{isUser ? "You" : "Notient"}</span>
          <span class="nv2-chat-bubble-time">{formatTime(message.timestamp)}</span>
        </div>
        <div class="nv2-chat-bubble-content">
          <MessageContent content={message.content} onOpenNote={onOpenNote} />
        </div>
        {message.citations && message.citations.length > 0 && (
          <div class="nv2-chat-citations">
            <span class="nv2-chat-citations-label">Sources:</span>
            {message.citations.map((path) => (
              <button
                key={path}
                type="button"
                class="nv2-chat-citation"
                onClick={() => onOpenNote(path)}
                title={path}
              >
                {extractNoteName(path)}
              </button>
            ))}
          </div>
        )}
        {/* Inline actions from assistant (e.g., "Apply these links") */}
        {message.actions && message.actions.length > 0 && (
          <div class="nv2-chat-actions">
            {message.actions.map((action, i) => (
              <button
                key={i}
                type="button"
                class="nv2-chat-action-btn"
                onClick={() => {
                  // Action handler would be passed in via props in production
                  console.log("Action:", action);
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface MessageContentProps {
  content: string;
  onOpenNote: (path: string) => void;
}

function MessageContent({ content, onOpenNote }: MessageContentProps) {
  // Parse [[Note Name]] links and render with clickable links
  const parts = content.split(/(\[\[.*?\]\])/g);

  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("[[") && part.endsWith("]]")) {
          const linkText = part.slice(2, -2);
          return (
            <button
              key={i}
              type="button"
              class="nv2-internal-link"
              onClick={() => onOpenNote(linkText)}
            >
              {linkText}
            </button>
          );
        }
        // Handle newlines
        return part.split("\n").map((line, j) => (
          <span key={`${i}-${j}`}>
            {j > 0 && <br />}
            {line}
          </span>
        ));
      })}
    </>
  );
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function extractNoteName(path: string): string {
  return path.split("/").pop()?.replace(".md", "") || path;
}
