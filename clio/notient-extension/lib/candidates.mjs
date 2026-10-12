import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readConfig } from './config.mjs';
import { openIndex } from './index.mjs';
import { vectorState, openVectorSnapshot, metaValue } from './vector-store.mjs';
import { readCoverage, undeterminedSeparation } from './embedding-off.mjs';
import { readNote, refuse, portableName, validText, revision } from './paths.mjs';
import { cosine } from './vector-math.mjs';
import { evidenceFor, inventoryHash, scanBudget } from './retrieval-evidence.mjs';
import { semanticSignal, combinedSeparation } from './separation.mjs';
import { withIndexWriter } from './index-lock.mjs';

export const embeddingReason = state => ({ off: 'embedding_off', building: 'embedding_building', 'stale-model': 'stale_model', unavailable: 'embedding_unavailable' })[state] ?? null;
export const semanticCoverage = (coverage, reason) => !reason || coverage.state === 'unknown' ? coverage : { ...coverage, state: 'incomplete', message: 'Semantic coverage is incomplete; empty results do not establish semantic absence.' };

function exclusions(db, source) {
  const names = new Set([source]);
  for (const row of db.prepare("SELECT path,target_path,payload FROM links WHERE resolution='resolved' AND (path=? OR target_path=?)").iterate(source, source)) {
    const link = JSON.parse(row.payload); if (link.kind !== 'wiki' || link.embed) continue;
    names.add(row.path === source ? row.target_path : row.path);
  }
  return names;
}

