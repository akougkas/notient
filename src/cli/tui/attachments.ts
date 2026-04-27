/**
 * @-completion stub for the TUI input bar.
 *
 * Phase C ships without the `vault.list` RPC handler that this helper
 * targets — that surface lands in Phase D as part of the full vault.exec
 * suite. The file is in place so the input layer does not need rewriting
 * once the RPC arrives. Until then, users type `@<path>` themselves and the
 * daemon resolves it inside `chat.send` via the agent's attachments
 * resolver.
 */

import type { ClientHandle } from "../client";

export async function completeMention(client: ClientHandle, prefix: string): Promise<string[]> {
  if (prefix.length === 0) return [];
  let matches: string[] = [];
  for await (const frame of client.call("vault.list", { prefix })) {
    if (frame.type === "result") {
      const detail = frame as unknown as { paths?: string[] };
      matches = (detail.paths ?? []).slice(0, 20);
      break;
    }
    if (frame.type === "error") return [];
  }
  return matches;
}
