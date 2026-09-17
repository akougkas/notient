import { isCanonicalOrdinaryNotePath } from "../../../src/core/vault/publicPath";

/** A selection bound to the exact saved revision it was taken from. Offsets are
 * UTF-16 offsets into the saved file, never into the editor's normalized text. */
export interface SelectionTarget {
  path: string;
  revision: string;
  start: number;
  end: number;
  text: string;
}
export type SelectionGate = { ok: true; target: SelectionTarget } | { ok: false; notice: string };

export const MAX_SELECTION = 16000;
const normalized = (value: string) => value.replace(/^\ufeff/, "").replaceAll("\r\n", "\n");

/** Map an editor offset to the saved file. Obsidian's editor drops a leading BOM
 * and holds every CRLF as one character; the saved file keeps both. */
export function savedOffset(saved: string, editorOffset: number): number {
  if (!Number.isInteger(editorOffset) || editorOffset < 0)
    throw new RangeError("editor offset must be a non-negative integer");
  let index = saved.startsWith("\ufeff") ? 1 : 0;
  for (let seen = 0; seen < editorOffset; seen++) {
    if (index >= saved.length) throw new RangeError("editor offset lies beyond the saved note");
    index += saved[index] === "\r" && saved[index + 1] === "\n" ? 2 : 1;
  }
  return index;
}

/** Decide whether a selection command may run, and bind it to the saved bytes. */
export async function gateSelection(input: {
  connected: boolean;
  path: string | null;
  saved: string | null;
  buffer: string;
  from: number;
  to: number;
  revision: (saved: string) => Promise<string>;
}): Promise<SelectionGate> {
  const refuse = (notice: string): SelectionGate => ({ ok: false, notice });
  if (!input.connected) return refuse("Reconnect Notient before working with a selection.");
  if (!input.path || !isCanonicalOrdinaryNotePath(input.path) || input.saved === null)
    return refuse("Open a saved Markdown note in this vault to work with a selection.");
  const [from, to] = input.from <= input.to ? [input.from, input.to] : [input.to, input.from];
  const text = input.buffer.slice(from, to);
  if (!text.trim()) return refuse("Select a passage in the editor first.");
  if (text.length > MAX_SELECTION)
    return refuse("Selection exceeds 16,000 characters; choose a smaller passage.");
  if (input.buffer !== normalized(input.saved))
    return refuse(
      "Save this note first. Notient works from the saved revision, and unsaved text is not part of it.",
    );
  const start = savedOffset(input.saved, from);
  const end = savedOffset(input.saved, to);
  if (normalized(input.saved.slice(start, end)) !== text)
    return refuse("The selection could not be matched to the saved note. Save and select again.");
  return {
    ok: true,
    target: { path: input.path, revision: await input.revision(input.saved), start, end, text },
  };
}

/** The passage is quoted as data after the person's own question. */
export function askQuery(question: string, target: Pick<SelectionTarget, "path" | "text">): string {
  const asked = question.trim() || "Explain this passage and how it fits the rest of the note.";
  const head = `${asked}\n\nFocus on this passage selected in ${target.path}:\n`;
  const room = 8192 - head.length - 8;
  if (room < 200) throw new Error("Shorten the question; it leaves no room for the passage.");
  const passage = target.text.trim();
  return `${head}"""\n${passage.length > room ? `${passage.slice(0, room - 1)}…` : passage}\n"""`;
}

/** Keep the saved file's line endings inside a replacement typed in the editor. */
export function replacementFor(saved: string, edited: string): string {
  const text = edited.replaceAll("\r\n", "\n");
  return saved.includes("\r\n") ? text.replaceAll("\n", "\r\n") : text;
}

export function editChangeSet(target: SelectionTarget, replacement: string, key: string) {
  return {
    idempotencyKey: key,
    changes: [
      {
        kind: "edit" as const,
        source: { path: target.path, revision: target.revision },
        selector: { kind: "range" as const, start: target.start, end: target.end },
        replacement,
      },
    ],
  };
}
