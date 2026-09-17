import type { NotientSettings } from "../../core/settings/types";

export interface ModelVerbView {
  readonly endpoint: string;
  readonly chatModel: string;
  readonly embedModel: string;
  readonly contextTokens: number;
  readonly reasoningSlots: number;
  readonly requestedTotalContextTokens: number;
}

export interface ModelInfo {
  readonly id: string;
  readonly type: string;
  readonly state: "loaded" | "not-loaded" | "unknown";
  readonly loadedContextLength?: number;
  readonly maxContextLength?: number;
  readonly capabilities?: ReadonlyArray<string>;
}

/**
 * Project the deployment fields out of the daemon's immutable boot snapshot
 * so /model show reports the exact env/catalog resolution in current use.
 */
export function buildModelView(settings: NotientSettings): ModelVerbView {
  return {
    endpoint: settings.primary.baseUrl,
    chatModel: settings.primary.reasoningModel,
    embedModel: settings.embedding.model,
    contextTokens: settings.chat.modelContextTokens,
    reasoningSlots: settings.chat.reasoningSlots,
    requestedTotalContextTokens: settings.chat.modelContextTokens * settings.chat.reasoningSlots,
  };
}

export function formatModelView(view: ModelVerbView): string {
  return [
    `model:    ${view.chatModel}`,
    `embed:    ${view.embedModel}`,
    `endpoint: ${view.endpoint}`,
    `context:  ${view.contextTokens.toLocaleString()} tok`,
    `slots:    ${view.reasoningSlots.toLocaleString()} (${view.requestedTotalContextTokens.toLocaleString()} tok total)`,
  ].join("\n");
}

/**
 * Format the canonical endpoint catalog as a tabular block: id, type, state,
 * and known context length (humanized to k-tokens). Loaded models are pinned
 * above models whose load state is unknown, then unavailable models.
 */
export function formatModelList(models: ReadonlyArray<ModelInfo>): string {
  if (models.length === 0) return "no models reported by endpoint.";
  const sorted = [...models].sort((a, b) => {
    const stateOrder = { loaded: 0, unknown: 1, "not-loaded": 2 } as const;
    if (a.state !== b.state) return stateOrder[a.state] - stateOrder[b.state];
    return a.id.localeCompare(b.id);
  });
  const idWidth = sorted.reduce((max, m) => Math.max(max, m.id.length), 2);
  const typeWidth = sorted.reduce((max, m) => Math.max(max, m.type.length), 4);
  const stateWidth = sorted.reduce((max, m) => Math.max(max, m.state.length), "state".length);
  const ctxWidth = 10;
  const header = `${pad("id", idWidth)}  ${pad("type", typeWidth)}  ${pad("state", stateWidth)}  ${pad("context", ctxWidth)}`;
  const rule = "-".repeat(header.length);
  const rows = sorted.map((m) => {
    const ctx =
      m.state === "loaded" && m.loadedContextLength
        ? humanizeTokens(m.loadedContextLength)
        : m.maxContextLength
          ? `${humanizeTokens(m.maxContextLength)} max`
          : "-";
    return `${pad(m.id, idWidth)}  ${pad(m.type, typeWidth)}  ${pad(m.state, stateWidth)}  ${pad(ctx, ctxWidth)}`;
  });
  return [header, rule, ...rows].join("\n");
}

function pad(text: string, width: number): string {
  if (text.length >= width) return text;
  return text + " ".repeat(width - text.length);
}

function humanizeTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return `${n}`;
}
