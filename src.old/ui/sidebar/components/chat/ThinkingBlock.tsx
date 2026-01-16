/**
 * Thinking Block
 *
 * Collapsible panel that displays LLM thinking/reasoning content.
 * Expands during streaming, collapses after completion.
 */

import type { Signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { estimateTokenCount } from "../../../../core/chat/thinkingParser";
import { Icon } from "../Icon";

interface ThinkingBlockProps {
  /** Thinking content to display */
  content: string;
  /** Whether thinking is still streaming */
  isStreaming?: boolean;
  /** Duration in milliseconds (shown after completion) */
  durationMs?: number;
  /** Signal for live streaming content (optional) */
  streamingContent?: Signal<string>;
  /** Whether to start expanded */
  defaultExpanded?: boolean;
}

export function ThinkingBlock({
  content,
  isStreaming = false,
  durationMs,
  streamingContent,
  defaultExpanded = false,
}: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded || isStreaming);
  const contentRef = useRef<HTMLDivElement>(null);

  // Auto-expand when streaming starts
  useEffect(() => {
    if (isStreaming) {
      setIsExpanded(true);
    }
  }, [isStreaming]);

  // Auto-scroll to bottom when streaming
  useEffect(() => {
    if (isStreaming && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [isStreaming]);

  // Get display content
  const displayContent = streamingContent?.value || content;
  const tokenCount = estimateTokenCount(displayContent);

  // Format duration
  const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const handleToggle = () => {
    if (!isStreaming) {
      setIsExpanded(!isExpanded);
    }
  };

  return (
    <div
      class={`nv2-thinking-block ${isExpanded ? "nv2-thinking-block--expanded" : ""} ${isStreaming ? "nv2-thinking-block--streaming" : ""}`}
    >
      <button
        type="button"
        class="nv2-thinking-header"
        onClick={handleToggle}
        disabled={isStreaming}
        aria-expanded={isExpanded}
        aria-controls="thinking-content"
      >
        <Icon
          name={isExpanded ? "chevron-down" : "chevron-right"}
          className="nv2-thinking-chevron"
        />
        <span class="nv2-thinking-title">
          {isStreaming ? (
            <>
              <span class="nv2-thinking-spinner" />
              Thinking...
            </>
          ) : (
            "Thinking"
          )}
        </span>
        <span class="nv2-thinking-stats">
          {durationMs && <span class="nv2-thinking-duration">{formatDuration(durationMs)}</span>}
          <span class="nv2-thinking-tokens">{tokenCount} tokens</span>
        </span>
      </button>

      {isExpanded && (
        <section id="thinking-content" ref={contentRef} class="nv2-thinking-content">
          <pre class="nv2-thinking-text">
            {displayContent}
            {isStreaming && <span class="nv2-thinking-cursor" />}
          </pre>
        </section>
      )}
    </div>
  );
}

/**
 * Inline thinking indicator (for use during streaming before full block appears)
 */
export function ThinkingIndicator({ message = "Reasoning..." }: { message?: string }) {
  return (
    <div class="nv2-thinking-indicator">
      <span class="nv2-thinking-spinner" />
      <span class="nv2-thinking-message">{message}</span>
    </div>
  );
}
