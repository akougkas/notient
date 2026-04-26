import type { VNode } from "preact";
import { chatActions } from "../chat-state";

export interface CitationLinkProps {
  /** The wikilink target without the surrounding brackets, e.g. `notes/a`. */
  target: string;
  /** Optional display label; falls back to the wikilink text. */
  label?: string;
}

/**
 * Renders a `[[wikilink]]` as a clickable element. The actual `openLinkText`
 * call is delegated to the injected {@link ChatActions.openLink} so this
 * module never imports from `obsidian` directly.
 */
export function CitationLink({ target, label }: CitationLinkProps) {
  const actions = chatActions.value;
  const text = label ?? target;
  const handleClick = (event: MouseEvent) => {
    event.preventDefault();
    actions?.openLink(target);
  };
  return (
    <a class="notient-chat-citation" href={`#${target}`} data-target={target} onClick={handleClick}>
      [[{text}]]
    </a>
  );
}

/**
 * Split arbitrary text into an array of plain-string segments and CitationLink
 * elements. Used by MessageBubble to inline-render wikilinks inside assistant
 * content without pulling in a markdown library.
 */
export function renderWithCitations(content: string): Array<string | VNode> {
  const segments: Array<string | VNode> = [];
  const pattern = /\[\[([^\]]+)\]\]/g;
  let lastIndex = 0;
  let cursor = pattern.exec(content);
  while (cursor !== null) {
    if (cursor.index > lastIndex) {
      segments.push(content.slice(lastIndex, cursor.index));
    }
    const raw = cursor[1] ?? "";
    const [target, label] = splitWikilink(raw);
    segments.push(<CitationLink key={`${cursor.index}-${target}`} target={target} label={label} />);
    lastIndex = cursor.index + cursor[0].length;
    cursor = pattern.exec(content);
  }
  if (lastIndex < content.length) {
    segments.push(content.slice(lastIndex));
  }
  return segments;
}

function splitWikilink(raw: string): [string, string | undefined] {
  const pipe = raw.indexOf("|");
  if (pipe < 0) return [raw.trim(), undefined];
  return [raw.slice(0, pipe).trim(), raw.slice(pipe + 1).trim()];
}
