const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/** Legacy reasoning tags stay out of the answer; Markdown remains intact. */
export function visibleAssistantText(text: string): string {
  return splitThoughtSpans(text)
    .filter((span) => !span.thought)
    .map((span) => span.text)
    .join("");
}

interface Span {
  readonly thought: boolean;
  readonly text: string;
}

function splitThoughtSpans(text: string): Span[] {
  const spans: Span[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf(THINK_OPEN, cursor);
    if (open < 0) break;
    if (open > cursor) spans.push({ thought: false, text: text.slice(cursor, open) });
    const bodyStart = open + THINK_OPEN.length;
    const close = text.indexOf(THINK_CLOSE, bodyStart);
    if (close < 0) {
      spans.push({ thought: true, text: text.slice(bodyStart) });
      return trimTagAdjacentNewlines(spans);
    }
    spans.push({ thought: true, text: text.slice(bodyStart, close) });
    cursor = close + THINK_CLOSE.length;
  }
  if (cursor < text.length) spans.push({ thought: false, text: text.slice(cursor) });
  return trimTagAdjacentNewlines(spans);
}

/**
 * A `<think>` block on its own lines leaves a newline glued to each side of
 * the surrounding prose. Those newlines belong to the tag, not the prose, so
 * one is dropped from each boundary.
 */
function trimTagAdjacentNewlines(spans: Span[]): Span[] {
  return spans.map((span, index) => {
    if (span.thought) return span;
    let text = span.text;
    if (spans[index - 1]?.thought === true && text.startsWith("\n")) text = text.slice(1);
    if (spans[index + 1]?.thought === true && text.endsWith("\n")) text = text.slice(0, -1);
    return { thought: false, text };
  });
}
