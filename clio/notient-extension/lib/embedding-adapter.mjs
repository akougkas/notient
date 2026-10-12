import { normalizeEmbeddings, embeddingSpace } from './embedding-config.mjs';
import { refuse, validText } from './paths.mjs';
import { revision } from './paths.mjs';
import { readConfig } from './config.mjs';

const cap = 16 * 1024 * 1024;
export function configuredAdapter(vault, directory) {
  const config = readConfig(directory);
  const selected = config.vaults.find(value => value.id === vault.id && value.path === vault.path);
  if (!selected?.embeddings || !config.embeddings) refuse('EMBEDDING_OFF', 'This vault has no enabled embedding profile.');
  const fingerprint = revision(JSON.stringify([config.embeddings, selected]));
  return createOpenAIAdapter(config.embeddings, { isCurrent: () => {
    const current = readConfig(directory);
    return revision(JSON.stringify([current.embeddings, current.vaults.find(value => value.id === vault.id && value.path === vault.path)])) === fingerprint;
  } });
}
export function responseVectors(body, count, dimension) {
  if (!body || !Array.isArray(body.data) || body.data.length !== count) refuse('EMBEDDING_RESPONSE_INVALID', 'Embedding response has an invalid result count.');
  const vectors = Array(count);
  for (const item of body.data) {
    if (!item || !Number.isInteger(item.index) || item.index < 0 || item.index >= count || vectors[item.index] !== undefined || !Array.isArray(item.embedding)) refuse('EMBEDDING_RESPONSE_INVALID', 'Embedding response indices are incomplete or duplicated.');
    if (item.embedding.length !== dimension) refuse('EMBEDDING_STALE_MODEL', 'Embedding response dimension differs from the pinned configuration.');
    if (!item.embedding.every(value => typeof value === 'number' && Number.isFinite(value)) || !item.embedding.some(value => value !== 0)) refuse('EMBEDDING_RESPONSE_INVALID', 'Embedding response contains a nonfinite or zero vector.');
    vectors[item.index] = item.embedding;
  }
  if (vectors.filter(Array.isArray).length !== count) refuse('EMBEDDING_RESPONSE_INVALID', 'Embedding response indices are incomplete.');
  return vectors;
}

