import type { NotientSettings } from "../settings/types";
import {
  assertBearerTokenAbsent,
  endpointRequestHeaders,
  redactBearerToken,
  validateBearerToken,
} from "./bearerAuth";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface EndpointModel {
  id: string;
  type: "chat" | "embedding" | "unknown";
  state: "loaded" | "not-loaded" | "unknown";
  loadedContextLength: number | null;
  maxContextLength?: number;
  capabilities?: ReadonlyArray<string>;
}

export interface EndpointModelCatalog {
  models: EndpointModel[];
  source: "lmstudio-native" | "openai-compatible";
}

export interface ModelSelection {
  chatModel: string;
  embeddingModel: string;
  reason: string;
  warnings: string[];
}

/**
 * Default ceiling on each catalog request. The daemon runs this before it binds
 * its socket, so an endpoint that accepts the connection but never answers
 * (a stale Tailscale or LAN address, say) would otherwise wedge startup
 * forever with nothing written to the log.
 */
export const MODEL_CATALOG_TIMEOUT_MS = 10_000;

export async function fetchEndpointModelCatalog(input: {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<EndpointModelCatalog> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? MODEL_CATALOG_TIMEOUT_MS;
  const urls = catalogUrls(input.baseUrl);
  const apiKey =
    input.apiKey === undefined
      ? undefined
      : validateBearerToken(input.apiKey, "model endpoint apiKey");

  try {
    // The configured OpenAI-compatible endpoint is the deployment authority.
    // Validate it first and never replace it with a guessed native endpoint.
    const openai = await requestCatalog(fetchImpl, urls.openAi, apiKey, input.signal, timeoutMs);
    if (!openai.ok) {
      throw new Error(
        `OpenAI model catalog request failed at ${urls.openAi}: HTTP ${openai.status} ${openai.statusText}`,
      );
    }
    const openAiPayload = openai.payload;
    assertBearerTokenAbsent(openAiPayload, apiKey, "OpenAI model catalog");
    const openAiCatalog: EndpointModelCatalog = {
      source: "openai-compatible",
      models: parseOpenAiCatalog(openAiPayload),
    };

    // LM Studio's native catalog is optional enrichment. A precise 404 means
    // this OpenAI-compatible server is not LM Studio; every other response is
    // authoritative and therefore must satisfy the native wire contract.
    const native = await requestCatalog(
      fetchImpl,
      urls.lmStudioNative,
      apiKey,
      input.signal,
      timeoutMs,
    );
    if (native.status === 404) return openAiCatalog;
    if (!native.ok) {
      throw new Error(
        `LM Studio native model catalog request failed at ${urls.lmStudioNative}: HTTP ${native.status} ${native.statusText}`,
      );
    }
    const nativePayload = native.payload;
    assertBearerTokenAbsent(nativePayload, apiKey, "LM Studio native model catalog");
    return {
      source: "lmstudio-native",
      models: parseNativeCatalog(nativePayload),
    };
  } catch (error) {
    const message = redactBearerToken(
      error instanceof Error ? error.message : String(error),
      apiKey,
    );
    const redacted = new Error(message);
    if (error instanceof Error) redacted.name = error.name;
    throw redacted;
  }
}

function catalogUrls(baseUrl: string): {
  openAi: string;
  lmStudioNative: string;
} {
  if (baseUrl.length === 0 || baseUrl.trim() !== baseUrl) {
    throw new Error("model endpoint must be a canonical nonblank URL ending in /v1");
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("model endpoint is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("model endpoint must use http or https");
  }
  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    !parsed.pathname.endsWith("/v1")
  ) {
    throw new Error(
      "model endpoint must be the canonical OpenAI-compatible base URL ending in /v1",
    );
  }

  const root = baseUrl.slice(0, -"/v1".length);
  return {
    openAi: `${baseUrl}/models`,
    lmStudioNative: `${root}/api/v0/models`,
  };
}

async function requestCatalog(
  fetchImpl: FetchLike,
  url: string,
  apiKey: string | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Pick<Response, "ok" | "status" | "statusText"> & { payload: unknown }> {
  const request = withTimeout(signal, timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: endpointRequestHeaders(apiKey, "none"),
      signal: request.signal,
    });
    // Keep the deadline armed until the body has been consumed. Headers alone
    // do not establish a usable catalog; a stalled body must not wedge startup.
    const payload = response.ok ? await readCatalogJson(response, "model", url) : null;
    if (!response.ok) await response.body?.cancel();
    return { ok: response.ok, status: response.status, statusText: response.statusText, payload };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`model catalog request failed at ${url}: ${redactBearerToken(reason, apiKey)}`);
  } finally {
    request.dispose();
  }
}

