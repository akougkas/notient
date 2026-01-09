/**
 * ChatView - Sidebar chat interface
 *
 * A clean chat interface using Notient's existing chat infrastructure:
 * - ChatSession for message management
 * - NotientAgent for AI responses
 * - Streaming support
 * - Note context awareness
 */

import { Notice } from "obsidian";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { NotientAgent } from "../../../core/agent";
import { ChatSession } from "../../../core/chat";
import type { ExtendedChatMessage } from "../../../core/chat/types";
import { useKernel, useService } from "../context/KernelContext";
import { useNoteVitals } from "../hooks/useNoteVitals";

export function ChatView() {
  const kernel = useKernel();
  const agent = useService<NotientAgent>("agent");
  const { noteVitals } = useNoteVitals();

  // Chat state
  const [session] = useState(() => new ChatSession({ maxHistoryLength: 100, maxLLMMessages: 10 }));
  const [messages, setMessages] = useState<ExtendedChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Scroll to bottom when messages change
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingContent, scrollToBottom]);

  // Handle sending a message
  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || !agent || isStreaming) return;

    // Add user message
    const userMessage = session.addUserMessage(text);
    setMessages(session.getMessages());
    setInputValue("");

    // Reset textarea height
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }

    // Start streaming response
    setIsStreaming(true);
    setStreamingContent("");
    abortControllerRef.current = new AbortController();

    try {
      // Create agent task
      const task = {
        id: crypto.randomUUID(),
        agent: "chat" as const,
        notePath: noteVitals.value?.path || "unknown",
        noteTitle: noteVitals.value?.title || "Unknown Note",
        status: "running" as const,
        startedAt: new Date(),
        chatHistory: session.getMessagesForLLM(),
      };

      // Stream response
      let completeMessage = "";
      for await (const event of agent.executeStreaming(task, abortControllerRef.current.signal)) {
        switch (event.type) {
          case "chunk":
            completeMessage += event.content;
            setStreamingContent(completeMessage);
            break;
          case "complete":
            // Add complete assistant message
            if (event.result.data) {
              session.addAssistantMessage(event.result.data as string);
              setMessages(session.getMessages());
            }
            break;
          case "error":
            throw event.error;
        }
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        const errorMsg = `Error: ${(error as Error).message}`;
        session.addAssistantMessage(errorMsg);
        setMessages(session.getMessages());
        new Notice(errorMsg);
      }
    } finally {
      setIsStreaming(false);
      setStreamingContent("");
      abortControllerRef.current = null;
    }
  }, [inputValue, agent, isStreaming, session, noteVitals]);

  // Handle input changes
  const handleInputChange = useCallback((e: Event) => {
    const target = e.target as HTMLTextAreaElement;
    setInputValue(target.value);

    // Auto-resize textarea
    target.style.height = "auto";
    target.style.height = `${target.scrollHeight}px`;
  }, []);

  // Handle Enter key (send on Enter, new line on Shift+Enter)
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Handle stop streaming
  const handleStop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setIsStreaming(false);
      setStreamingContent("");
    }
  }, []);

  const currentNote = noteVitals.value;
  const hasMessages = messages.length > 0 || isStreaming;

  return (
    <div class="nv2-chat-view">
      {/* Context Bar */}
      <div class="nv2-chat-context">
        <div class="nv2-chat-context-icon">💬</div>
        <div class="nv2-chat-context-info">
          <div class="nv2-chat-context-title">
            {currentNote ? currentNote.title : "No note selected"}
          </div>
          <div class="nv2-chat-context-subtitle">
            {currentNote ? "Chat about this note" : "Open a note to start chatting"}
          </div>
        </div>
      </div>

      {/* Messages Area */}
      <div class="nv2-chat-messages">
        {!hasMessages ? (
          <div class="nv2-chat-empty">
            <div class="nv2-chat-empty-icon">💭</div>
            <div class="nv2-chat-empty-title">No messages yet</div>
            <div class="nv2-chat-empty-subtitle">
              Start a conversation about "{currentNote?.title || "your note"}"
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg) => (
              <div key={msg.id} class={`nv2-chat-message nv2-chat-message--${msg.role}`}>
                <div class="nv2-chat-message-avatar">{msg.role === "user" ? "👤" : "🤖"}</div>
                <div class="nv2-chat-message-content">
                  <div class="nv2-chat-message-role">{msg.role === "user" ? "You" : "Notient"}</div>
                  <div class="nv2-chat-message-text">{msg.content}</div>
                </div>
              </div>
            ))}

            {/* Streaming message */}
            {isStreaming && streamingContent && (
              <div class="nv2-chat-message nv2-chat-message--assistant nv2-chat-message--streaming">
                <div class="nv2-chat-message-avatar">🤖</div>
                <div class="nv2-chat-message-content">
                  <div class="nv2-chat-message-role">Notient</div>
                  <div class="nv2-chat-message-text">{streamingContent}</div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input Area */}
      <div class="nv2-chat-input-container">
        <textarea
          ref={inputRef}
          class="nv2-chat-input"
          placeholder={currentNote ? "Ask about this note..." : "Open a note to start chatting"}
          value={inputValue}
          onInput={handleInputChange}
          onKeyDown={handleKeyDown}
          disabled={!currentNote || isStreaming}
          rows={1}
        />
        <div class="nv2-chat-input-actions">
          {isStreaming ? (
            <button
              class="nv2-chat-button nv2-chat-button--stop"
              onClick={handleStop}
              type="button"
            >
              <span class="nv2-chat-button-icon">⏸</span>
              <span>Stop</span>
            </button>
          ) : (
            <button
              class="nv2-chat-button nv2-chat-button--send"
              onClick={handleSend}
              disabled={!inputValue.trim() || !currentNote}
              type="button"
            >
              <span class="nv2-chat-button-icon">📤</span>
              <span>Send</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
