import type { NotientSettings } from "../../core/settings/types";

export interface ModelVerbView {
  readonly endpoint: string;
  readonly chatModel: string;
  readonly embedModel: string;
  readonly contextTokens: number;
}

export interface ModelInfo {
  readonly id: string;
  readonly type: string;
  readonly state: "loaded" | "not-loaded";
  readonly loadedContextLength?: number;
  readonly maxContextLength?: number;
  readonly capabilities?: ReadonlyArray<string>;
}

/**
 * Project the relevant fields out of the live settings view so /model show
 * stays small and predictable. The "chat" model is the primary reasoning
 * slot; if the operator has fanned the slots manually the bare /model
 * command may misreport — they can always run /model show or read
 * config.json directly.
 */
export function buildModelView(settings: NotientSettings): ModelVerbView {
  return {
    endpoint: settings.primary.baseUrl,
    chatModel: settings.primary.reasoningModel,
    embedModel: settings.embedding.model,
    contextTokens: settings.chat.modelContextTokens,
  };
}

export function formatModelView(view: ModelVerbView): string {
  return [
    `model:    ${view.chatModel}`,
    `embed:    ${view.embedModel}`,
    `endpoint: ${view.endpoint}`,
    `context:  ${view.contextTokens.toLocaleString()} tok`,
  ].join("\n");
}

/**
 * Compose a settings patch that swaps the chat-model in every slot Notient
 * uses for reasoning, fast paths, reranking, and co-authoring. Tool-mode
 * pins are not touched here — the next chat turn will probe the new model
 * and write its tool-mode pin via the existing path.
 */
export function buildUseModelPatch(modelId: string): Partial<NotientSettings> {
  return {
    primary: {
      reasoningModel: modelId,
      fastModel: modelId,
      rerankerModel: modelId,
    } as NotientSettings["primary"],
    deep: {
      reasoningModel: modelId,
      fastModel: modelId,
      rerankerModel: modelId,
    } as NotientSettings["deep"],
    coAuthor: { model: modelId } as NotientSettings["coAuthor"],
  };
}

export function buildUseEmbedPatch(modelId: string): Partial<NotientSettings> {
  return {
    primary: { embeddingModel: modelId } as NotientSettings["primary"],
    deep: { embeddingModel: modelId } as NotientSettings["deep"],
    embedding: { model: modelId } as NotientSettings["embedding"],
  };
}

export function buildEndpointPatch(baseUrl: string): Partial<NotientSettings> {
  return {
    primary: { baseUrl } as NotientSettings["primary"],
    deep: { baseUrl } as NotientSettings["deep"],
    embedding: { baseUrl } as NotientSettings["embedding"],
  };
}

/**
 * Format the result of /api/v0/models as a tabular block: id, type, state,
 * loaded context length (humanized to k-tokens). Loaded models are pinned
 * to the top, then sorted by id.
 */
export function formatModelList(models: ReadonlyArray<ModelInfo>): string {
  if (models.length === 0) return "no models reported by endpoint.";
  const sorted = [...models].sort((a, b) => {
    if (a.state !== b.state) return a.state === "loaded" ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  const idWidth = sorted.reduce((max, m) => Math.max(max, m.id.length), 2);
  const typeWidth = sorted.reduce((max, m) => Math.max(max, m.type.length), 4);
  const stateWidth = "state".length;
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
