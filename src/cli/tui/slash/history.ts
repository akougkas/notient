import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { latestUndoId } from "../../commands/history";
import { createRpc } from "../rpc";
import { formatError } from "./rpc";
import type { SlashContext, SlashOutcome } from "./types";

export async function rpcUndo(context: SlashContext, historyId?: string): Promise<SlashOutcome> {
  try {
    const rpc = createRpc(context.client);
    const id = historyId ?? (await latestUndoId(context.client));
    if (!id) return { message: "No reversible history." };
    const detail = await rpc.historyEntry(id);
    const result = await rpc.undoHistory({
      id,
      sources: detail.sources,
      idempotencyKey: `undo:${id}`,
    });
    return { message: `Restored: ${result.entry.target}. The original change remains in history.` };
  } catch (error) {
    return { message: `undo error: ${formatError(error)}` };
  }
}

export async function rpcHistory(context: SlashContext): Promise<SlashOutcome> {
  try {
    const result = await createRpc(context.client).historyList(10);
    if (result.entries.length === 0) return { message: "history: (empty)" };
    const lines = result.entries.map(
      (entry) =>
        `${entry.id}  ${entry.kind}  ${entry.target}  ${new Date(entry.createdAt).toISOString()}${entry.undo?.completedAt != null ? " · undone" : entry.undo ? " · undo interrupted" : ""}`,
    );
    return { message: lines.join("\n") };
  } catch (error) {
    return { message: `history error: ${formatError(error)}` };
  }
}

export async function copyLastAssistant(context: SlashContext): Promise<SlashOutcome> {
  const text = context.getLastAssistant?.() ?? null;
  if (text === null || text.length === 0) {
    return { message: "/copy: no reply from your notes yet to copy." };
  }
  const target = join(context.vaultPath, ".notient", "last.txt");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  return { message: `Copied ${text.length} chars → ${target}` };
}
