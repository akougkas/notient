import { validateBearerToken } from "../llm/bearerAuth";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_REASONING_SLOTS,
  type NotientConfig,
  type NotientSettings,
} from "./types";

/**
 * Deployment configuration. Vault `.notient/.env` values take precedence;
 * process environment values are used only for keys absent from that file.
 */
export interface EnvSource {
  readonly NOTIENT_LLM_BASE_URL?: string;
  readonly NOTIENT_EMBED_BASE_URL?: string;
  readonly NOTIENT_LLM_MODEL?: string;
  readonly NOTIENT_EMBED_MODEL?: string;
  readonly NOTIENT_LLM_API_KEY?: string;
  readonly NOTIENT_EMBED_API_KEY?: string;
  readonly NOTIENT_CONTEXT_TOKENS?: string;
  readonly NOTIENT_REASONING_SLOTS?: string;
}

export const NOTIENT_ENV_KEYS = [
  "NOTIENT_LLM_BASE_URL",
  "NOTIENT_EMBED_BASE_URL",
  "NOTIENT_LLM_MODEL",
  "NOTIENT_EMBED_MODEL",
  "NOTIENT_LLM_API_KEY",
  "NOTIENT_EMBED_API_KEY",
  "NOTIENT_CONTEXT_TOKENS",
  "NOTIENT_REASONING_SLOTS",
] as const satisfies ReadonlyArray<keyof EnvSource>;

/**
 * Select recognized deployment keys with vault-file precedence. Presence in
 * the vault file wins even when its value is empty; this lets an operator mask
 * an ambient process variable that Bun loaded from another working directory.
 */
export function mergeEnvSources(
  fileEnv: Readonly<Record<string, string | undefined>>,
  processEnv: Readonly<Record<string, string | undefined>>,
): EnvSource {
  const result: Partial<Record<keyof EnvSource, string>> = {};
  for (const key of NOTIENT_ENV_KEYS) {
    const fileOwnsKey = Object.prototype.hasOwnProperty.call(fileEnv, key);
    const raw = fileOwnsKey ? fileEnv[key] : processEnv[key];
    if (key === "NOTIENT_LLM_API_KEY" || key === "NOTIENT_EMBED_API_KEY") {
      // Preserve explicit emptiness for credentials. An empty embedding key
      // means "send no Authorization header" even when the chat key is set.
      // Non-secret deployment values use their canonical trim semantics.
      if (raw !== undefined) result[key] = raw;
      continue;
    }
    const selected = nonEmpty(raw);
    if (selected !== null) result[key] = selected;
  }
  return result;
}

/** Private endpoint credentials. This object must never cross a daemon RPC. */
export interface ProviderCredentials {
  readonly chatApiKey?: string;
  readonly embeddingApiKey?: string;
}

/**
 * Resolve endpoint credentials independently from the public settings
 * snapshot. The embedding token inherits the chat token only when its own env
 * key is absent; an explicitly empty embedding key disables that inheritance.
 */
export function resolveProviderCredentials(env: EnvSource): ProviderCredentials {
  const chatApiKey = optionalBearerToken("NOTIENT_LLM_API_KEY", env.NOTIENT_LLM_API_KEY);
  const embeddingApiKey =
    env.NOTIENT_EMBED_API_KEY === undefined
      ? chatApiKey
      : optionalBearerToken("NOTIENT_EMBED_API_KEY", env.NOTIENT_EMBED_API_KEY);
  return {
    ...(chatApiKey === undefined ? {} : { chatApiKey }),
    ...(embeddingApiKey === undefined ? {} : { embeddingApiKey }),
  };
}

/**
 * Resolve the validated product config and deployment environment into the
 * process-local settings shape. Deployment fields have no persisted fallback.
 */
export function resolveSettings(config: NotientConfig, env: EnvSource): NotientSettings {
  const baseUrl = nonEmpty(env.NOTIENT_LLM_BASE_URL) ?? "";
  const embeddingBaseUrl = nonEmpty(env.NOTIENT_EMBED_BASE_URL) ?? baseUrl;
  const reasoningModel = nonEmpty(env.NOTIENT_LLM_MODEL) ?? "";
  const embeddingModel = nonEmpty(env.NOTIENT_EMBED_MODEL) ?? "";
  const modelContextTokens = parsePositiveInteger(
    "NOTIENT_CONTEXT_TOKENS",
    env.NOTIENT_CONTEXT_TOKENS,
    DEFAULT_CONTEXT_TOKENS,
    10_000_000,
  );
  const reasoningSlots = parsePositiveInteger(
    "NOTIENT_REASONING_SLOTS",
    env.NOTIENT_REASONING_SLOTS,
    DEFAULT_REASONING_SLOTS,
    128,
  );

  return {
    ...config,
    primary: { baseUrl, reasoningModel },
    deep: {
      baseUrl,
      reasoningModel,
      rerankerModel: reasoningModel,
    },
    embedding: { baseUrl: embeddingBaseUrl, model: embeddingModel },
    chat: {
      ...config.chat,
      modelContextTokens,
      reasoningSlots,
    },
  };
}

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function optionalBearerToken(key: keyof EnvSource, value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  return validateBearerToken(value, key);
}

function parsePositiveInteger(
  key: keyof EnvSource,
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const selected = nonEmpty(value);
  if (selected === null) return fallback;
  if (!/^[1-9]\d*$/.test(selected)) {
    throw new Error(
      `notient: ${key}: expected a positive base-10 integer, received ${JSON.stringify(value)}`,
    );
  }
  const parsed = Number(selected);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`notient: ${key}: expected an integer between 1 and ${maximum}`);
  }
  return parsed;
}
