import { randomUUID } from 'node:crypto';
import { openIndex, probeFts5, unavailableFts5Coverage } from './index.mjs';
import { vectorState, openVectorSnapshot, markVectorFailure } from './vector-store.mjs';
import { readConfig } from './config.mjs';
import { configuredAdapter } from './embedding-adapter.mjs';
import { embeddingInput, embeddingSpace } from './embedding-config.mjs';
import { defaultSearchMode, readCoverage } from './embedding-off.mjs';
import { embeddingReason, semanticCoverage } from './candidates.mjs';
import { normalizedTerms, significantTerms, lexicalSignal, semanticSignal, combinedSeparation, rankOrder } from './separation.mjs';
import { cosine } from './vector-math.mjs';
import { evidenceFor, scanBudget } from './retrieval-evidence.mjs';
import { validText, portableName, refuse, revision } from './paths.mjs';
import { withIndexWriter } from './index-lock.mjs';

export function lexicalArm(vault, directory, input, terms, significant, cap, memory = scanBudget('LEXICAL_SCAN_LIMIT')) {
  const db = openIndex(directory, vault); const rows = []; const diagnostic = []; let candidates = 0; let fallback = false;
  if (!db) return { rows, signal: null, candidates, fallback, available: false };
  try {
    db.exec('BEGIN');
    const score = match => {
      for (const row of db.prepare(`SELECT c.*,n.revision,c.id AS ordinal,bm25(chunks_fts) AS cost
        FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid JOIN notes n ON n.path=c.path JOIN blocks b ON b.id=c.block
        WHERE chunks_fts MATCH ? AND b.kind!='heading' AND (? IS NULL OR c.path!=?)
        AND (? IS NULL OR EXISTS(SELECT 1 FROM note_workspaces w WHERE w.path=c.path AND w.workspace=?))`).iterate(match, input.sourcePath ?? null, input.sourcePath ?? null, input.workspace ?? null, input.workspace ?? null)) {
        candidates++; const value = { ...row, score: -row.cost };
        memory.retain(rows, value, cap); memory.retain(diagnostic, value, 50);
      }
    };
    score(terms.map(term => `"${term}"`).join(' AND '));
    if (!candidates && significant.length) { fallback = true; score(significant.slice(0, 8).map(term => `"${term}"`).join(' OR ')); }
    return { rows, signal: lexicalSignal(diagnostic, significant, fallback), candidates, fallback, available: true };
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
}

export function semanticArm(vault, directory, profile, queryVector, input, cap, { now = () => performance.now(), deadline = now() + 25000, memory = scanBudget('SEMANTIC_SCAN_LIMIT') } = {}) {
  const reader = openVectorSnapshot(vault, directory, profile); const rows = []; const diagnostic = []; let candidates = 0; let examined = 0;
  try {
    for (const chunk of reader.chunks({ sourcePath: input.sourcePath, workspace: input.workspace })) {
      if (++examined % 32 === 1 && now() >= deadline) refuse('SEMANTIC_SCAN_TIMEOUT', 'The exhaustive semantic scan exceeded 25 seconds.', [], true);
      if (!chunk.eligible) continue; const metadata = reader.metadata(chunk); if (!metadata) continue;
      const row = { ...chunk, score: cosine(queryVector, reader.vector(metadata)) }; candidates++;
      memory.retain(rows, row, cap); memory.retain(diagnostic, row, 50);
    }
    if (now() >= deadline) refuse('SEMANTIC_SCAN_TIMEOUT', 'The exhaustive semantic scan exceeded 25 seconds.', [], true);
    return { rows, signal: semanticSignal(diagnostic.map(row => row.score)), candidates, available: true };
  } finally { reader.close(); }
}

export function fuseArms(semantic, lexical, mode = 'hybrid') {
  if (mode === 'lexical' || !semantic?.available) return lexical?.rows ?? [];
  if (mode === 'semantic' || !lexical?.available) return semantic.rows;
  const fused = new Map();
  for (const [arm, weight] of [[semantic, 0.7], [lexical, 0.3]]) arm.rows.forEach((row, index) => {
    const previous = fused.get(row.id);
    if (previous && (previous.revision !== row.revision || previous.path !== row.path || previous.passage !== row.passage)) return;
    if (!previous) fused.set(row.id, { ...row, score: 0 });
    fused.get(row.id).score += weight / (60 + index + 1);
  });
  return [...fused.values()].sort(rankOrder);
}

function recordServed(vault, directory, callId, hits, stalePaths) {
  withIndexWriter(vault, directory, () => {
    const db = openIndex(directory, vault, true);
    try {
      db.exec('BEGIN IMMEDIATE'); const insert = db.prepare('INSERT INTO served(call_id,at,path,revision,source,passage,passage_hash) VALUES (?,?,?,?,?,?,?)');
      for (const hit of hits) insert.run(callId, new Date().toISOString(), hit.path, hit.revision, JSON.stringify(hit.source), hit.passage, revision(hit.passage));
      if (stalePaths.length) db.prepare("INSERT OR REPLACE INTO meta VALUES ('refreshRequired',?)").run(JSON.stringify(stalePaths));
      db.exec('DELETE FROM served WHERE id NOT IN (SELECT id FROM served ORDER BY id DESC LIMIT 1000); COMMIT;');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    finally { db.close(); }
  });
}

export async function searchHybrid(vault, directory, input, { now = () => performance.now(), beforeServe = () => {}, beforeInference = () => {} } = {}) {
  const started = now(); const limit = input.limit ?? 10; const callId = randomUUID();
  validText(input.query, 'Query');
  if (input.query.length > 4000 || !Number.isInteger(limit) || limit < 1 || limit > 20 || input.workspace !== undefined && (typeof input.workspace !== 'string' || !input.workspace.length || input.workspace.length > 255)) refuse('INVALID_INPUT', 'Search query, limit or workspace is outside its bounds.');
  if (input.sourcePath !== undefined) { validText(input.sourcePath, 'Source path'); input.sourcePath.split('/').forEach(portableName); }
  const allTerms = normalizedTerms(input.query); const terms = allTerms.slice(0, 32); const significant = significantTerms(terms);
  if (!terms.length) refuse('INVALID_INPUT', 'Search query must include a word or number.');
  let embedding = vectorState(vault, directory); const mode = input.mode ?? defaultSearchMode(embedding);
  if (!['lexical', 'hybrid', 'semantic'].includes(mode)) refuse('INVALID_INPUT', 'Search mode must be hybrid, lexical or semantic.');
  const fts5 = probeFts5(); let coverage = fts5 ? readCoverage(vault, directory) : unavailableFts5Coverage();
  const cap = Math.min(1000, limit * 8); let lexical = null; let semantic = null; let reason = null; let queryMs = 0; let scanMs = 0;
  const memory = scanBudget('SEARCH_SCAN_LIMIT');
  if (mode !== 'semantic' && fts5) lexical = lexicalArm(vault, directory, input, terms, significant, cap, memory);
  const lexicalEnded = now();
  if (mode !== 'lexical') {
    reason = embeddingReason(embedding.state);
    if (!reason) {
      const profile = readConfig(directory).embeddings;
      try {
        const query = embeddingInput(profile, input.query, 'query'); const queryStarted = now(); beforeInference(); const adapter = configuredAdapter(vault, directory, { profile });
        if (adapter.describe().spaceId !== embeddingSpace(profile)) refuse('EMBEDDING_STALE_MODEL', 'The query adapter differs from the frozen scan space.');
        const response = await adapter.embed([query]); queryMs = now() - queryStarted;
        if (response.model !== profile.model || response.responseModel !== profile.responseModel || response.dimension !== profile.dimension || adapter.describe().spaceId !== embeddingSpace(profile)) refuse('EMBEDDING_STALE_MODEL', 'The query response differs from the frozen scan space.');
        const scanStarted = now(); semantic = semanticArm(vault, directory, profile, response.vectors[0], input, cap, { now, memory }); scanMs = now() - scanStarted;
      } catch (error) {
        if (error.code?.endsWith('_SCAN_LIMIT')) throw error;
        reason = error.code === 'EMBEDDING_STALE_MODEL' ? 'stale_model' : 'embedding_unavailable';
        if (error.code === 'EMBEDDING_STALE_MODEL' || /^EMBEDDING_(?:HTTP|TIMEOUT|UNAVAILABLE|RESPONSE_)/.test(error.code ?? '')) markVectorFailure(vault, directory, profile, error.code, error.retryable);
        embedding = vectorState(vault, directory);
        if (embedding.state === 'stale-model') reason = 'stale_model';
        if (['VECTOR_PACK_INVALID', 'VECTOR_INVALID'].includes(error.code)) embedding.state = 'unavailable';
      }
    }
  }
  const fuseStarted = now(); const ranked = mode === 'semantic' && !semantic ? [] : fuseArms(semantic, lexical, mode); const fusionMs = now() - fuseStarted;
  const separation = combinedSeparation(semantic?.signal ?? null, lexical?.signal ?? null); const hits = []; const stale = new Set(); const seen = new Set();
  beforeServe(); const verifyStarted = now();
  for (const row of ranked) {
    if (seen.has(row.path)) continue;
    seen.add(row.path);
    try { const evidence = evidenceFor(vault, row); const score = row.cost !== undefined && !(mode === 'hybrid' && semantic?.available && lexical?.available) ? row.cost : row.score; hits.push({ ...evidence, score, evidence: 'vault text; unverified', memory: vault.role === 'own' ? 'unverified memory' : null }); }
    catch { stale.add(row.path); continue; }
    if (hits.length === limit) break;
  }
  if (fts5 && (lexical?.available || semantic?.available)) recordServed(vault, directory, callId, hits, [...stale]);
  if (stale.size) coverage = { ...coverage, state: coverage.state === 'unknown' ? 'unknown' : 'incomplete', message: coverage.state === 'unknown' ? coverage.message : 'Selected evidence changed after the snapshot; refresh before relying on absence.' };
  if (mode !== 'lexical') coverage = semanticCoverage(coverage, reason ?? (embedding.missing || embedding.skipped ? 'incomplete' : null));
  return { ok: true, tool: 'search', vault: vault.id, callId, query: input.query, terms, termsTruncated: allTerms.length > terms.length, excludedSource: input.sourcePath ?? null, mode, reason, hits, stalePaths: [...stale], refreshRequired: stale.size > 0, candidateLimitReached: (lexical?.candidates ?? 0) > cap || (semantic?.candidates ?? 0) > cap, embedding, separation, coverage, fts5, nodeVersion: process.version, timings: { lexicalMs: lexicalEnded - started, queryMs, scanMs, fusionMs, verifyMs: now() - verifyStarted, totalMs: now() - started }, durationMs: Math.round((now() - started) * 100) / 100 };
}
