import { revision, refuse, validText } from './paths.mjs';
import path from 'node:path';

export const preprocessingVersion = '1';
export const embeddingCanary = 'Notient embedding setup canary.';
const keys = ['baseUrl', 'model', 'responseModel', 'dimension', 'apiKey', 'apiKeySocket', 'batch', 'timeoutMs', 'maxInputBytes', 'documentPrefix', 'queryPrefix', 'spaceVersion'];

export function normalizeEmbeddings(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) refuse('EMBEDDING_CONFIG', 'Embedding configuration has unsupported fields.');
  const result = { batch: 32, timeoutMs: 15000, documentPrefix: '', queryPrefix: '', spaceVersion: '1', apiKey: null, responseModel: null, ...value };
  for (const [key, minimum, maximum] of [['dimension', 1, 8192], ['batch', 1, 32], ['timeoutMs', 1000, 60000], ['maxInputBytes', 64, 32768]]) if (!Number.isInteger(result[key]) || result[key] < minimum || result[key] > maximum) refuse('EMBEDDING_CONFIG', `Embedding ${key} is outside its bounds.`);
  for (const [key, minimum, maximum] of [['model', 1, 200], ['spaceVersion', 1, 200], ['documentPrefix', 0, 512], ['queryPrefix', 0, 512]]) if (typeof result[key] !== 'string' || result[key].length < minimum || result[key].length > maximum || result[key].includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(result[key])) refuse('EMBEDDING_CONFIG', `Embedding ${key} is invalid.`);
  if (result.apiKey !== null && (typeof result.apiKey !== 'string' || !result.apiKey.length || result.apiKey.length > 8192 || /[\r\n\0]/.test(result.apiKey)) || result.responseModel !== null && (typeof result.responseModel !== 'string' || !result.responseModel.length || result.responseModel.length > 200 || /[\r\n\0]/.test(result.responseModel))) refuse('EMBEDDING_CONFIG', 'Embedding credential or pinned identity is invalid.');
  if (result.apiKeySocket !== undefined && (typeof result.apiKeySocket !== 'string' || !path.isAbsolute(result.apiKeySocket) || Buffer.byteLength(result.apiKeySocket) > 100 || /[\r\n\0]/.test(result.apiKeySocket))) refuse('EMBEDDING_CONFIG', 'Embedding credential socket path is invalid.');
  let url;
  try { if (typeof result.baseUrl !== 'string') throw new Error(); url = new URL(result.baseUrl); }
  catch { refuse('EMBEDDING_CONFIG', 'Embedding base URL must be an absolute HTTP or HTTPS destination.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[?#]/.test(url.href)) refuse('EMBEDDING_CONFIG', 'Embedding destination cannot contain credentials, query or fragment.');
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/v1') ? pathname : `${pathname}/v1`;
  result.baseUrl = url.toString().replace(/\/$/, '');
  return result;
}

export function embeddingSpace(profile, provider = 'openai-compatible') {
  return revision(JSON.stringify([provider, profile.baseUrl, profile.model, profile.responseModel, profile.dimension, profile.documentPrefix, profile.queryPrefix, profile.maxInputBytes, profile.spaceVersion, preprocessingVersion]));
}

export function embeddingInput(profile, text, kind = 'document') {
  validText(text, 'Embedding input');
  const input = (kind === 'query' ? profile.queryPrefix : profile.documentPrefix) + text;
  if (Buffer.byteLength(input) > profile.maxInputBytes) refuse('EMBEDDING_INPUT_LIMIT', 'Embedding input exceeds the configured byte bound.');
  return input;
}

export function configuredEmbedding(config, vault) {
  if (!vault.embeddings || !config.embeddings) return { state: 'off', spaceId: null, model: null, responseModel: null, dimension: null, eligible: 0, embedded: 0, missing: 0, skipped: 0 };
  const profile = config.embeddings;
  return { state: 'building', spaceId: embeddingSpace(profile), model: profile.model, responseModel: profile.responseModel, dimension: profile.dimension, eligible: 0, embedded: 0, missing: 0, skipped: 0 };
}