async function readCatalogJson(response: Response, kind: string, url: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${kind} model catalog at ${url} is not valid JSON: ${reason}`);
  }
}

/**
 * Pairs the caller's signal (if any) with a deadline. The timer is cleared via
 * `dispose` so a fast probe does not hold the event loop open.
 */
function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  const onAbort = (): void => controller.abort(signal?.reason);
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Pick the chat and embedding model ids the daemon will actually send.
 *
 * The rules are deliberately endpoint-agnostic. A llama.cpp router exposes
 * aliases that resolve server-side, Ollama appends `:latest` tags, and LM
 * Studio reports load state that neither of the others has. Treating the
 * catalog as authoritative therefore breaks two of the three, so a configured
 * id always wins and an unknown configured id is passed through rather than
 * rejected. Discovery only has to work when nothing is configured at all.
 */
export function resolveEndpointModels(input: {
  settings: NotientSettings;
  catalog: EndpointModelCatalog;
  embeddingCatalog?: EndpointModelCatalog;
}): ModelSelection {
  const embeddingCatalog = input.embeddingCatalog ?? input.catalog;
  const chat = chooseModel({
    configured: input.settings.primary.reasoningModel,
    catalog: input.catalog,
    kind: "chat",
  });
  const embedding = chooseModel({
    configured: input.settings.embedding.model,
    catalog: embeddingCatalog,
    kind: "embedding",
  });

  if (chat.model === null || embedding.model === null) {
    const parts: string[] = [];
    if (chat.model === null) parts.push(ambiguityDetail("chat", input.catalog));
    if (embedding.model === null) parts.push(ambiguityDetail("embedding", embeddingCatalog));
    throw new Error(
      [
        "notient: cannot determine which model to use and none is configured.",
        "Set NOTIENT_LLM_MODEL and NOTIENT_EMBED_MODEL in .notient/.env",
        "or expose exactly one compatible model on the endpoint.",
        ...parts,
      ].join(" "),
    );
  }

  return {
    chatModel: chat.model,
    embeddingModel: embedding.model,
    reason: [chat.reason, embedding.reason].join("; "),
    warnings: [...chat.warnings, ...embedding.warnings],
  };
}

function ambiguityDetail(kind: "chat" | "embedding", catalog: EndpointModelCatalog): string {
  const compatible = catalog.models.filter((model) => isCompatibleKind(model, kind));
  if (compatible.length === 0) {
    return `No compatible ${kind} model was found in the endpoint catalog (${describeCatalog(catalog)}).`;
  }
  return `Ambiguous ${kind} candidates: ${compatible.map((model) => model.id).join(", ")}.`;
}

function describeCatalog(catalog: EndpointModelCatalog): string {
  if (catalog.models.length === 0) return "catalog empty";
  return `catalog: ${catalog.models.map((model) => model.id).join(", ")}`;
}

export function applyResolvedModels(
  settings: NotientSettings,
  selection: ModelSelection,
): NotientSettings {
  return {
    ...settings,
    primary: {
      ...settings.primary,
      reasoningModel: selection.chatModel,
    },
    deep: {
      ...settings.deep,
      reasoningModel: selection.chatModel,
      rerankerModel: selection.chatModel,
    },
    embedding: {
      ...settings.embedding,
      model: selection.embeddingModel,
    },
  };
}

/**
 * Selection rules, in order:
 *   (a) configured id is present exactly in the catalog -> use it.
 *   (b) configured id is set but absent from the catalog -> use it verbatim
 *       and warn. Router aliases and lazily-listed models make catalogs
 *       unreliable, so an absent id is not an error.
 *   (c) nothing configured and exactly one compatible candidate -> use it.
 *   (d) nothing configured and the candidate set is empty or ambiguous ->
 *       return null so the caller can throw with the catalog listed.
 *
 * For an LM Studio catalog the candidate pool narrows to already-loaded
 * models when any are loaded, so discovery never cold-loads a second model
 * onto the user's GPU.
 */
function chooseModel(input: {
  configured: string;
  catalog: EndpointModelCatalog;
  kind: "chat" | "embedding";
}): { model: string | null; reason: string; warnings: string[] } {
  const { kind } = input;
  const compatible = input.catalog.models.filter((model) => isCompatibleKind(model, kind));
  const configured = input.configured;

  if (configured.length > 0) {
    const match = compatible.find((model) => model.id === configured);
    if (match !== undefined) {
      return {
        model: match.id,
        reason: `${kind}: configured model ${configured} is present in the endpoint catalog`,
        warnings: [],
      };
    }
    return {
      model: configured,
      reason: `${kind}: using configured model ${configured} verbatim`,
      warnings: [
        `${kind}: configured model ${configured} is not listed by the endpoint; sending it anyway (${describeCatalog(input.catalog)})`,
      ],
    };
  }

  const loaded = compatible.filter((model) => model.state === "loaded");
  const pool =
    input.catalog.source === "lmstudio-native" && loaded.length > 0 ? loaded : compatible;
  const only = pool.length === 1 ? pool[0] : undefined;
  if (only !== undefined) {
    return {
      model: only.id,
      reason: `${kind}: no model configured; endpoint exposes exactly one compatible model (${only.id})`,
      warnings: [],
    };
  }
  return {
    model: null,
    reason: `${kind}: no model configured and no unambiguous candidate`,
    warnings: [],
  };
}

function parseOpenAiCatalog(raw: unknown): EndpointModel[] {
  const envelope = requireRecord(raw, "OpenAI model catalog");
  if (envelope.object !== "list") {
    throw new Error('OpenAI model catalog.object must be "list"');
  }
  const rows = requireArray(envelope.data, "OpenAI model catalog.data");
  const models = rows.map((row, index): EndpointModel => {
    const record = requireRecord(row, `OpenAI model catalog.data[${index}]`);
    const id = requireCanonicalString(record.id, `OpenAI model catalog.data[${index}].id`);
    if (record.object !== "model") {
      throw new Error(`OpenAI model catalog.data[${index}].object must be \"model\"`);
    }
    if (Object.hasOwn(record, "created")) {
      requireNonnegativeInteger(record.created, `OpenAI model catalog.data[${index}].created`);
    }
    if (Object.hasOwn(record, "owned_by")) {
      requireCanonicalString(record.owned_by, `OpenAI model catalog.data[${index}].owned_by`);
    }
    return {
      id,
      type: looksEmbeddingModel(id) ? "embedding" : "unknown",
      state: "unknown",
      loadedContextLength: null,
    };
  });
  requireUniqueModelIds(models, "OpenAI model catalog");
  return models;
}

