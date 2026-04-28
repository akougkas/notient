export type AssistantSegment =
  | { readonly type: "prose"; readonly text: string }
  | { readonly type: "code"; readonly lang: string; readonly text: string };

const FENCE_PATTERN = /^```(\S*)\s*$/;

/**
 * Split an assistant message into prose and fenced code segments.
 *
 * Triple-backtick fences open and close on their own lines. The content
 * between the opening and closing fence becomes a code segment that retains
 * the language tag (or the empty string when none is given). An unterminated
 * fence treats the rest of the message as code so partial streaming output
 * still renders sensibly.
 *
 * Empty prose segments are dropped; empty code segments are kept so the
 * caller can still show the box when the model emits a bare fence.
 */
export function parseAssistantText(text: string): AssistantSegment[] {
  const segments: AssistantSegment[] = [];
  const lines = text.split("\n");
  let proseBuffer: string[] = [];
  let codeBuffer: string[] = [];
  let codeLang = "";
  let inCode = false;

  const flushProse = (): void => {
    if (proseBuffer.length === 0) return;
    const joined = proseBuffer.join("\n");
    if (joined.length > 0) segments.push({ type: "prose", text: joined });
    proseBuffer = [];
  };

  const flushCode = (): void => {
    segments.push({ type: "code", lang: codeLang, text: codeBuffer.join("\n") });
    codeBuffer = [];
    codeLang = "";
  };

  for (const line of lines) {
    if (!inCode) {
      const fence = line.match(FENCE_PATTERN);
      if (fence) {
        flushProse();
        inCode = true;
        codeLang = fence[1] ?? "";
        continue;
      }
      proseBuffer.push(line);
      continue;
    }
    if (FENCE_PATTERN.test(line)) {
      flushCode();
      inCode = false;
      continue;
    }
    codeBuffer.push(line);
  }

  if (inCode) flushCode();
  flushProse();
  return segments;
}
