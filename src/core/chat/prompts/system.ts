/**
 * Eight-layer system prompt composer for the chat agent loop.
 *
 * Each call to {@link composeSystemPrompt} produces the single string injected
 * as the `system` message at the top of the conversation. Sections render only
 * when their backing layer is non-empty so the LLM never sees `# User profile`
 * with nothing under it.
 *
 * The eight layers, in order:
 *   1. Identity                — Notient persona, never elided.
 *   2. User profile + voice    — extends-the-user voice when known.
 *   3. Vault snapshot          — counts of notes, edges, pending proposals.
 *   4. Workspace state         — active note, open notes, recent views, recent searches.
 *   5. Pinned context          — body of conversation-pinned notes (token-elided).
 *   6. Cross-session memory    — top-K prior conversations by cosine similarity.
 *   7. Approval mode + rules   — safe vs. yolo behaviour reminders.
 *   8. Tool catalog            — names + descriptions of registered tools.
 */

export interface SystemPromptInput {
  identity: string;
  userProfile: string;
  vaultSnapshot: string;
  workspaceState: string;
  pinnedContext: string;
  crossSessionMemory: string;
  approvalMode: "safe" | "yolo";
  tools: { name: string; description: string }[];
}

export const NOTIENT_IDENTITY = `You are Notient. You are a second-brain companion living inside the user's Obsidian vault. You read, search, reason, and stage proposals. You never write to a note without explicit user approval. In YOLO mode you write immediately, but every action is undoable. You speak in the user's voice when extending their notes. You stay neutral when summarizing or comparing across notes. You always ground claims in retrieved chunks.`;

export function composeSystemPrompt(input: SystemPromptInput): string {
  const sections: string[] = [];
  sections.push("# Identity");
  sections.push(input.identity);
  if (input.userProfile.trim().length > 0) {
    sections.push(`# User profile\n${input.userProfile.trim()}`);
  }
  if (input.vaultSnapshot.trim().length > 0) {
    sections.push(`# Vault snapshot\n${input.vaultSnapshot.trim()}`);
  }
  if (input.workspaceState.trim().length > 0) {
    sections.push(`# Workspace\n${input.workspaceState.trim()}`);
  }
  if (input.pinnedContext.trim().length > 0) {
    sections.push(`# Pinned context\n${input.pinnedContext.trim()}`);
  }
  if (input.crossSessionMemory.trim().length > 0) {
    sections.push(`# Earlier conversations\n${input.crossSessionMemory.trim()}`);
  }
  sections.push(`# Approval mode\n${approvalModeBlock(input.approvalMode)}`);
  if (input.tools.length > 0) {
    const lines = input.tools.map((entry) => `- ${entry.name}: ${entry.description}`).join("\n");
    sections.push(`# Tools available\n${lines}`);
  }
  sections.push(
    "# Rules\n" +
      "- Cite [[note]] for every claim drawn from a note.\n" +
      "- Prefer one search call followed by one or two read calls. Avoid redundant tool invocations.\n" +
      "- When uncertain, ask a clarifying question rather than guessing.",
  );
  return sections.join("\n\n");
}

function approvalModeBlock(mode: "safe" | "yolo"): string {
  if (mode === "yolo") {
    return "User has enabled YOLO mode. Write actions execute immediately. Every action is undoable, but still confirm before destructive operations.";
  }
  return "User must approve every write action. Show the diff before requesting approval.";
}