function parseNativeCatalog(raw: unknown): EndpointModel[] {
  const envelope = requireRecord(raw, "LM Studio native model catalog");
  if (Object.hasOwn(envelope, "object") && envelope.object !== "list") {
    throw new Error('LM Studio native model catalog.object must be "list" when present');
  }
  const rows = requireArray(envelope.data, "LM Studio native model catalog.data");
  const models = rows.map((row, index): EndpointModel => {
    const label = `LM Studio native model catalog.data[${index}]`;
    const record = requireRecord(row, label);
    const id = requireCanonicalString(record.id, `${label}.id`);
    const nativeType = requireCanonicalString(record.type, `${label}.type`);
    if (Object.hasOwn(record, "object") && record.object !== "model") {
      throw new Error(`${label}.object must be \"model\" when present`);
    }
    if (record.state !== "loaded" && record.state !== "not-loaded") {
      throw new Error(`${label}.state must be \"loaded\" or \"not-loaded\"`);
    }
    const loadedContextLength = optionalPositiveInteger(
      record,
      "loaded_context_length",
      `${label}.loaded_context_length`,
    );
    if (record.state === "loaded" && loadedContextLength === null) {
      throw new Error(`${label}.loaded_context_length is required when state is \"loaded\"`);
    }
    const maxContextLength = optionalPositiveInteger(
      record,
      "max_context_length",
      `${label}.max_context_length`,
    );
    const capabilities = optionalCanonicalStringArray(
      record,
      "capabilities",
      `${label}.capabilities`,
    );
    return {
      id,
      type: parseNativeModelType(nativeType),
      state: record.state,
      loadedContextLength,
      ...(maxContextLength === null ? {} : { maxContextLength }),
      ...(capabilities === null ? {} : { capabilities }),
    };
  });
  requireUniqueModelIds(models, "LM Studio native model catalog");
  return models;
}

function parseNativeModelType(value: string): EndpointModel["type"] {
  if (value === "embedding" || value === "embeddings") return "embedding";
  if (value === "llm" || value === "vlm") return "chat";
  return "unknown";
}

function requireRecord(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${label} must be an object`);
  }
  return raw as Record<string, unknown>;
}

function requireArray(raw: unknown, label: string): unknown[] {
  if (!Array.isArray(raw)) throw new Error(`${label} must be an array`);
  return raw;
}

function requireCanonicalString(raw: unknown, label: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.trim() !== raw) {
    throw new Error(`${label} must be a canonical nonblank string`);
  }
  return raw;
}

function requireNonnegativeInteger(raw: unknown, label: string): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
  return raw;
}

function optionalPositiveInteger(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number | null {
  if (!Object.hasOwn(record, key) || record[key] === null) return null;
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer or null`);
  }
  return value;
}

function optionalCanonicalStringArray(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string[] | null {
  if (!Object.hasOwn(record, key)) return null;
  const values = requireArray(record[key], label);
  return values.map((value, index) => requireCanonicalString(value, `${label}[${index}]`));
}

function requireUniqueModelIds(models: ReadonlyArray<EndpointModel>, label: string): void {
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.id)) throw new Error(`${label} contains duplicate model id ${model.id}`);
    seen.add(model.id);
  }
}

function isCompatibleKind(model: EndpointModel, kind: "chat" | "embedding"): boolean {
  if (model.type === kind) return true;
  if (model.type !== "unknown") return false;
  return kind === "embedding" ? looksEmbeddingModel(model.id) : !looksEmbeddingModel(model.id);
}

function looksEmbeddingModel(id: string): boolean {
  return /\b(embed|embedding|bge|nomic|e5|gte)\b/i.test(id);
}
