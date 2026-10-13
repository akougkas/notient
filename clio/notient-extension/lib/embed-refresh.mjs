import { readConfig } from './config.mjs';
import { configuredAdapter } from './embedding-adapter.mjs';
import { embeddingSpace } from './embedding-config.mjs';
import { refreshIndex, openIndex } from './index.mjs';
import { readCoverage } from './embedding-off.mjs';
import { withIndexWriter } from './index-lock.mjs';
import { vectorState, vectorChunks, publishVectors, markVectorFailure, openVectorSnapshot, beginGenerationBuild, writeGenerationBatch, finishGenerationBuild, closeGenerationBuild } from './vector-store.mjs';
import { readNote, refuse } from './paths.mjs';

export function reclaimExpired(vault, directory, at = Date.now()) {
  withIndexWriter(vault, directory, () => {
    const db = openIndex(directory, vault, true);
    try { db.prepare('DELETE FROM candidate_sets WHERE expires_at<=?').run(new Date(at).toISOString()); }
    finally { db.close(); }
  });
}

function missingBatch(vault, directory, profile) {
  let reader;
  try { reader = openVectorSnapshot(vault, directory, profile, { allowBuilding: true }); }
  catch (error) { if (!['VECTOR_PACK_INVALID', 'VECTOR_PACK_UNAVAILABLE', 'ENOENT'].includes(error.code)) throw error; }
  const db = reader?.db ?? openIndex(directory, vault); const batch = [];
  try {
    if (!reader) db.exec('BEGIN');
    const files = new Map();
    for (const chunk of vectorChunks(db, profile)) {
      if (!chunk.eligible) continue;
      try { const row = reader?.metadata(chunk); if (row) { reader.vector(row); continue; } }
      catch (error) { if (!['VECTOR_INVALID', 'VECTOR_PACK_INVALID'].includes(error.code)) throw error; }
      if (!files.has(chunk.path)) files.set(chunk.path, readNote(vault.path, chunk.path).revision);
      if (files.get(chunk.path) !== chunk.revision) refuse('STRUCTURAL_REFRESH_REQUIRED', 'A note changed before inference; refresh the structural snapshot first.', [chunk.path], true);
      batch.push(chunk); if (batch.length === profile.batch) break;
    }
    return batch;
  } finally { if (reader) reader.close(); else { if (db?.isTransaction) db.exec('ROLLBACK'); db?.close(); } }
}

