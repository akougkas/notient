import { readdirSync, lstatSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { indexPath } from './config.mjs';
import { openIndex, searchIndex, refreshIndex } from './index.mjs';
import { structuralCoverage, unknownVitalsCoverage } from './vitals-read.mjs';
import { readNote, refuse, portableName, validText } from './paths.mjs';

export const offEmbedding = () => ({ state: 'off', spaceId: null, model: null, responseModel: null, dimension: null, eligible: 0, embedded: 0, missing: 0, skipped: 0 });
export const undeterminedSeparation = () => ({ state: 'undetermined', semantic: null, lexical: null });
export const defaultSearchMode = embedding => ['ready', 'incomplete'].includes(embedding.state) ? 'hybrid' : 'lexical';

export function readCoverage(vault, directory) {
  let db;
  try {
    db = openIndex(directory, vault);
    if (!db || db.prepare('PRAGMA user_version').get().user_version !== 2) return unknownVitalsCoverage();
    db.exec('BEGIN');
    return structuralCoverage(db, vault);
  } catch { return { ...unknownVitalsCoverage(), indexing: { state: 'unavailable', reason: 'structural_index_unavailable' } }; }
  finally { if (db?.isTransaction) db.exec('ROLLBACK'); db?.close(); }
}

function semanticCoverage(coverage) {
  return coverage.state === 'unknown' ? coverage : { ...coverage, state: 'incomplete', message: 'Semantic coverage is unavailable while embeddings are off; empty results do not establish semantic absence.' };
}

export function candidatesOff(vault, directory, input) {
  const started = performance.now();
  if (typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision) || !Number.isInteger(input.limit ?? 8) || (input.limit ?? 8) < 1 || (input.limit ?? 8) > 12) refuse('INVALID_INPUT', 'Candidates requires a raw SHA-256 revision and a limit from 1 to 12.');
  validText(input.source, 'Source'); input.source.split('/').forEach(portableName);
  let source;
  try { source = readNote(vault.path, input.source); }
  catch (error) { if (error.code === 'ENOENT') refuse('NOTE_NOT_FOUND', 'The requested source note does not exist.', [input.source]); throw error; }
  if (source.revision !== input.revision) refuse('REVISION_CONFLICT', 'The source changed since its supplied raw revision.', [input.source], true);
  const verified = performance.now();
  const coverage = semanticCoverage(readCoverage(vault, directory));
  return { ok: true, tool: 'candidates', vault: vault.id, source: input.source, revision: source.revision, candidateSet: null, expiresAt: null, candidates: [], reason: 'embedding_off', embedding: offEmbedding(), coverage, separation: undeterminedSeparation(), timings: { scanMs: 0, verifyMs: verified - started, totalMs: performance.now() - started } };
}

export function searchWithEmbeddingOff(vault, directory, input) {
  const started = performance.now();
  const mode = input.mode ?? defaultSearchMode(offEmbedding());
  if (!['hybrid', 'lexical', 'semantic'].includes(mode)) refuse('INVALID_INPUT', 'Search mode must be hybrid, lexical or semantic.');
  validText(input.query, 'Query');
  const coverage = readCoverage(vault, directory);
  let result;
  if (mode === 'semantic' || mode === 'hybrid' && !existsSync(indexPath(directory, vault))) {
    const terms = [...new Set(input.query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
    result = { vault: vault.id, callId: randomUUID(), query: input.query, terms: terms.slice(0, 32), termsTruncated: terms.length > 32, excludedSource: input.sourcePath ?? null, hits: [], stalePaths: [], refreshRequired: false, candidateLimitReached: false };
  } else result = searchIndex(vault, directory, input);
  const actualCoverage = result.coverage ?? (result.refreshRequired ? { ...coverage, state: 'incomplete', message: 'Selected evidence changed after the snapshot; refresh before relying on absence.' } : coverage);
  return { ...result, ok: true, tool: 'search', mode, reason: mode === 'lexical' ? null : 'embedding_off', embedding: offEmbedding(), separation: undeterminedSeparation(), coverage: mode === 'lexical' ? actualCoverage : semanticCoverage(actualCoverage), durationMs: Math.round((performance.now() - started) * 100) / 100 };
}

export function refreshWithEmbeddingOff(vault, directory, input) {
  const tier = input.tier ?? 'structural';
  const budgetMs = input.budgetMs ?? 240000;
  if (!['structural', 'embed'].includes(tier) || !Number.isInteger(budgetMs) || budgetMs < 1000 || budgetMs > 240000) refuse('INVALID_INPUT', 'Refresh requires structural or embed and a budget from 1000 to 240000 ms.');
  const result = tier === 'structural' ? refreshIndex(vault, directory, input) : { vault: vault.id, scanned: 0, changed: 0, unchanged: 0, deleted: 0, hashed: 0, skipped: [], skippedCount: 0, errors: [], errorCount: 0, completedAt: null, durationMs: 0 };
  return { ...result, ok: true, tool: 'refresh', tier, budgetMs, reason: tier === 'embed' ? 'embedding_off' : null, embedding: { ...offEmbedding(), embeddedThisCall: 0, failedBatches: 0, remaining: 0 } };
}

export function retainedPackBytes(directory, vault) {
  const root = path.dirname(indexPath(directory, vault));
  if (!existsSync(root)) return 0;
  if (lstatSync(root).isSymbolicLink()) refuse('UNSAFE_STATE', 'The external vector directory cannot be a symbolic link.');
  let bytes = 0;
  for (const name of readdirSync(root).filter(name => /^vectors\.[a-f0-9]{64}\.[0-9]+\.i8$/.test(name))) {
    const stat = lstatSync(path.join(root, name));
    if (stat.isSymbolicLink() || !stat.isFile()) refuse('UNSAFE_STATE', 'Retained vector packs must be ordinary files.');
    bytes += stat.size;
    if (!Number.isSafeInteger(bytes)) refuse('STRUCTURAL_UNAVAILABLE', 'Retained pack bytes exceed the numeric bound.');
  }
  return bytes;
}
