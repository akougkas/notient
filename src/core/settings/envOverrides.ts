import type { NotientSettings } from "./types";

/**
 * Environment variables Notient honors as in-memory overrides on top of the
 * persisted vault config. None of these write back to config.json — they
 * only affect the running process.
 *
 *   NOTIENT_LLM_BASE_URL    → primary/deep/embedding.baseUrl
 *   NOTIENT_LLM_MODEL       → primary.{reasoning,fast,reranker}Model,
 *                             deep.{reasoning,fast,reranker}Model,
 *                             coAuthor.model
 *   NOTIENT_EMBED_MODEL     → embedding.model + primary/deep.embeddingModel
 *   NOTIENT_CONTEXT_TOKENS  → chat.modelContextTokens (parsed as integer;
 *                             ignored if not a positive integer)
 */
export interface EnvSource {
  readonly NOTIENT_LLM_BASE_URL?: string;
  readonly NOTIENT_LLM_MODEL?: string;
  readonly NOTIENT_EMBED_MODEL?: string;
  readonly NOTIENT_CONTEXT_TOKENS?: string;
}

interface ResolvedEnv {
  baseUrl: string | null;
  model: string | null;
  embed: string | null;
  ctxTokens: number | null;
}

function resolveEnv(env: EnvSource): ResolvedEnv {
  return {
    baseUrl: nonEmpty(env.NOTIENT_LLM_BASE_URL),
    model: nonEmpty(env.NOTIENT_LLM_MODEL),
    embed: nonEmpty(env.NOTIENT_EMBED_MODEL),
    ctxTokens: parsePositiveInt(env.NOTIENT_CONTEXT_TOKENS),
  };
}

function isEmpty(resolved: ResolvedEnv): boolean {
  return (
    resolved.baseUrl === null &&
    resolved.model === null &&
    resolved.embed === null &&
    resolved.ctxTokens === null
  );
}

function overlayEndpoint(
  endpoint: NotientSettings["primary"],
  env: ResolvedEnv,
): NotientSettings["primary"] {
  return {
    ...endpoint,
    baseUrl: env.baseUrl ?? endpoint.baseUrl,
    reasoningModel: env.model ?? endpoint.reasoningModel,
    fastModel: env.model ?? endpoint.fastModel,
    rerankerModel: env.model ?? endpoint.rerankerModel,
    embeddingModel: env.embed ?? endpoint.embeddingModel,
  };
}

export function applyEnvOverrides(settings: NotientSettings, env: EnvSource): NotientSettings {
  const resolved = resolveEnv(env);
  if (isEmpty(resolved)) return settings;
  return {
    ...settings,
    primary: overlayEndpoint(settings.primary, resolved),
    deep: overlayEndpoint(settings.deep, resolved),
    embedding: {
      ...settings.embedding,
      baseUrl: resolved.baseUrl ?? settings.embedding.baseUrl,
      model: resolved.embed ?? settings.embedding.model,
    },
    coAuthor: {
      ...settings.coAuthor,
      model: resolved.model ?? settings.coAuthor.model,
    },
    chat: {
      ...settings.chat,
      modelContextTokens: resolved.ctxTokens ?? settings.chat.modelContextTokens,
    },
  };
}

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}