export function createOpenAIAdapter(configuration, { probe = false, isCurrent = () => true } = {}) {
  const profile = normalizeEmbeddings(configuration);
  if (!profile) refuse('EMBEDDING_OFF', 'Embedding configuration is unavailable.');
  let active = false;
  const describe = () => ({ provider: 'openai-compatible', model: profile.model, responseModel: profile.responseModel, dimension: profile.dimension, spaceId: embeddingSpace(profile), maxBatch: profile.batch, maxInputBytes: profile.maxInputBytes });
  return {
    describe,
    async embed(texts, { signal } = {}) {
      if (active) refuse('EMBEDDING_BUSY', 'Only one embedding request may be active per adapter.', [], true);
      if (!Array.isArray(texts) || !texts.length || texts.length > profile.batch) refuse('EMBEDDING_INPUT_LIMIT', 'Embedding batch exceeds the configured count bound.');
      for (const text of texts) { validText(text, 'Embedding input'); if (Buffer.byteLength(text) > profile.maxInputBytes) refuse('EMBEDDING_INPUT_LIMIT', 'Embedding input exceeds the configured byte bound.'); }
      if (!isCurrent()) refuse('EMBEDDING_CONFIG_CHANGED', 'Embedding configuration changed before inference.', [], true);
      active = true;
      const timeout = AbortSignal.timeout(profile.timeoutMs);
      const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`;
        const response = await fetch(`${profile.baseUrl}/embeddings`, { method: 'POST', headers, body: JSON.stringify({ model: profile.model, input: texts, encoding_format: 'float' }), signal: combined, redirect: 'manual' });
        if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); refuse('EMBEDDING_REDIRECT', 'Embedding redirects are refused.'); }
        if (!response.ok) { await response.body?.cancel(); refuse('EMBEDDING_HTTP', `Embedding request returned HTTP ${response.status}.`, [], response.status === 429 || response.status >= 500); }
        if (Number(response.headers.get('content-length')) > cap) { await response.body?.cancel(); refuse('EMBEDDING_RESPONSE_LIMIT', 'Embedding response exceeds 16 MiB.'); }
        const reader = response.body?.getReader();
        if (!reader) refuse('EMBEDDING_RESPONSE_INVALID', 'Embedding response has no body.');
        const pieces = []; let size = 0;
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > cap) { await reader.cancel(); refuse('EMBEDDING_RESPONSE_LIMIT', 'Embedding response exceeds 16 MiB.'); }
          pieces.push(Buffer.from(value));
        }
        let body;
        try { body = JSON.parse(Buffer.concat(pieces).toString('utf8')); }
        catch { refuse('EMBEDDING_RESPONSE_INVALID', 'Embedding response is not valid JSON.'); }
        const responseModel = body.model === undefined ? null : body.model;
        if (responseModel !== null && (typeof responseModel !== 'string' || !responseModel.length || responseModel.length > 200 || /[\r\n\0]/.test(responseModel))) refuse('EMBEDDING_RESPONSE_INVALID', 'Embedding response identity is invalid.');
        if (!probe && responseModel !== profile.responseModel) refuse('EMBEDDING_STALE_MODEL', 'Embedding response identity differs from the pinned configuration.');
        const vectors = responseVectors(body, texts.length, profile.dimension);
        if (!isCurrent()) refuse('EMBEDDING_CONFIG_CHANGED', 'Embedding configuration changed during inference; results were discarded.', [], true);
        return { vectors, model: profile.model, responseModel, dimension: profile.dimension };
      } catch (error) {
        if (typeof error.code === 'string' && error.code.startsWith('EMBEDDING_')) throw error;
        if (combined.aborted) refuse('EMBEDDING_TIMEOUT', 'Embedding request exceeded its deadline.', [], true);
        refuse('EMBEDDING_UNAVAILABLE', 'Embedding request could not reach the configured service.', [], true);
      } finally { active = false; }
    },
  };
}

export function createHostAdapter(service, identity) {
  if (!identity || typeof identity.profileId !== 'string' || !Number.isInteger(identity.dimension) || identity.dimension < 1 || identity.dimension > 8192 || !Number.isInteger(identity.maxBatch) || identity.maxBatch < 1 || typeof service.embed !== 'function') refuse('EMBEDDING_CONFIG', 'Host embedding identity is unavailable.');
  const profile = normalizeEmbeddings({ baseUrl: 'http://host.invalid/v1', model: identity.model, responseModel: identity.responseModel ?? null, dimension: identity.dimension, maxInputBytes: identity.maxInputBytes });
  const description = { provider: 'host', model: profile.model, responseModel: profile.responseModel, dimension: profile.dimension, spaceId: embeddingSpace({ ...profile, baseUrl: identity.profileId }, 'host'), maxBatch: identity.maxBatch, maxInputBytes: profile.maxInputBytes };
  return { describe: () => ({ ...description }), async embed(texts, options) {
    const vectors = [];
    for (let offset = 0; offset < texts.length; offset += identity.maxBatch) {
      const batch = texts.slice(offset, offset + identity.maxBatch);
      for (const text of batch) { validText(text); if (Buffer.byteLength(text) > profile.maxInputBytes) refuse('EMBEDDING_INPUT_LIMIT', 'Embedding input exceeds the host byte bound.'); }
      const result = await service.embed(batch, options);
      if (result.model !== description.model || (result.responseModel ?? null) !== description.responseModel || result.dimension !== description.dimension) refuse('EMBEDDING_STALE_MODEL', 'Host embedding identity changed.');
      vectors.push(...responseVectors({ data: result.vectors.map((embedding, index) => ({ index, embedding })) }, batch.length, description.dimension));
    }
    return { vectors, model: description.model, responseModel: description.responseModel, dimension: description.dimension };
  } };
}
