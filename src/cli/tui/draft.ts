import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ChangePreview } from "../../api/changes";
import { type NoteDraft, draftSchema } from "../../api/drafts";
import { vaultStateDir } from "../../core/vault/identity";
import { readPrivateJson, writePrivateJson } from "../../daemon/ipcSecurity";

export interface WritingRequest {
  path?: string;
  text?: string;
  title?: string;
}
/** Only local drafts live here. Saving a note always goes through changes.apply. */
export class DraftStore {
  private tail: Promise<void> = Promise.resolve();
  readonly path: string;
  constructor(vaultPath: string, identity: string) {
    const key = createHash("sha256").update(identity).digest("hex").slice(0, 16);
    this.path = join(vaultStateDir(vaultPath), `tui-draft-${key}.json`);
  }
  async load(): Promise<NoteDraft | null> {
    await this.tail;
    try {
      return draftSchema.nullable().parse(await readPrivateJson(this.path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async save(draft: NoteDraft | null): Promise<void> {
    const value = draftSchema.nullable().parse(draft);
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > 1048576)
      throw new Error(
        "This draft is too large to recover locally. Shorten it before leaving the editor.",
      );
    const next = this.tail.catch(() => {}).then(() => writePrivateJson(this.path, value));
    this.tail = next;
    return next;
  }
}

/** One exact changed region with context, rendered by OpenTUI's native diff. */
export function previewDiff(preview: ChangePreview): string {
  return preview.effects
    .map((effect) => {
      const before = diffLines(effect.before ?? "");
      const after = diffLines(effect.after);
      let head = 0;
      while (head < before.length && head < after.length && before[head] === after[head]) head++;
      let tail = 0;
      while (
        tail < before.length - head &&
        tail < after.length - head &&
        before[before.length - 1 - tail] === after[after.length - 1 - tail]
      )
        tail++;
      const start = Math.max(0, head - 2);
      const ending = Math.min(2, tail);
      const lines = [
        ...before.slice(start, head).map((line) => diffLine(" ", line)),
        ...before.slice(head, before.length - tail).map((line) => diffLine("-", line)),
        ...after.slice(head, after.length - tail).map((line) => diffLine("+", line)),
        ...after
          .slice(after.length - tail, after.length - tail + ending)
          .map((line) => diffLine(" ", line)),
      ];
      const beforeCount = before.length - tail - start + ending;
      const afterCount = after.length - tail - start + ending;
      return `--- ${effect.before === null ? "/dev/null" : `a/${effect.path}`}\n+++ b/${effect.path}\n@@ -${start + (beforeCount > 0 ? 1 : 0)},${beforeCount} +${start + (afterCount > 0 ? 1 : 0)},${afterCount} @@\n${lines.join("\n")}\n`;
    })
    .join("\n");
}

function diffLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function diffLine(prefix: string, line: string): string {
  return line.endsWith("\n")
    ? prefix + line.slice(0, -1)
    : `${prefix}${line}\n\\ No newline at end of file`;
}
