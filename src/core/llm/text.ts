/**
 * Shared text hygiene helpers for LLM responses.
 *
 * Local reasoning models are inconsistent about where the chain-of-thought
 * lands. llama-server splits it into `reasoning_content` when the chat
 * template cooperates, but plenty of GGUF templates leak `<think>...</think>`
 * straight into the content channel, and a few emit a bare closing `</think>`
 * with no opener because the opening tag was consumed by the prompt prefix.
 * Every consumer that treats content as prose or as JSON runs it through
 * {@link stripThinkTags} first.
 *
 * `stripJsonFences` is shared by the provider and tool-mode probe so every
 * consumer applies the same boundary rules.
 */

const THINK_BLOCK_RE = /<think>[\s\S]*?<\/think>/gi;
const THINK_CLOSE_RE = /<\/think\s*>/i;
const THINK_OPEN_UNCLOSED_RE = /<think>[\s\S]*$/i;

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function isInsideQuotedSpan(text: string, start: number, end: number): boolean {
  for (const quote of ['"', "'", "`"]) {
    let open = false;
    for (let index = 0; index < start; index += 1) {
      if (text[index] === quote && !isEscaped(text, index)) open = !open;
    }
    if (!open) continue;
    for (let index = end; index < text.length; index += 1) {
      if (text[index] === quote && !isEscaped(text, index)) return true;
    }
  }
  return false;
}

/**
 * Remove reasoning scaffolding from a completed response body.
 *
 * Handles three shapes, in order:
 *   1. Balanced `<think>...</think>` blocks anywhere in the text.
 *   2. An early orphan `</think>` with no opener: everything before it is reasoning.
 *   3. An unclosed `<think>` that runs to the end of the text.
 */
export function stripThinkTags(text: string): string {
  if (text.length === 0) return text;
  let out = text.replace(THINK_BLOCK_RE, "");
  const close = THINK_CLOSE_RE.exec(out);
  if (close !== null && !isInsideQuotedSpan(out, close.index, close.index + close[0].length)) {
    out = out.slice(close.index + close[0].length);
  }
  out = out.replace(THINK_OPEN_UNCLOSED_RE, "");
  return out.trim();
}

/**
 * Unwrap a ```json fenced block. Returns the input unchanged when no fence is
 * present so callers can pipe every response through it unconditionally.
 */
export function stripJsonFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? (fenced[1] ?? "").trim() : text;
}

/**
 * Pull the first balanced top-level JSON object out of arbitrary text,
 * preferring a fenced block when one exists. Brace matching is string- and
 * escape-aware so a `}` inside a JSON string value does not end the scan.
 * Returns null when no plausible object is present.
 */
export function extractFirstJsonObject(text: string): string | null {
  const fenced = stripJsonFences(text);
  const candidates = fenced === text ? [text] : [fenced, text];
  for (const candidate of candidates) {
    const found = scanBalancedObject(candidate);
    if (found !== null) return found;
  }
  return null;
}

interface ScanState {
  depth: number;
  inString: boolean;
  escaped: boolean;
}

function scanBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  const state: ScanState = { depth: 0, inString: false, escaped: false };
  for (let index = start; index < text.length; index++) {
    if (step(state, text[index] ?? "") && state.depth === 0) {
      return text.slice(start, index + 1);
    }
  }
  return null;
}

/** Advance the scanner one character. Returns true when an object just closed. */
function step(state: ScanState, char: string): boolean {
  if (state.inString) {
    if (state.escaped) state.escaped = false;
    else if (char === "\\") state.escaped = true;
    else if (char === '"') state.inString = false;
    return false;
  }
  if (char === '"') state.inString = true;
  else if (char === "{") state.depth++;
  else if (char === "}") state.depth--;
  return char === "}";
}
