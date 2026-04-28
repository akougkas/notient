import type { KeyBinding } from "@opentui/core";

/**
 * Custom keybindings for the chat input textarea: Enter submits, Shift+Enter
 * and Alt+Enter (delivered as meta+return on most terminals) insert a newline.
 * All other editing actions inherit from opentui's defaults.
 */
export function buildTextareaKeyBindings(): KeyBinding[] {
  return [
    { name: "return", action: "submit" },
    { name: "return", shift: true, action: "newline" },
    { name: "return", meta: true, action: "newline" },
  ];
}

/**
 * Compute the number of rows the input textarea should occupy for a given
 * buffer, terminal column count, and cap. Each logical line wraps to the
 * inner width and contributes ceil(length / width) rows; a trailing newline
 * reserves an empty row so the cursor remains visible. The result is always
 * clamped to [1, cap].
 */
export function computeInputHeight(value: string, terminalCols: number, cap: number): number {
  const width = terminalCols > 0 ? terminalCols : 1;
  const logicalLines = value.split("\n");
  let rows = 0;
  for (const line of logicalLines) {
    const wraps = line.length === 0 ? 1 : Math.ceil(line.length / width);
    rows += wraps;
  }
  if (rows < 1) rows = 1;
  if (rows > cap) rows = cap;
  return rows;
}