export async function refreshVectors(vault, directory, input = {}, { now = () => performance.now(), adapter: supplied, barrier, sync, maxBufferBytes } = {}) {
  const started = now(); const tier = input.tier ?? 'structural'; const budgetMs = input.budgetMs ?? 240000;
  if (!['structural', 'embed'].includes(tier) || !Number.isInteger(budgetMs) || budgetMs < 1000 || budgetMs > 240000) refuse('INVALID_INPUT', 'Refresh requires structural or embed and a budget from 1000 to 240000 ms.');
  let result = { vault: vault.id, scanned: 0, changed: 0, unchanged: 0, deleted: 0, hashed: 0, skipped: [], skippedCount: 0, errors: [], errorCount: 0, completedAt: null };
  let state = vectorState(vault, directory); let reason = null; let embeddedThisCall = 0; let failedBatches = 0; const warnings = []; const batchMs = []; let generation = null; let forcePending = null;
  if (tier === 'structural') { result = refreshIndex(vault, directory, input); reclaimExpired(vault, directory); state = vectorState(vault, directory); if (result.remaining) reason = 'budget_exhausted'; }
  else if (state.state === 'off') reason = 'embedding_off';
  else if (readCoverage(vault, directory).state !== 'current') reason = 'structural_refresh_required';
  else if (state.state === 'stale-model' && staleProfile(vault, directory, state.spaceId)) reason = 'stale_model';
  else {
    const profile = readConfig(directory).embeddings; const adapter = supplied ?? configuredAdapter(vault, directory); const deadline = started + budgetMs;
    reclaimExpired(vault, directory);
    if (input.force) {
      let build;
      try {
        build = beginGenerationBuild(vault, directory, profile, { deadline, now, maxBufferBytes });
        const missing = build.items.filter(item => item.scale === null);
        forcePending = missing.length;
        for (let offset = 0; offset < missing.length; offset += profile.batch) {
          if (now() >= deadline) { reason = 'budget_exhausted'; break; }
          const batch = missing.slice(offset, offset + profile.batch); const batchStarted = now();
          for (const item of batch) if (readNote(vault.path, item.chunk.path).revision !== item.chunk.revision) refuse('EMBEDDING_CORPUS_CHANGED', 'A note changed before generation inference; refresh and retry.', [item.chunk.path], true);
          const response = await adapter.embed(batch.map(item => item.chunk.input), { signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadline - now()))) });
          if (response.model !== profile.model || response.responseModel !== profile.responseModel || response.dimension !== profile.dimension || adapter.describe().spaceId !== embeddingSpace(profile)) refuse('EMBEDDING_STALE_MODEL', 'The inference identity differs from the frozen vector space.');
          if (now() >= deadline) { reason = 'budget_exhausted'; break; }
          writeGenerationBatch(build, batch, response.vectors); batchMs.push(now() - batchStarted);
        }
        if (!reason) { generation = finishGenerationBuild(vault, directory, profile, build, { barrier, sync, deadline, now }); warnings.push(...generation.warnings); embeddedThisCall = missing.length; }
      } catch (error) {
        if (error.code === 'VECTOR_REBUILD_TIMEOUT') reason = 'budget_exhausted';
        else if (error.code === 'EMBEDDING_CONFIG_CHANGED') reason = 'config_changed';
        else if (error.code === 'EMBEDDING_CORPUS_CHANGED') reason = 'structural_refresh_required';
        else if (/^EMBEDDING_/.test(error.code ?? '')) { failedBatches++; markVectorFailure(vault, directory, profile, error.code, error.retryable); result.errors.push({ code: error.code, message: error.message, retryable: Boolean(error.retryable) }); result.errorCount = result.errors.length; reason = error.code === 'EMBEDDING_STALE_MODEL' ? 'stale_model' : 'embedding_unavailable'; }
        else throw error;
      } finally { closeGenerationBuild(build); }
    } else for (;;) {
      if (now() >= deadline) { reason = 'budget_exhausted'; break; }
      const batch = missingBatch(vault, directory, profile);
      if (!batch.length) { const published = publishVectors(vault, directory, profile, [], [], { sync }); warnings.push(...published.warnings); break; }
      const batchStarted = now();
      try {
        const response = await adapter.embed(batch.map(chunk => chunk.input), { signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadline - now()))) });
        if (response.model !== profile.model || response.responseModel !== profile.responseModel || response.dimension !== profile.dimension || adapter.describe().spaceId !== embeddingSpace(profile)) refuse('EMBEDDING_STALE_MODEL', 'The inference identity differs from the frozen vector space.');
        if (now() >= deadline) { reason = 'budget_exhausted'; break; }
        const published = publishVectors(vault, directory, profile, batch, response.vectors, { sync }); embeddedThisCall += published.published; warnings.push(...published.warnings);
        batchMs.push(now() - batchStarted);
        if (published.discarded) { reason = 'structural_refresh_required'; break; }
      } catch (error) {
        if (error.code === 'EMBEDDING_CONFIG_CHANGED') { reason = 'config_changed'; break; }
        if (!/^EMBEDDING_/.test(error.code ?? '')) throw error;
        failedBatches++; markVectorFailure(vault, directory, profile, error.code, error.retryable);
        result.errors.push({ code: error.code, message: error.message, retryable: Boolean(error.retryable) }); result.errorCount = result.errors.length;
        reason = error.code === 'EMBEDDING_STALE_MODEL' ? 'stale_model' : 'embedding_unavailable'; break;
      }
    }
    state = vectorState(vault, directory);
    result.completedAt = new Date().toISOString();
  }
  return { ...result, ok: true, tool: 'refresh', tier, budgetMs, reason, embedding: { ...state, embeddedThisCall, failedBatches, remaining: !generation && forcePending !== null ? forcePending : state.missing }, generation, warnings, timings: { batchMs, totalMs: now() - started }, durationMs: Math.round((now() - started) * 100) / 100 };
}

function staleProfile(vault, directory, id) {
  const db = openIndex(directory, vault);
  try { return db?.prepare('SELECT state FROM vector_spaces WHERE space_id=?').get(id)?.state === 'stale-model'; }
  finally { db?.close(); }
}
