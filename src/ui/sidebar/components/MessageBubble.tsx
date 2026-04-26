import type { VNode } from "preact";
import type { ChatMessage, ToolCall, ToolResult } from "../../../core/chat/types";
import { renderWithCitations } from "./CitationLink";
import { ReasoningBlock } from "./ReasoningBlock";
import { ToolCallCard } from "./ToolCallCard";

export interface MessageBubbleProps {
  message: ChatMessage;
}

/**
 * Renders a single ChatMessage. User messages align right; assistant and tool
 * messages align left. The body runs through a tiny markdown subset so
 * paragraphs and bullet lists round-trip without a heavyweight renderer.
 * Wikilinks inside text are upgraded to clickable {@link CitationLink}s.
 */
export function MessageBubble({ message }: MessageBubbleProps) {
  if (message.role === "tool") {
    // Tool messages are rendered inline through their parent assistant turn
    // via ToolCallCard. Collapse them to nothing here so the chat surface
    // does not duplicate the payload.
    return null;
  }
  const role = message.role === "user" ? "user" : "assistant";
  return (
    <article
      class={`notient-chat-message notient-chat-message--${role}`}
      data-message-id={message.id}
    >
      <div class="notient-chat-message__content">{renderBody(message.content)}</div>
      {renderToolCalls(message.toolCalls, message.toolResults)}
      {message.role === "assistant" && message.reasoningContent ? (
        <ReasoningBlock reasoning={message.reasoningContent} />
      ) : null}
    </article>
  );
}

function renderToolCalls(
  toolCalls: ToolCall[] | undefined,
  toolResults: ToolResult[] | undefined,
): VNode | null {
  if (!toolCalls || toolCalls.length === 0) return null;
  const resultsByCallId = new Map<string, ToolResult>();
  for (const result of toolResults ?? []) {
    resultsByCallId.set(result.callId, result);
  }
  return (
    <ul class="notient-chat-message__tools">
      {toolCalls.map((call) => (
        <li key={call.id}>
          <ToolCallCard call={call} result={resultsByCallId.get(call.id)} />
        </li>
      ))}
    </ul>
  );
}

function renderBody(content: string): Array<VNode | string> {
  if (content.length === 0) return [];
  const blocks = splitBlocks(content);
  const rendered: Array<VNode | string> = [];
  let blockIndex = 0;
  for (const block of blocks) {
    const key = `block-${blockIndex}`;
    if (block.kind === "list") {
      const seenKeys = new Set<string>();
      rendered.push(
        <ul key={key} class="notient-chat-message__list">
          {block.items.map((item) => {
            const childKey = uniqueKey(seenKeys, `${key}-item-${item}`);
            return <li key={childKey}>{renderWithCitations(item)}</li>;
          })}
        </ul>,
      );
    } else {
      rendered.push(
        <p key={key} class="notient-chat-message__paragraph">
          {renderWithCitations(block.text)}
        </p>,
      );
    }
    blockIndex += 1;
  }
  return rendered;
}

type Block = { kind: "paragraph"; text: string } | { kind: "list"; items: string[] };

function uniqueKey(seen: Set<string>, candidate: string): string {
  let result = candidate;
  let counter = 1;
  while (seen.has(result)) {
    counter += 1;
    result = `${candidate}#${counter}`;
  }
  seen.add(result);
  return result;
}

function splitBlocks(content: string): Block[] {
  const lines = content.split(/\r?\n/);
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", text: paragraph.join(" ").trim() });
    paragraph = [];
  };
  const flushBullets = (): void => {
    if (bullets.length === 0) return;
    blocks.push({ kind: "list", items: [...bullets] });
    bullets = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      flushParagraph();
      flushBullets();
      continue;
    }
    const bulletMatch = trimmed.match(/^[-*]\s+(.*)$/);
    if (bulletMatch) {
      flushParagraph();
      bullets.push(bulletMatch[1] ?? "");
      continue;
    }
    flushBullets();
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushBullets();
  return blocks;
}