export function findCandidates(vault, directory, input, { now = () => performance.now(), wall = () => Date.now(), beforeReceipt = () => {} } = {}) {
  const started = now(); const deadline = started + 25000; const limit = input.limit ?? 8;
  if (typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision) || !Number.isInteger(limit) || limit < 1 || limit > 12) refuse('INVALID_INPUT', 'Candidates requires a raw SHA-256 revision and a limit from 1 to 12.');
  validText(input.source, 'Source'); input.source.split('/').forEach(portableName);
  const source = readNote(vault.path, input.source);
  if (source.revision !== input.revision) refuse('REVISION_CONFLICT', 'The source changed since its supplied raw revision.', [input.source], true);
  const state = vectorState(vault, directory); const coverage = readCoverage(vault, directory);
  const empty = reason => ({ ok: true, tool: 'candidates', vault: vault.id, source: input.source, revision: source.revision, candidateSet: null, expiresAt: null, candidates: [], reason, embedding: state, coverage: semanticCoverage(coverage, reason === 'no_candidates' ? state.missing || state.skipped ? 'incomplete' : null : reason), separation: undeterminedSeparation(), timings: { scanMs: 0, verifyMs: now() - started, totalMs: now() - started } });
  const unavailable = embeddingReason(state.state); if (unavailable) return empty(unavailable);
  const profile = readConfig(directory).embeddings; let reader;
  let scanned = 0; const best = []; let indexGeneration; let scanEnded;
  const memory = scanBudget('CANDIDATE_LIMIT');
  try {
    reader = openVectorSnapshot(vault, directory, profile);
    const sourceChunks = [];
    for (const chunk of reader.chunks({ path: input.source })) {
      if (!chunk.eligible) return empty('source_vectors_missing');
      if (chunk.revision !== source.revision) refuse('REVISION_CONFLICT', 'The indexed source revision changed; refresh first.', [input.source], true);
      const metadata = reader.metadata(chunk); if (!metadata) return empty('source_vectors_missing');
      sourceChunks.push({ chunk, vector: reader.vector(metadata) });
      memory.add(sourceChunks.at(-1));
      if (sourceChunks.length > 64) refuse('CANDIDATE_LIMIT', 'Candidates requires at most 64 source chunks; split this note before retrying.', [input.source]);
    }
    if (!sourceChunks.length) return empty('source_vectors_missing');
    const excluded = exclusions(reader.db, input.source);
    let current = null;
    const finish = () => { if (current) memory.retain(best, current, 50); };
    for (const chunk of reader.chunks({ sourcePath: input.source })) {
      if (++scanned % 32 === 1 && now() >= deadline) refuse('CANDIDATE_TIMEOUT', 'The exhaustive candidate scan exceeded 25 seconds; no receipt was created.', [], true);
      if (!chunk.eligible || excluded.has(chunk.path)) continue;
      const metadata = reader.metadata(chunk); if (!metadata) continue;
      const targetVector = reader.vector(metadata);
      for (const sourceChunk of sourceChunks) {
        const score = cosine(sourceChunk.vector, targetVector);
        if (current?.path !== chunk.path) { finish(); current = { path: chunk.path, ordinal: chunk.ordinal, score, sourceChunk: sourceChunk.chunk, targetChunk: chunk }; }
        else if (score > current.score) current = { path: chunk.path, ordinal: chunk.ordinal, score, sourceChunk: sourceChunk.chunk, targetChunk: chunk };
      }
    }
    finish(); scanEnded = now(); if (scanEnded >= deadline) refuse('CANDIDATE_TIMEOUT', 'The exhaustive candidate scan exceeded 25 seconds; no receipt was created.', [], true);
    indexGeneration = Number(metaValue(reader.db, 'indexGeneration') ?? 0);
  } catch (error) {
    if (['VECTOR_PACK_INVALID', 'VECTOR_PACK_UNAVAILABLE', 'VECTOR_INVALID'].includes(error.code)) { state.state = 'unavailable'; return empty('embedding_unavailable'); }
    throw error;
  } finally { reader?.close(); }
  if (!best.length) return { ...empty('no_candidates'), timings: { scanMs: scanEnded - started, verifyMs: 0, totalMs: now() - started } };
  const files = new Map(); const candidates = best.slice(0, limit).map(row => ({ path: row.path, revision: row.targetChunk.revision, title: JSON.parse(row.targetChunk.outline)[0]?.title ?? path.basename(row.path, '.md'), bestDistance: Math.max(0, Math.min(2, 1 - row.score)), sourceEvidence: evidenceFor(vault, row.sourceChunk, files), targetEvidence: evidenceFor(vault, row.targetChunk, files) }));
  const separation = combinedSeparation(semanticSignal(best.map(row => row.score)));
  const id = randomUUID(); const stamp = wall(); const createdAt = new Date(stamp).toISOString(); const expiresAt = new Date(stamp + 86400000).toISOString(); const inventory = inventoryHash(vault.path);
  beforeReceipt();
  withIndexWriter(vault, directory, () => {
    if (now() >= deadline) refuse('CANDIDATE_TIMEOUT', 'Candidate verification exceeded 25 seconds; no receipt was created.', [], true);
    const currentState = vectorState(vault, directory);
    if (currentState.spaceId !== state.spaceId || !['ready', 'incomplete'].includes(currentState.state) || inventoryHash(vault.path) !== inventory) refuse('CANDIDATE_STALE', 'The vector space or vault inventory changed during candidate verification.', [], true);
    for (const item of [source, ...candidates]) if (readNote(vault.path, item.path ?? input.source).revision !== item.revision) refuse(item === source ? 'REVISION_CONFLICT' : 'TARGET_CHANGED', 'Evidence changed before receipt publication.', [item.path ?? input.source], true);
    const db = openIndex(directory, vault, true);
    try {
      db.exec('BEGIN IMMEDIATE');
      if (db.prepare('SELECT count(*) AS n FROM candidate_sets WHERE expires_at>?').get(createdAt).n >= 10000) refuse('CANDIDATE_CAPACITY', 'This vault has 10000 live candidate receipts; retry after expiry and an explicit refresh.', [], true);
      const payload = { version: 1, vault: vault.id, source: input.source, sourceRevision: source.revision, spaceId: state.spaceId, indexGeneration, inventoryHash: inventory, createdAt, expiresAt, targets: candidates, textHashes: candidates.map(item => ({ path: item.path, source: revision(item.sourceEvidence.passage), target: revision(item.targetEvidence.passage) })) };
      db.prepare('INSERT INTO candidate_sets VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, vault.id, input.source, source.revision, state.spaceId, indexGeneration, inventory, JSON.stringify(payload), createdAt, expiresAt); db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    finally { db.close(); }
  });
  return { ok: true, tool: 'candidates', vault: vault.id, source: input.source, revision: source.revision, candidateSet: id, expiresAt, candidates, reason: null, embedding: state, coverage: semanticCoverage(coverage, state.missing || state.skipped ? 'incomplete' : null), separation, timings: { scanMs: scanEnded - started, verifyMs: now() - scanEnded, totalMs: now() - started } };
}
