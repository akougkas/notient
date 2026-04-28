export interface StatusBarFields {
  readonly vaultPath: string;
  readonly topic: string;
  readonly model: string | null;
  readonly busy: boolean;
  readonly pendingCount: number;
  readonly lastTurnTokens: number | null;
}

export interface StatusSegments {
  readonly left: string;
  readonly right: string;
}

const SEPARATOR = " · ";

/**
 * Build the left and right halves of the status bar so opentui's
 * justify-content="space-between" can render them as a single row with the
 * dynamic counters anchored to the right.
 *
 * Left: brand, vault basename, conversation topic.
 * Right: state, pending approvals, token estimate, model name. Each piece is
 * dropped quietly when its source value is missing so the bar never shows
 * "model:?" or "pending:0" noise.
 */
export function buildStatusBar(fields: StatusBarFields): StatusSegments {
  const vaultLabel = fields.vaultPath.split("/").pop() ?? fields.vaultPath;
  const leftParts = ["notient", `vault:${vaultLabel}`];
  if (fields.topic.length > 0) leftParts.push(`topic:${fields.topic}`);

  const rightParts: string[] = [fields.busy ? "thinking…" : "idle"];
  if (fields.pendingCount > 0) rightParts.push(`pending:${fields.pendingCount}`);
  if (fields.lastTurnTokens !== null && fields.lastTurnTokens > 0) {
    rightParts.push(`~${fields.lastTurnTokens} tok`);
  }
  if (fields.model !== null && fields.model.length > 0) rightParts.push(fields.model);

  return {
    left: leftParts.join(SEPARATOR),
    right: rightParts.join(SEPARATOR),
  };
}

/**
 * Rough token count from a character buffer. Most tokenizers yield ~4 chars
 * per token for English prose, so this estimate is good enough for a status
 * line indicator and avoids loading a real tokenizer.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.round(text.length / 4));
}
