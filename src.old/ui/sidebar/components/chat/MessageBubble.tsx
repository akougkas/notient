/**
 * Message Bubble
 *
 * Rich message rendering with markdown, thinking blocks, and statistics.
 */

import type { ChatStatistics } from "../../../../core/chat/types";
import { Icon } from "../Icon";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { StatsPanel } from "./StatsPanel";
import { ThinkingBlock } from "./ThinkingBlock";

export interface RichChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  /** Thinking content (for reasoning models) */
  thinking?: string | null;
  /** Time spent thinking */
  thinkingDurationMs?: number;
  /** Response statistics */
  statistics?: ChatStatistics;
  /** Wiki-link citations */
  citations?: string[];
  /** Inline actions */
  actions?: MessageAction[];
}

export interface MessageAction {
  label: string;
  type: "apply-links" | "apply-tags" | "create-note" | "open-note";
  payload?: unknown;
}

interface MessageBubbleProps {
  message: RichChatMessage;
  onOpenNote: (path: string) => void;
  onAction?: (action: MessageAction) => void;
  showStats?: boolean;
}

/**
 * Format timestamp
 */
function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Extract note name from path
 */
function extractNoteName(path: string): string {
  return path.split("/").pop()?.replace(".md", "") || path;
}

export function MessageBubble({
  message,
  onOpenNote,
  onAction,
  showStats = true,
}: MessageBubbleProps) {
  const isUser = message.role === "user";
  const hasThinking = !isUser && message.thinking && message.thinking.length > 0;
  const hasStats = !isUser && message.statistics && showStats;
  const hasCitations = message.citations && message.citations.length > 0;
  const hasActions = message.actions && message.actions.length > 0;

  return (
    <article
      class={`nv2-chat-bubble nv2-chat-bubble--${message.role}`}
      aria-label={`${isUser ? "You" : "Notient"} said`}
    >
      {/* Avatar for assistant messages */}
      {!isUser && <Icon name="bot" className="nv2-chat-bubble-avatar" />}

      <div class="nv2-chat-bubble-wrapper">
        {/* Header */}
        <div class="nv2-chat-bubble-header">
          <span class="nv2-chat-bubble-role">{isUser ? "You" : "Notient"}</span>
          <span class="nv2-chat-bubble-time">{formatTime(message.timestamp)}</span>
        </div>

        {/* Thinking block (before main content) */}
        {hasThinking && message.thinking && (
          <ThinkingBlock
            content={message.thinking}
            durationMs={message.thinkingDurationMs}
            defaultExpanded={false}
          />
        )}

        {/* Main content */}
        <div class="nv2-chat-bubble-content">
          {isUser ? (
            // User messages: plain text with line breaks
            <div class="nv2-chat-bubble-text">
              {message.content.split("\n").map((line, index) => (
                <span key={`${message.id}-line-${index}`}>
                  {index > 0 && <br />}
                  {line}
                </span>
              ))}
            </div>
          ) : (
            // Assistant messages: rendered markdown
            <MarkdownRenderer content={message.content} onLinkClick={onOpenNote} />
          )}
        </div>

        {/* Citations */}
        {hasCitations && (
          <div class="nv2-chat-citations">
            <span class="nv2-chat-citations-label">Sources:</span>
            {message.citations?.map((path) => (
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

        {/* Inline actions */}
        {hasActions && onAction && (
          <div class="nv2-chat-actions">
            {message.actions?.map((action) => (
              <button
                key={`${message.id}-${action.type}-${action.label}`}
                type="button"
                class="nv2-chat-action-btn"
                onClick={() => onAction(action)}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}

        {/* Statistics panel */}
        {hasStats && message.statistics && (
          <StatsPanel statistics={message.statistics} position="inline" />
        )}
      </div>
    </article>
  );
}

/**
 * Streaming message bubble (during generation)
 */
interface StreamingBubbleProps {
  content: string;
  thinking?: string;
  isThinking?: boolean;
}

export function StreamingBubble({ content, thinking, isThinking }: StreamingBubbleProps) {
  return (
    <div class="nv2-chat-bubble nv2-chat-bubble--assistant nv2-chat-bubble--streaming">
      <Icon name="bot" className="nv2-chat-bubble-avatar" />
      <div class="nv2-chat-bubble-body">
        {/* Show thinking block if we have thinking content */}
        {thinking && thinking.length > 0 && (
          <ThinkingBlock content={thinking} isStreaming={isThinking} defaultExpanded={true} />
        )}

        {/* Main content */}
        {content ? (
          <div class="nv2-chat-bubble-content">
            <MarkdownRenderer content={content} />
            <span class="nv2-typing-cursor" />
          </div>
        ) : !thinking ? (
          // Show typing indicator only if no thinking content yet
          <div class="nv2-chat-typing">
            <span />
            <span />
            <span />
          </div>
        ) : null}
      </div>
    </div>
  );
}
