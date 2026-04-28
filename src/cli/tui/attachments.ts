/**
 * Tab-driven @-completion for the TUI input bar.
 *
 * The TUI's tab handler (runtime.tsx) calls completeAtMention when the
 * input buffer's last whitespace-separated run begins with @. The helper
 * parses the partial into {folder, partial}, calls the daemon's vault.list
 * RPC for up to five matches, replaces the partial with the first match in
 * place, and surfaces the next four matches as a system hint line.
 */

import type { ClientHandle, RpcResponseFrame } from "../client";

export interface AtMentionContext {
  client: ClientHandle;
}

export async function completeAtMention(
  partialAfterAt: string,
  fullBuffer: string,
  spaceIndex: number,
  setBuffer: (next: string) => void,
  appendSystemLine: (text: string) => void,
  context: AtMentionContext,
): Promise<void> {
  const lastSlash = partialAfterAt.lastIndexOf("/");
  const folder = lastSlash < 0 ? "" : partialAfterAt.slice(0, lastSlash);
  const filter = lastSlash < 0 ? partialAfterAt : partialAfterAt.slice(lastSlash + 1);
  const result = await drainResult(context.client.call("vault.list", { folder, filter, limit: 5 }));
  if (!result || result.type !== "result") return;
  const detail = result as unknown as { paths?: string[] };
  const paths = detail.paths ?? [];
  if (paths.length === 0) {
    appendSystemLine(`no completions for @${partialAfterAt}`);
    return;
  }
  const first = paths[0];
  const completedToken = `@${folder.length > 0 ? `${folder}/` : ""}${first}`;
  const prefix = spaceIndex < 0 ? "" : `${fullBuffer.slice(0, spaceIndex + 1)}`;
  setBuffer(`${prefix}${completedToken}`);
  if (paths.length > 1) {
    appendSystemLine(`hints: ${paths.slice(1, 5).join("  ")}`);
  }
}

async function drainResult(
  stream: AsyncIterable<RpcResponseFrame>,
): Promise<RpcResponseFrame | null> {
  for await (const frame of stream) {
    if (frame.type === "result" || frame.type === "error") return frame;
  }
  return null;
}
